# Design: Beads Integration B — Broker-Mediated Work Queue

**Status:** Proposed  
**Author:** Alex Rivera  
**Date:** 2026-05-01  
**Beads version referenced:** bd v1.0.3 / docs v0.60.0 (`gastownhall/beads` commit `8694c53589f1`)  
**Related docs:**
- `.pi/docs/design-beads-scalability.md` — full scalability analysis, Integration B overview
- `.pi/docs/spec-beads-integration-a.md` — Integration A implementation spec (implemented)
- `.pi/docs/beads-em-reference.md` — verified bd CLI reference (Mercer Lin)

---

## 1. Purpose and Scope

Integration B adds a **broker** — a module within the org extension that watches the beads work queue and automatically dispatches ready tasks to team members, without requiring the EM to manually invoke `delegate` for each one.

This document is the detailed design for Integration B. It covers:

- The architectural decision to use native beads **labels** for role tagging (replacing an earlier description-field approach)
- The broker's event model, data flow, and failure recovery
- Required changes to `bd_task_create`, `bd_ready`, and `index.ts`
- The prerequisite refactor of `resolveOrScale`
- ADR-005 and ADR-006

**Out of scope for Integration B:**
- Server mode / multi-writer (`bd init --server`) — broker serialises writes; embedded mode is sufficient
- `bd gate` (async approval gates) — Integration C
- Molecule templates — Integration D
- Subagent direct `bd` access — broker mediates all writes; subagents do not touch `bd`

---

## 2. Background: Why Labels, Not Description Field

The prior proposal used the `description` field on beads tasks to carry the target role, encoding it as a prefix string (`role:<slug>`). This had a key dependency: the broker would need to call `bd show <id> --json` per ready task to retrieve the description field, since `bd ready --json` was not known to include it.

Mercer Lin's research (2026-05-01) confirms a better mechanism exists natively:

| Property | Description field approach | Labels approach |
|---|---|---|
| Tag at creation | `--description="role:typescript-engineer"` | `--label typescript-engineer` |
| Read during broker poll | Requires `bd show <id>` per task | `labels[]` present in `bd ready --json` response |
| Filter ready queue by role | Not possible without post-processing | `bd ready --label typescript-engineer --json` |
| Field reliability | `description` is `omitempty` — absent if empty; must check key presence | `labels` is always an array (empty if no labels) |
| Risk | R3 (unconfirmed) | Confirmed in Go source (`ready.go`) |

**Decision: use native beads labels throughout.** The description field is no longer used for role routing. See ADR-005.

---

## 3. Bottlenecks Addressed

From the scalability analysis in `design-beads-scalability.md`:

| Bottleneck | How Integration B addresses it |
|---|---|
| **B2 — 8-task parallelism cap** | EM pre-populates an arbitrarily large queue; broker dispatches concurrently as members become available |
| **B5 — Reactive resolveOrScale** | EM becomes a queue populator; broker handles per-task scheduling decisions |
| **B7 — EM synthesis bottleneck** | Workers write structured findings (git delta, text output, file references) to task notes via `bd update --append-notes`; `bd close --reason` carries a one-liner summary. Upstream findings are injected into downstream task briefs at dispatch time. See §17. |

Integration B does not address B1, B3, B4, or B6.

---

## 4. Architecture Overview

```
EM
 │ bd_task_create(title, epic_id, role="typescript-engineer", ...)
 │   └─ bd create ... --label typescript-engineer --json
 │        └─ [on success] → broker.onTaskCreated(taskId, cwd)
 │
 │ bd_task_update(id, status="open", ...)
 │   └─ bd update ... --json
 │        └─ [on success] → broker.onTaskUpdated(taskId, status, cwd)
 │
Broker (broker.ts)
 │ • Receives synchronous hook calls from bd_task_create / bd_task_update
 │ • Polls bd ready --type=task --json every 30s as safety net
 │ │
 │ ├─ For each ready task:
 │ │     role = task.labels[0]          ← from bd ready --json; no bd show needed
 │ │     resolveOrScale(cwd, memberState, role)
 │ │     taskBrief = "Read bead <id> and <verb>. BEADS_DIR=<cwd>/.beads"
 │ │     runTask(config, memberName, taskBrief, cwd)
 │ │       └─ agent calls: bd show <id> --json  (self-serves full context)
 │ │       └─ on success → bd close <id> --reason="<findings>"
 │ │       └─ on failure → bd update <id> --status=open   (re-queue)
 │ │                     → notify EM
 │ │
 │ └─ Write serialisation: per-cwd async queue prevents concurrent bd writes
 │
Members (RpcClient)
 • Unchanged — stateless, spawned by runTask as before
 • No bd access — broker is the sole writer in embedded mode
```

---

## 5. Label Convention

### 5.1 One label per task, matching role slug

Each task bead carries **at most one label**, which must exactly match a role slug from the agent definitions directory (`.pi/agents/<slug>.md`).

```bash
bd create "Implement OAuth2 flow" --type=task --parent=epic-001 \
  --label typescript-engineer --json
```

The label is the broker's routing key. If a task has no label, the broker skips it (no role-targeted dispatch). If a task has multiple labels, the broker uses `labels[0]` — the first label in the array — as the role. The EM should not create tasks with multiple labels for broker-dispatched work.

### 5.2 Label names must not use `provides:` prefix

Confirmed hard-fail in beads. Labels must be bare slugs: `typescript-engineer`, `software-architect`, `qa-engineer`. Never `provides:typescript-engineer`.

### 5.3 `bd ready --label <role>` for role-targeted polling

The broker can poll for all ready tasks in one call (`bd ready --type=task --json`) and dispatch by reading `labels[]`, or it can poll role-specifically (`bd ready --type=task --label typescript-engineer --json`) when scaling per-role. The primary broker implementation uses the single-call approach (§6.2); role-specific polling is available for future optimisation.

---

## 6. Broker Module (`broker.ts`)

### 6.1 File location and coupling

The broker lives at `.pi/extensions/org/broker.ts`, within the org extension. It is **not** a separate extension.

Rationale: the broker requires direct access to `resolveOrScale`, `runTask`, `memberState`, and `runBd`. Externalising it as a separate extension would require exposing these internals via a public API, adding accidental complexity. Tight coupling to the org extension internals is intentional — the broker is an internal subsystem, not a plugin point.

`index.ts` imports and instantiates the broker, passing the shared mutable state it needs.

### 6.2 Core dispatch loop

```typescript
// broker.ts (pseudocode — see §8 for implementation notes)

export class Broker {
    private active = false;
    private pollTimer?: ReturnType<typeof setTimeout>;
    private writeQueue = new Map<string, Promise<void>>(); // per-cwd serialisation

    constructor(
        private resolveOrScale: (cwd: string, memberState: MemberStateMap, role?: string) => Promise<ResolveResult>,
        private runTask: (config: AgentConfig, name: string, task: string, cwd: string) => Promise<RunResult>,
        private memberState: MemberStateMap,
        private notifyEM: (msg: string) => void,
    ) {}

    start() { this.active = true; this.schedulePoll(); }
    stop()  { this.active = false; clearTimeout(this.pollTimer); }

    // Called synchronously from bd_task_create / bd_task_update execute() after a successful bd write
    onTaskCreated(cwd: string)             { this.runDispatchCycle(cwd); }
    onTaskUpdated(cwd: string, status: string) {
        if (status === "open") this.runDispatchCycle(cwd); // re-queued task
    }

    private schedulePoll(ms = 30_000) {
        this.pollTimer = setTimeout(() => {
            if (!this.active) return;
            this.runDispatchCycle(/* cwd from lastCtx */ lastActiveCwd);
            this.schedulePoll();
        }, ms);
    }

    private async runDispatchCycle(cwd: string) {
        // Serialise per-cwd to prevent concurrent bd writes
        const prev = this.writeQueue.get(cwd) ?? Promise.resolve();
        const next = prev.then(() => this._dispatch(cwd)).catch(() => {});
        this.writeQueue.set(cwd, next);
    }

    // Maps role slug → verb for the minimal task brief sent to agents.
    // Agents self-serve full context via bd show; the verb sets intent.
    private static readonly ROLE_VERBS: Record<string, string> = {
        "typescript-engineer":   "implement",
        "software-architect":    "design",
        "qa-engineer":           "test",
        "documentation-steward": "document",
        "technical-writer":      "write",
        "prompt-engineer":       "implement",
        "pi-specialist":         "implement",
        "beads-specialist":      "implement",
        "release-engineer":      "release",
    };

    private async _dispatch(cwd: string) {
        const { stdout } = await runBd(cwd, ["ready", "--type=task", "--json"]);
        const tasks = JSON.parse(stdout) as BeadsTask[];

        for (const task of tasks) {
            const role = task.labels?.[0];
            if (!role) continue;                          // explicit guard: unlabelled = EM-owned; broker never touches it

            const r = await this.resolveOrScale(cwd, this.memberState, role);
            if ("error" in r) continue;                  // no available member for this role; skip

            // Mark in_progress before dispatching (prevent double-dispatch on next cycle)
            await runBd(cwd, ["update", task.id, "--status=in_progress", "--json"]);

            this._runAndClose(cwd, task.id, role, r).catch(() => {}); // fire-and-forget; errors handled inside
        }
    }

    // NOTE: §17.6 supersedes this with upstream findings injection, full result capture
    // (git delta + file offload), and explicit write-serialisation via _enqueueWrite.
    // The pseudocode below shows structural flow only.
    private async _runAndClose(cwd: string, taskId: string, role: string, r: ResolveSuccess) {
        try {
            const verb = Broker.ROLE_VERBS[role] ?? "complete";
            const beadsDir = path.join(cwd, ".beads");
            const brief = [
                `Your task is described in bead ${taskId}.`,
                `Retrieve the full details (title, design, acceptance criteria) with:`,
                `  BEADS_DIR=${beadsDir} bd show ${taskId} --json`,
                `Then ${verb} as specified.`,
            ].join("\n");
            const result = await this.runTask(r.config, r.member.name, brief, cwd);
            if (result.exitCode === 0) {
                // Simplified — §17.6 replaces this with bd update --append-notes (full capture) then close
                await runBd(cwd, ["close", taskId, `--reason=${result.output.slice(0, 150)}`, "--json"]);
            } else {
                await this._requeueTask(cwd, taskId, `exitCode ${result.exitCode}: ${result.stderr}`);
            }
        } catch (err: any) {
            await this._requeueTask(cwd, taskId, err?.message ?? String(err));
        }
    }

    private async _requeueTask(cwd: string, taskId: string, reason: string) {
        await runBd(cwd, ["update", taskId, "--status=open", "--json"]);
        this.notifyEM(`Broker: task ${taskId} failed and has been re-queued. Reason: ${reason}`);
    }
}
```

### 6.3 Write serialisation

Beads embedded mode uses a file-locked Dolt DB. Concurrent writes from concurrent `_runAndClose` completions would race. The per-`cwd` `writeQueue` chain ensures that all `runBd` calls within a dispatch cycle, and all `close` / `requeue` calls as tasks complete, are serialised on the same `Promise` chain.

Note: `runTask` itself (the agent execution) is **not** serialised — agents run in parallel. Only the `bd` writes are queued.

### 6.4 `in_progress` claim before dispatch

Before launching `runTask`, the broker calls `bd update <id> --status=in_progress`. This prevents a subsequent dispatch cycle (triggered by the 30s poll or another `bd_task_create` call) from double-dispatching the same task. The claim is not atomic (no `--claim` flag is needed in embedded mode because the broker is the sole writer), but it is sufficient: the task disappears from `bd ready` output immediately after status changes to `in_progress`.

---

## 7. Changes to `bd_task_create`

### 7.1 New `role` parameter

The `bd_task_create` tool gains an optional `role` parameter. When provided, it is written as a label using `--label <role>`.

```typescript
pi.registerTool({
    name: "bd_task_create",
    label: "Task Create",
    description:
        "Create a beads task. Attach it to an epic with epic_id if part of a tracked workstream. " +
        "Pass role to tag the task for broker dispatch — the broker will automatically delegate it " +
        "to an available member with that role when it becomes ready.",
    parameters: Type.Object({
        title: Type.String({ description: "Brief description of the task." }),
        epic_id: Type.Optional(Type.String({ description: "Parent epic ID." })),
        design: Type.Optional(Type.String({ description: "Rationale for this task." })),
        role: Type.Optional(Type.String({
            description:
                "Role slug to assign this task to (e.g. 'typescript-engineer', 'software-architect'). " +
                "If provided and the broker is active, the broker will auto-dispatch to an available " +
                "member with this role when the task becomes ready. Must match an agent slug in .pi/agents/.",
        })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const guard = beadsGuard(ctx.cwd);
        if (guard) return guard;

        const args = ["create", params.title, "--type=task", "--json"];
        if (params.epic_id) args.push(`--parent=${params.epic_id}`);
        if (params.design)  args.push(`--design=${params.design}`);
        if (params.role)    args.push(`--label=${params.role}`);   // ← label, not description

        try {
            const { stdout } = await runBd(ctx.cwd, args);
            const result = JSON.parse(stdout) as { id: string; title: string; [k: string]: unknown };
            if (!result?.id) throw new Error(`bd create returned unexpected shape: ${stdout}`);

            // Notify broker synchronously after successful write
            if (broker?.active) broker.onTaskCreated(ctx.cwd);

            return {
                content: [{ type: "text", text: `Task created. ID: ${result.id} — "${result.title}"` }],
                details: { id: result.id, title: result.title },
            };
        } catch (err: any) {
            throw new Error(`bd_task_create failed: ${err?.stderr ?? err?.message ?? err}`);
        }
    },
});
```

### 7.2 Broker hook in `bd_task_update`

Similarly, `bd_task_update` must notify the broker when a task is reset to `open` (e.g., after a manual status correction by the EM or after a failed task is re-queued by the broker itself).

```typescript
// In bd_task_update execute(), after successful bd write:
if (broker?.active && params.status === "open") {
    broker.onTaskUpdated(ctx.cwd, "open");
}
```

---

## 8. Changes to `bd_ready`

### 8.1 No change required for Integration A usage

The existing `bd_ready` tool remains unchanged for EM use — the EM continues to call it to inspect the ready front manually.

### 8.2 Labels in response

`bd ready --json` already includes the `labels` array in each task object (confirmed from Go source `ready.go`). No additional flag or post-processing is needed. The broker reads `task.labels?.[0]` directly from the poll response.

### 8.3 Optional role filter for EM visibility

The EM may want to query "what tasks are ready for a specific role?" The `bd_ready` tool can be extended with an optional `role` parameter that passes `--label <role>` to `bd ready`:

```typescript
parameters: Type.Object({
    role: Type.Optional(Type.String({
        description: "Filter to tasks labelled for a specific role. Omit to return all ready tasks.",
    })),
}),
// In execute():
const args = ["ready", "--type=task", "--json"];
if (params.role) args.push(`--label=${params.role}`);
```

This is a non-breaking additive change. Existing EM prompts that call `bd_ready` without parameters continue to work.

---

## 9. Prerequisite Refactor: Extracting `resolveOrScale`

`resolveOrScale` is currently defined as a local `async function` inside the `delegate` tool's `execute` closure. The broker needs to call it independently. It must be hoisted to module scope.

### 9.1 Current signature (inferred from index.ts)

```typescript
// Current: defined inside delegate.execute()
async function resolveOrScale(
    member?: string,
    role?: string,
): Promise<{ member: Member; config: AgentConfig; hired: boolean } | { error: string }>
```

### 9.2 New module-scope signature

```typescript
// New: module-scope, receives external dependencies explicitly
async function resolveOrScale(
    cwd: string,
    roster: Roster,
    memberState: Map<string, MemberState>,
    role?: string,
    member?: string,
): Promise<{ member: Member; config: AgentConfig; hired: boolean } | { error: string }>
```

The implementation logic is unchanged. The function reads `roster`, `memberState`, and `ctx.cwd` — all of which were previously captured as closures. These are now explicit parameters.

### 9.3 Call sites

All existing call sites inside `delegate.execute` are updated to pass the new parameters:

```typescript
// Before:
const r = await resolveOrScale(params.member, params.role);

// After:
const r = await resolveOrScale(ctx.cwd, roster, memberState, params.role, params.member);
```

There are six call sites (single mode, async single, parallel × 2, chain × 2). This is a mechanical change; no behaviour changes.

---

## 10. Broker Activation

### 10.1 Opt-in via `bd_broker_start` / `bd_broker_stop`

The broker is **not** active by default. It is started explicitly by the EM (or by a `/broker` command) for workstreams where autonomous dispatch is appropriate.

```typescript
pi.registerTool({
    name: "bd_broker_start",
    label: "Broker Start",
    description:
        "Activate the beads broker. While active, the broker monitors the beads ready queue and " +
        "automatically dispatches ready tasks to available team members by their role label. " +
        "Use when you have pre-populated a beads queue and want autonomous dispatch.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        if (broker.active) {
            return { content: [{ type: "text", text: "Broker is already active." }], details: {} };
        }
        broker.start(ctx.cwd);
        return { content: [{ type: "text", text: "Broker started. Ready tasks will be dispatched automatically." }], details: {} };
    },
});

pi.registerTool({
    name: "bd_broker_stop",
    label: "Broker Stop",
    description: "Deactivate the beads broker. In-flight tasks will complete; no new tasks will be dispatched.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
        broker.stop();
        return { content: [{ type: "text", text: "Broker stopped." }], details: {} };
    },
});
```

### 10.2 The `delegate` tool is unaffected

The `delegate` tool continues to work exactly as before. The broker and `delegate` are independent dispatch paths. The EM can use both in the same workstream (e.g., use `delegate` for tasks that need close EM oversight, and the broker for background tasks that don't). They share the same `memberState` map; `resolveOrScale` will avoid assigning a member that is already `"working"`.

### 10.3 Broker in `index.ts`

```typescript
// In export default function(pi: ExtensionAPI):
const broker = new Broker(resolveOrScale, runTaskWithStreaming, memberState, (msg) => {
    pi.sendUserMessage(msg, { deliverAs: "followUp" });
});

// Stop broker on session end to prevent orphaned timers:
pi.on("session_end", () => broker.stop());
```

---

## 11. Failure Recovery

### 11.1 Task execution failure

If `runTask` throws or returns a non-zero exit code, the broker:
1. Calls `bd update <id> --status=open --json` — re-queues the task
2. Calls `notifyEM` with the failure reason as a follow-up message

The re-queued task will appear in the next `bd ready` poll cycle. The broker will attempt redispatch. To prevent infinite retry loops on hard failures (e.g., a task whose agent always crashes), the broker should track failure counts per task and skip tasks that have failed ≥ 3 times, notifying the EM instead.

### 11.2 `bd` write failure

If a `runBd` call within `_runAndClose` throws (e.g., locked DB, timeout), the error is caught by the `writeQueue` chain. The task is left in `in_progress` state in beads. The 30s safety-net poll will not re-dispatch it (it is no longer `open`). The EM must manually inspect and reset via `bd_task_update`.

**Mitigation:** The broker should log a warning via `notifyEM` on any `runBd` failure. Future work: a `bd_broker_status` tool that shows tasks stuck in `in_progress` beyond a configurable timeout.

### 11.3 Member crash between task start and task end

The existing crash recovery in `index.ts` (attaching an exit listener via `(client as any).process`) handles the member process dying. If the member crashes, `runTask` throws, which is caught by `_runAndClose` and triggers §11.1 recovery (re-queue + EM notification).

---

## 12. `bd show --json` — `description` Field Note

During the design iteration on this document, Mercer Lin confirmed:

> `bd show --json` `description` is `omitempty` — the field is absent from the JSON object if the description was not set.

**Consequence for any code that reads `description` from `bd show` output:** Always check for key presence (`"description" in task ? task.description : undefined`), not just truthiness. This applies to any EM-side code that reads task descriptions for display purposes.

**This has no effect on Integration B's broker dispatch**, which uses `labels[]` exclusively for role routing and never reads `description`.

---

## 13. Resolved Risks

The following risks from earlier design discussions are now resolved:

| Risk | Status | Resolution |
|---|---|---|
| R3: `bd show` description field may not be present | ✅ Resolved | Moot — broker uses `labels[]` from `bd ready`, not `description` from `bd show`. `bd show` description field is omitempty (noted in §12 for completeness). |
| R1: `bd ready --json` does not include labels | ✅ Resolved | Labels confirmed present in `bd ready --json` response (Mercer Lin, 2026-05-01, verified in `ready.go`). |
| R2: `--label` flag may cause hard failure | ✅ Resolved | `bd create --label <slug>` is valid. `provides:` prefix hard-fails — bare slugs do not. |

---

## 14. Open Questions

### OQ-1: Failure count tracking — in-memory or in beads?

The §11.1 retry limit (skip after 3 failures) can be tracked in-memory (`Map<taskId, number>`) or written to the task's `notes` field via `bd update --append-notes`. In-memory is simpler but lost on broker restart; beads-side is durable but adds write traffic.

**Recommendation:** Start with in-memory. Promote to beads-side if broker restarts between task failures become a real operational problem.

### OQ-2: Multi-cwd broker

The current design tracks one `lastActiveCwd` for the 30s safety-net poll. If the EM works across multiple project directories in one session, the poll will only cover one cwd. The event-driven hooks (`onTaskCreated`, `onTaskUpdated`) pass `cwd` explicitly and are not affected.

**Recommendation:** Extend the broker to maintain a `Set<string>` of active cwds (populated on first `bd_task_create` in each cwd while broker is active) and poll all of them. Low priority — multi-cwd is uncommon.

### OQ-3: `bd show --json` blocked-by dependency field name

Upstream findings injection (§17.4) requires reading a task's blocked-by dep IDs from `bd show <id> --json`. The field name is unconfirmed. Based on CLI vocabulary (`bd dep add <blocked-id> <blocker-id>`) it is likely `deps.blockedBy`, `blocked_by`, or similar — but must be verified from Go source before implementation.

**Fallback if `bd show` does not include deps:** add a hook to the `bd_dep_add` tool that populates a broker-internal `Map<taskId, Set<blockerId>>` at creation time (§17.4). This eliminates any dependency on `bd show` for dep lookup.

### OQ-4: `bd close --reason` character limit

§17.3 caps the close summary at 150 chars. If the CLI enforces a shorter limit internally, the cap should be adjusted. Verify from Go source or empirically.

### OQ-5: `.pi/task-results/` — ephemeral or committed?

Large agent text outputs written by the broker to `.pi/task-results/` are potentially meaningful artifacts (research findings, design documents in progress). Whether to commit them to git is context-dependent. The broker does not make any git commits — it only writes the file. The EM or a `release-engineer` pass decides what to commit.

**Default recommendation:** do not add `.pi/task-results/` to `.gitignore`. Let files accumulate and be committed as part of normal workflow. The EM can gitignore them if they are considered ephemeral.

---

## 15. Agent `bash` Access Requirement

Broker-dispatched agents must call `bd show <id> --json` via their `bash` tool to self-serve task context. This requires `bash` to be listed in the role's `tools` frontmatter.

**Roles with `bash` — no change required:**

| Role | tools line |
|---|---|
| `typescript-engineer` | `tools: read, bash, edit, write, grep, find, ls` |
| `qa-engineer` | `tools: read, write, edit, bash, grep, find, ls` |
| `pi-specialist` | `tools: read, write, edit, bash, grep, find, ls` |
| `beads-specialist` | `tools: read, write, edit, bash, grep, find, web_search, fetch_content` |
| `release-engineer` | `tools: read, write, edit, bash` |

**Roles missing `bash` — must be updated before broker dispatch to these roles:**

| Role | Current tools line | Required change |
|---|---|---|
| `software-architect` | `tools: read, write, edit, grep, find, ls` | Add `bash` |
| `technical-writer` | `tools: read, write, edit, grep, find, ls` | Add `bash` |
| `prompt-engineer` | `tools: read, write, edit, grep, find, ls` | Add `bash` |
| `documentation-steward` | `tools: read, write, edit, grep, find, ls` | Add `bash` |

Adding `bash` to these four roles is a one-line change per file and has no effect on existing `delegate`-based dispatch, since those tasks already provide full context in the task description. The broker will not function correctly for these roles until `bash` is added.

---

## 16. File Change Summary

| File | Change type | Description |
|---|---|---|
| `.pi/extensions/org/broker.ts` | New | `Broker` class: dispatch loop, `ROLE_VERBS` map, write serialisation, failure recovery |
| `.pi/extensions/org/index.ts` | Modify | Extract `resolveOrScale` to module scope; instantiate `Broker`; add `role` param to `bd_task_create`; add broker hooks to `bd_task_create` and `bd_task_update`; add optional `role` param to `bd_ready`; register `bd_broker_start` and `bd_broker_stop` tools; call `broker.stop()` on `session_end` |
| `.pi/agents/software-architect.md` | Modify | Add `bash` to `tools` frontmatter |
| `.pi/agents/technical-writer.md` | Modify | Add `bash` to `tools` frontmatter |
| `.pi/agents/prompt-engineer.md` | Modify | Add `bash` to `tools` frontmatter |
| `.pi/agents/documentation-steward.md` | Modify | Add `bash` to `tools` frontmatter |
| `.pi/task-results/` | New (created at runtime by broker) | Stores full agent text outputs that exceed the 3000-char inline threshold; referenced by path in task notes |

All other files are unchanged. Integration A's seven tools, `delegate` tool behaviour, and `SYSTEM.md` guidance are unaffected.

---

## ADR-006: Label as Dispatch Ownership Signal

**Status:** Proposed

**Context:**

Integration B introduces two independent dispatch paths: the `delegate` tool (imperative, EM-driven) and the broker (declarative, autonomous). Both paths can coexist and operate against the same `memberState` and beads store. Without a clear ownership signal, a task bead could be ambiguously dispatched by both — the broker picks it off `bd ready` while the EM also calls `delegate` for the same work.

This ambiguity was identified as a structural risk in the dispatch path architecture analysis (2026-05-01).

**Decision:**

The presence of a role label on a task bead is the **sole and authoritative signal** of broker ownership:

- **Labelled bead** (`labels: ["<role-slug>"]`) → broker-owned. The broker will dispatch it, mark it `in_progress`, and close it. The EM must not call `bd_task_update` to close it. The EM must not pass it to `delegate`.
- **Unlabelled bead** (`labels: []`) → EM-owned. The broker will never touch it. The EM closes it manually via `bd_task_update`.
- **No bead at all** → `delegate`-only dispatch with no persistence. Integration A pattern.

The broker enforces this with an explicit early guard — not a fallthrough:

```typescript
const role = task.labels?.[0];
if (!role) continue;  // unlabelled = EM-owned; skip unconditionally
```

This guard is distinct from the subsequent `resolveOrScale` failure path (which means "no available member"). An unlabelled task being silently skipped due to a failed role lookup would be a confusing false negative. The explicit guard makes the intent unambiguous.

**Consequences:**

*Positive:*
- Double-dispatch is architecturally impossible when the invariant is followed: broker only touches labelled beads; `delegate` only operates outside of beads (or on unlabelled beads for record-keeping)
- The invariant is checkable at a glance: `bd show <id> --json` → check `labels` field
- No coordination needed between the broker poll cycle and EM-initiated `delegate` calls

*Negative:*
- The invariant is enforced by convention on the EM side, not by the schema. The broker guard prevents it from acting on unlabelled beads, but nothing prevents the EM from accidentally adding a label to a bead it intends to manage manually. Documentation and EM system prompt guidance must reinforce this clearly.
- Future tooling (e.g., a `bd_broker_status` diagnostic) must be label-aware to distinguish broker-owned from EM-owned tasks in `bd list` output.

---

## ADR-005: Native Beads Labels for Role Routing in Integration B

**Status:** Proposed

**Context:**

Integration B requires a mechanism to tag a beads task with the role of the team member that should execute it, so the broker can route ready tasks to the correct member type without additional lookups. Two approaches were evaluated:

1. **Description field encoding** — store `role:<slug>` in the task's `description` field; broker calls `bd show <id>` per ready task to extract it
2. **Native labels** — store the role slug as a beads label (`--label <slug>`); broker reads `labels[]` from `bd ready --json` directly

**Decision:**

Use native beads labels. The `bd_task_create` tool accepts an optional `role` parameter and passes it as `--label <role>` to `bd create`. The broker reads `task.labels?.[0]` from the `bd ready --json` response. No `bd show` call is needed for role routing.

Additionally, the `bd_ready` tool is extended with an optional `role` parameter that passes `--label <role>` to `bd ready`, enabling role-filtered ready-queue queries.

**Consequences:**

*Positive:*
- No extra `bd show` call per dispatch cycle — role is present in `bd ready` output already
- `bd ready --label <role>` enables efficient role-targeted queue queries for future optimisation
- Eliminates R3 risk (description field reliability) entirely; `description` is no longer used for routing
- Labels are a first-class beads concept; this is idiomatic use of the API
- Consistent with how beads is designed to be used for classification

*Negative:*
- One label per task is a soft constraint enforced by convention, not the schema — the EM could accidentally add multiple labels, making `labels[0]` non-deterministic. The `bd_task_create` tool should document this constraint clearly.
- Tasks created without the `bd_task_create` tool (e.g., directly via `bd` CLI) will not have role labels and will be skipped by the broker. This is acceptable — manual tasks require manual dispatch.

*Neutral:*
- `bd show --json` `description` field is `omitempty` and must be checked for key presence in any code that reads it. This is noted in §12 but has no impact on the broker's dispatch path.

---

## 17. Result Capture and Propagation

### 17.1 Overview

The broker currently closes completed tasks with a 500-char slice of the agent's output as the `--reason` string. This is insufficient for:

- **Text-output tasks** (research, analysis, design documents): the full output can be many kilobytes and is the primary deliverable.
- **File-change tasks** (implementation, refactoring): the important artifact is a git commit; capturing text output is less useful than recording the commit SHA.
- **Downstream tasks**: a task with resolved blockers should receive the blockers' results as context, not start from a blank brief.

This section defines a two-part result capture strategy (§17.2–17.3), an upstream findings injection mechanism (§17.4), and documents how fan-in tasks are handled (§17.5).

---

### 17.2 Capture Strategy Heuristic

After `runTask` completes, the broker determines which capture strategy to apply by checking for a new git commit:

```typescript
async function getHeadCommit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git log -1 --format=%H', { cwd });
    return stdout.trim() || null;
  } catch {
    return null; // not a git repo, or no commits yet
  }
}
```

```typescript
// In Broker.dispatchTask(), around runTask():
const commitBefore = await getHeadCommit(cwd);
const result = await runTask(client, brief);
const commitAfter = await getHeadCommit(cwd);

const isFileChange = commitAfter !== null && commitAfter !== commitBefore;
```

**Rationale:** A new commit is the cleanest signal that the agent made durable file changes. This heuristic has two known edge cases:

- **False negative**: an agent writes files but does not commit (e.g., it leaves a PR for review). The broker falls through to text-output capture, which is acceptable — the text output will mention the uncommitted changes.
- **False positive**: an unrelated commit lands concurrently (e.g., a human developer commits during task execution). Unlikely in the typical single-developer session; acceptable risk.

No configuration knob is needed for now. If these edge cases become operational problems, an explicit `task_type` field on the bead can override the heuristic.

---

### 17.3 Result Capture Implementation

Capture happens in a new `Broker.captureResult()` method called after `runTask()` returns. The existing `bd close --reason=result.output.slice(0, 500)` call is replaced.

#### Close reason (all tasks)

A one-line human-readable summary is always written as the close reason:

```typescript
function summarise(output: string): string {
  // Take the first non-empty line, strip markdown, cap at 150 chars.
  const firstLine = output.split('\n').find(l => l.trim().length > 0) ?? 'Task completed.';
  return firstLine.replace(/[#*`_>]/g, '').trim().slice(0, 150);
}

await runBd(['close', taskId, `--reason=${summarise(result.output)}`, '--json'], cwd);
```

The 150-char cap is a conservative limit. OQ-4 tracks whether `bd close --reason` enforces a shorter CLI-level limit.

#### File-change path

If `isFileChange` is true:

```typescript
await runBd(['update', taskId, `--set-metadata`, `git_commit=${commitAfter}`, '--json'], cwd);
```

The commit SHA is stored in `metadata.git_commit`. No notes write is performed — the commit log is the full record.

#### Text-output path

If `isFileChange` is false, the full agent output is written to `notes`:

```typescript
const TEXT_CAP = 40 * 1024; // 40KB — leaves ~24KB headroom in the 64KB notes field

if (result.output.length <= TEXT_CAP) {
  await runBd(['update', taskId, '--append-notes', result.output, '--json'], cwd);
} else {
  // Large output — write to disk, record path in metadata
  const outPath = path.join(cwd, '.pi', 'task-results', `${taskId}.md`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, result.output, 'utf8');
  await runBd(['update', taskId, '--append-notes',
    `[Full output written to file — see metadata.result_file]`, '--json'], cwd);
  await runBd(['update', taskId, '--set-metadata', `result_file=${outPath}`, '--json'], cwd);
}
```

The 40KB cap leaves ~24KB of headroom within the 64KB `notes` ceiling, accommodating any prior notes already written (task brief, retry records, etc.).

**`.pi/task-results/` directory:** Created lazily on first use. See OQ-5 in §14 for commit policy.

#### `captureResult()` summary

```typescript
async captureResult(
  taskId: string,
  taskTitle: string,
  result: { output: string },
  commitBefore: string | null,
  commitAfter: string | null,
  cwd: string
): Promise<void> {
  const isFileChange = commitAfter !== null && commitAfter !== commitBefore;

  // 1. Close with summary
  await runBd(['close', taskId, `--reason=${summarise(result.output)}`, '--json'], cwd);

  // 2. Capture artifact
  if (isFileChange) {
    await runBd(['update', taskId, '--set-metadata', `git_commit=${commitAfter}`, '--json'], cwd);
  } else if (result.output.length <= TEXT_CAP) {
    await runBd(['update', taskId, '--append-notes', result.output, '--json'], cwd);
  } else {
    const outPath = path.join(cwd, '.pi', 'task-results', `${taskId}.md`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, result.output, 'utf8');
    await runBd(['update', taskId, '--append-notes',
      `[Full output written to file — see metadata.result_file]`, '--json'], cwd);
    await runBd(['update', taskId, '--set-metadata', `result_file=${outPath}`, '--json'], cwd);
  }
}
```

---

### 17.4 Upstream Findings Injection

When the broker dispatches task B, it checks whether B has any resolved blockers and, if so, prepends a context block to B's brief.

#### Step 1: Retrieve blocker IDs

The broker calls `bd show <taskId> --json` on the task being dispatched and reads the dependency list. The field name for blocked-by deps is unconfirmed — see OQ-3 in §14. The implementation must verify the exact field name from the Go source or live testing before coding this step.

Fallback (if `bd show` does not include dep fields): the `bd_dep_add` tool populates a broker-internal `Map<taskId, Set<blockerId>>` at creation time. This is a complete fallback — no `bd show` call is needed for dep lookup in this mode.

```typescript
// Preferred path (assumes field name is confirmed as `deps.blockedBy`):
const showResult = await runBd(['show', taskId, '--json'], cwd);
const task = JSON.parse(showResult)[0];
const blockerIds: string[] = task.deps?.blockedBy ?? [];

// Fallback path:
const blockerIds: string[] = [...(this.depMap.get(taskId) ?? [])];
```

#### Step 2: Fetch blocker results

For each blocker ID, call `bd show <blockerId> --json` and extract the result fields:

```typescript
interface BlockerContext {
  title: string;
  summary: string; // one-line description of what was found
}

async function fetchBlockerContext(blockerId: string, cwd: string): Promise<BlockerContext | null> {
  try {
    const raw = await runBd(['show', blockerId, '--json'], cwd);
    const bead = JSON.parse(raw)[0];
    if (!bead) return null;

    const title = bead.title ?? blockerId;

    // Prefer: notes excerpt > git commit reference > result_file reference
    const meta = bead.metadata ?? {};
    if (meta.git_commit) {
      return { title, summary: `see commit ${meta.git_commit}` };
    }
    if (meta.result_file) {
      return { title, summary: `see file ${meta.result_file}` };
    }
    if (bead.notes) {
      // Use the first 300 chars of notes as the summary snippet
      return { title, summary: bead.notes.slice(0, 300).replace(/\n+/g, ' ').trim() };
    }
    return { title, summary: '(no result recorded)' };
  } catch {
    return null;
  }
}
```

#### Step 3: Compose context block

The upstream context block is appended to the agent brief, capped at 2000 chars total across all upstream tasks:

```typescript
const UPSTREAM_CAP = 2000;

async function buildUpstreamContext(
  blockerIds: string[], cwd: string
): Promise<string> {
  if (blockerIds.length === 0) return '';

  const contexts = (await Promise.all(blockerIds.map(id => fetchBlockerContext(id, cwd))))
    .filter((c): c is BlockerContext => c !== null);

  if (contexts.length === 0) return '';

  const lines = contexts.map(c => `- ${c.title}: ${c.summary}`);
  const block = `Context from upstream tasks:\n${lines.join('\n')}`;
  return block.slice(0, UPSTREAM_CAP);
}
```

The context block is appended to the dispatch brief before it is sent to the agent:

```typescript
const upstreamContext = await buildUpstreamContext(blockerIds, cwd);
const fullBrief = upstreamContext
  ? `${baseBrief}\n\n${upstreamContext}`
  : baseBrief;
```

#### When blockers are not yet closed

The broker only dispatches a task when `bd ready` reports it (meaning all blockers are resolved in beads). A blocker that has not been closed will not appear in `bd ready`. Therefore, at dispatch time, all blockers in the dep chain should already be in a terminal state (closed). If `fetchBlockerContext` returns `null` for a blocker — due to a `bd show` failure or a bead in unexpected state — it is silently omitted from the context block. The task is still dispatched; incomplete upstream context is preferable to blocking dispatch entirely.

---

### 17.5 Fan-in Synthesis

A fan-in task (one task blocked by multiple upstream tasks) is the natural case for the §17.4 mechanism. When B has N resolved blockers, `buildUpstreamContext` fetches all N blocker results and injects them as N bullet points in the context block.

No special broker logic is required beyond what §17.4 provides. The dispatched agent receives a single brief with all upstream context and synthesises from it. This is the correct division of responsibility — synthesis is a reasoning task for the agent, not a structural task for the broker.

**Token budget note:** The 2000-char cap on injected context is a heuristic. With large fan-in (5+ blockers), each upstream summary is compressed to ~400 chars. If a downstream task genuinely requires deep context from each upstream result, the agent can call `bd show <blockerId> --json` directly via its `bash` tool and read the full `notes` field. The upstream context block should be treated as a navigation aid, not the full source of truth.

---

### 17.6 Implementation Changes

The following additions are required in `broker.ts` beyond the base design in §6:

| Addition | Description |
|---|---|
| `getHeadCommit(cwd)` | Utility: calls `git log -1 --format=%H`; returns null on failure |
| `summarise(output)` | Utility: extracts first non-empty line, strips markdown, caps at 150 chars |
| `Broker.captureResult()` | Replaces the inline `bd close` call after `runTask`; implements file-change vs text-output branching |
| `fetchBlockerContext(id, cwd)` | Utility: `bd show` a blocker and extract result fields into a `BlockerContext` |
| `buildUpstreamContext(ids, cwd)` | Composes and caps the upstream context block; called before brief is sent |
| `Broker.depMap` | `Map<string, Set<string>>` — fallback dep tracking if `bd show` dep field is unavailable (OQ-3) |
| `node:fs/promises` import | Required for writing `.pi/task-results/<id>.md` |
| `node:path` import | Required for constructing `outPath` |

The §16 file change table lists `broker.ts` as the primary target; no other files require changes for result capture and propagation.
