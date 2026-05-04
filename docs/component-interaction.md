# pit2 Org Extension — Component Interaction Design

> Synthesised from component analyses of `coordinator.ts`, `executor.ts`, and `notifier.ts`.
> Date: 2026-05-04

---

## 1. System Overview

The pit2 org extension is a three-component pipeline that turns beads tasks into autonomous agent work and delivers the results back to a human EM (Engineering Manager). The **Coordinator** is the dispatch engine: it polls the beads ready queue, claims labelled tasks, and fires off execution. The **Executor** is the agent substrate: it maintains a pool of persistent `RpcClient` subprocesses keyed by `(cwd, memberName)`, routes each task brief to the right subprocess, and returns a structured result. The **Notifier** is the output sink: it takes that result and writes a completion bead into the EM's inbox, then nudges the EM's session so the result surfaces in the conversation. Together the three components implement a claim–execute–deliver loop that is event-driven on the front edge (task creation triggers a dispatch cycle immediately) and polling-backed on the rear edge (a 30 s safety net catches anything the event missed).

---

## 2. Dispatch Flow

The following trace covers the full lifecycle from task creation to EM receipt.

1. **EM calls `bd_task_create`** with a role label (e.g. `pi-specialist`). The beads store records the task as `open`.

2. **`onTaskCreated(cwd)` fires** — Coordinator enqueues a `_dispatchCycle` immediately. (If the event is missed, the 30 s safety-net poll will trigger the same cycle.)

3. **`_dispatchCycle` runs inside `writeQueue`** (serialised). It calls `bd ready --type=task --json` and receives the list of claimable tasks.

4. **Coordinator filters and gates**:
   - Tasks without a label are skipped (EM-owned per ADR-006).
   - Tasks with `failureCounts >= 3` are skipped; EM is notified.
   - `resolveOrScale(cwd, memberState, role)` is called. If all members of the required role are busy, the task is skipped until the next cycle.

5. **Coordinator claims the task**: `bd update <taskId> --claim` with `BEADS_ACTOR=<memberName>`. On failure (already claimed, bd error), EM is notified and task is skipped. On success, `memberState` is set to `{ status: "working", task: taskId }`.

6. **`_runAndClose` is launched outside `writeQueue`** — execution is parallel; bd writes within it are individually re-enqueued.

7. **Coordinator calls `executor.evict(cwd, memberName)`** to discard any stale client, then calls `executor.execute(brief, role, memberName, cwd, config)`.

8. **Executor resolves or spawns a subprocess**:
   - `_getOrCreateClient` checks `liveMembers` map keyed by `cwd::memberName`.
   - If no entry exists: `_buildMemberSystemPromptFile` writes `.pi/prompts/members/<id>.md`, spawns a new `RpcClient` with `--no-session --no-context-files --append-system-prompt <file>`, starts it, enables auto-compaction, registers a crash listener.
   - If first use: `_initializeClientMemory` primes the subprocess with the role memory file (`.pi/memory/<role>.md`).

9. **Executor sends the task brief** via `client.prompt("Task for <memberName>: <brief>")`. It subscribes `client.onEvent` to accumulate `UsageStats` and reset an `lastActivity` timestamp on each event.

10. **Executor awaits `waitForIdleWithActivityTimeout`**, which polls every 500 ms for subprocess idle, rejecting on crash, 60 s inactivity, or 30 min absolute backstop.

11. **Executor collects output** via `client.getLastAssistantText()`, enqueues the fire-and-forget memory update phase (serialised per role via `memoryPhaseQueue`), reports token usage via `onUsage`, and returns `{ exitCode, output, usage }` to the Coordinator.

12. **Coordinator calls `notifier.notify(cwd, taskId, title, role, memberName, output)`**.

13. **Notifier writes a completion bead** via `bd create` (3-attempt retry) with `type=task`, `assignee=em/`, labels `pit2:message`, `msg-type:task-complete`, `from:<slug>`, description = formatted header + full agent output, metadata JSON with `task_id/role/member_name`.

14. **Notifier calls `scheduleInboxPing(cwd)`** — debounced (10 s), waits for the EM client to be idle, then sends a `sendUserMessage` nudge into the EM's session.

15. **`drainInbox` in `index.ts`** — on the nudge (or next EM turn): calls `bd list --assignee=em/ --labels=pit2:message`, reads descriptions, posts them as user messages into the EM's conversation, closes the inbox beads.

16. **EM receives the result** as a structured message in its conversation context. The dispatch cycle is complete.

17. **Back in the Coordinator**, `bd close <taskId>` is called, `scheduleDoneReset(memberName)` resets the member to idle after 5 min, and any remaining ready tasks in the queue are dispatched.

---

## 3. Component Responsibility Table

| Component | Owns | Does NOT own |
|---|---|---|
| **Coordinator** | Ready-queue polling, task claiming, failure gating (`failureCounts`), dispatch serialisation (`writeQueue`), member state (`memberState`), task open/close writes to beads, auto-hire via `resolveOrScale` | RPC subprocess lifecycle, token usage tracking, memory files, beads inbox format, EM conversation delivery |
| **Executor** | `RpcClient` subprocess pool (`liveMembers`), subprocess creation/eviction/reaping, memory initialisation and update phases (`memoryPhaseQueue`), task execution timing/timeouts, `UsageStats` aggregation | Task claiming, dispatch ordering, failure gating, beads writes (except system prompt file), EM notification |
| **Notifier** | Completion bead format and creation, `em/` inbox delivery, `scheduleInboxPing` debounce, fallback direct `notifyEM()` on bd failure | What the task result *contains*, how it was produced, whether the task succeeded or failed, dispatch or execution state |

---

## 4. Coupling Map

### Coordinator → Executor

```
executor.evict(cwd: string, memberName: string): void
executor.execute(
  brief: string,
  role: string,
  memberName: string,
  cwd: string,
  config: MemberConfig
): Promise<RunResult>   // { exitCode: number, output: string, usage: UsageStats }
```

The Coordinator always calls `evict` before `execute` to ensure no stale client is reused. The Executor is otherwise opaque: the Coordinator never touches `liveMembers`, never calls `client.prompt()` directly, and never sees intermediate tool calls from the subprocess.

### Coordinator → Notifier

```
notifier.notify(
  cwd: string,
  taskId: string,
  title: string,
  role: string,
  memberName: string,
  output: string
): Promise<void>
```

The Coordinator calls `notify` once after a successful `execute()`. It passes the raw `output` string from `RunResult`; the Notifier owns all formatting. The Coordinator does not inspect the notification result — `notify` is fire-and-forget from a dispatch-correctness perspective (failures fall back internally to `notifyEM`).

### Notifier → beads inbox (what `drainInbox` reads)

The Notifier writes beads with:
- `assignee = em/` — scopes to EM inbox
- `labels = pit2:message, msg-type:task-complete, from:<slug>` — `drainInbox` filters on `pit2:message`
- `description` = formatted header + agent output — `drainInbox` reads this field verbatim and injects it as a user message
- `metadata` JSON = `{ task_id, role, member_name }` — available for structured consumers

`drainInbox` in `index.ts` closes each bead after reading, so items are consumed exactly once.

### Executor ↔ index.ts (idle reaping)

```
executor.reapIdleClients(): void      // called by index.ts reaper interval
executor.getLiveClients(): Map<...>   // called by index.ts for usage polling
```

This is the only reverse coupling: `index.ts` reaches into the Executor, but only through these two narrow, read/cleanup-only interfaces. The Executor does not call back into `index.ts`.

---

## 5. Failure Modes

### Coordinator

**Failure boundary:** dispatch correctness — a task must not be lost, double-dispatched, or permanently stuck.

| Failure | Containment |
|---|---|
| `bd ready` returns empty or errors | Cycle exits silently; 30 s poll retries |
| `bd update --claim` fails with "already claimed" | Task skipped; EM notified (advisory). Prior session owns the task — no loss |
| `bd update --claim` fails (other) | Task skipped this cycle; retried on next event or poll |
| `resolveOrScale` returns `{ error }` | Task skipped this cycle; retried when a member becomes idle |
| `executor.execute()` throws | `failureCounts[taskId]++`; task reset to `open`; member evicted; retried up to 3× total, then deferred and EM notified |
| `writeQueue` chain error | Caught at chain boundary; EM notified; chain continues (does not stall permanently) |
| `stop()` called with in-flight tasks | In-flight `_runAndClose` calls drain normally; no new dispatches start |

### Executor

**Failure boundary:** subprocess isolation — one agent's failure must not corrupt the pool or block other members.

| Failure | Containment |
|---|---|
| Subprocess crash between tasks | `proc.once("exit")` removes the map entry silently; next `execute()` spawns fresh |
| Subprocess crash during task | `waitForIdleWithActivityTimeout` detects non-null `exitCode`; map entry deleted; error propagates to Coordinator as task failure |
| 60 s inactivity | Same polling path; client evicted; error propagates to Coordinator |
| 30 min absolute backstop | Same; guarantees Coordinator is never blocked indefinitely |
| Memory init failure | `evict()` called; error propagates to Coordinator as task failure |
| Memory update phase failure | Caught in `_enqueueMemoryPhase`; `notifyEM()` advisory; **never throws** — does not affect task result already returned |
| Empty output | Returns `{ exitCode: 1, output: "(no output)" }` rather than throwing — Coordinator sees a soft failure |

### Notifier

**Failure boundary:** delivery best-effort — EM must receive the result by *some* path, but the dispatch cycle must not be held up.

| Failure | Containment |
|---|---|
| `bd create` fails after 3 retries | Falls back to `notifyEM()` — pushes full message directly into EM's active session |
| `notifyEM()` fails (stale session) | Error silently dropped. Result is lost for this session; no retry mechanism. (Acceptable: EM can re-query task state via `bd show`) |
| `scheduleInboxPing` fires but EM client is not idle | Waits; does not block the dispatch cycle (called after `notify()` returns) |
| `drainInbox` reads empty inbox | 200 ms retry loop; if still empty, no-op |
