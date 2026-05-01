# Design: Keeping Team Members Alive Between Tasks

**Author:** Alex Rivera  
**Date:** 2026-05-01  
**Status:** Exploration — not yet committed

---

## Problem Statement

Every `delegate` call in the org extension today spawns a fresh pi subprocess via `child_process.spawn(..., ["--mode", "json", "-p", "--no-session", ...])`. The process runs one task and exits. Members have no in-context memory — they can only know what's in their system prompt and what they write to a memory file.

The consequence is:
- Every task starts cold. Context from prior tasks must be manually externalised (memory files), which is lossy and requires the member to re-read it.
- Multi-step work on the same codebase requires re-reading the same files repeatedly.
- Reasoning chains and intermediate decisions that didn't merit a memory write are lost entirely.

The goal is to explore options for members accumulating context across multiple sequential tasks without having to externalise everything.

---

## What "Keeping Alive" Could Mean

Three distinct things are conflated here and worth separating:

| Concept | Definition |
|---|---|
| **Process persistence** | The OS process stays alive between tasks. No spawn overhead. |
| **Context window persistence** | The LLM conversation history (messages, tool calls, results) carries over. |
| **Session persistence** | The conversation is written to a JSONL file and can be resumed by a fresh process. |

These can be combined independently. Today the org extension has none of the three. The options below mix them in increasing levels of ambition.

---

## Framework Capabilities (Relevant Findings)

### `--no-session` (current)
Calls `SessionManager.inMemory()` — the conversation exists only in RAM for the life of the process. No JSONL file is written. Dies with the process.

### Named sessions (file-backed)
Normal `SessionManager.create()` or `SessionManager.open()` — conversation is written to a `.jsonl` file. A fresh process can `--session <path>` to resume it. Available today.

### `--mode rpc` + `RpcClient`
Pi ships a **fully built long-running agent client** at `dist/modes/rpc/rpc-client.js`. It:
- Spawns the agent with `--mode rpc` (long-running, stdin/stdout JSON protocol)
- Exposes a typed TypeScript API: `start()`, `stop()`, `prompt()`, `waitForIdle()`, `compact()`, `newSession()`, `clone()`, `getMessages()`, `getSessionStats()`
- Is designed explicitly for embedding the agent in other applications

This is the critical finding: **the hard part is already built**. The org extension just needs to use `RpcClient` instead of raw `spawn`.

### Context compaction
Both the session model and `RpcClient` support `compact()` — a first-class operation that summarises the conversation history and replaces it with a compact summary, resetting the context window counter while preserving semantic continuity.

---

## Options

### Option A — Session File Replay (Low Complexity)

**What it is:** Stop using `--no-session`. Give each member a named session file at `.pi/sessions/<member-slug>.jsonl`. Each task spawns a fresh process with `--session <file>`, which resumes the prior conversation.

**How `runTask()` changes:**
```typescript
// Before
const args = ["--mode", "json", "-p", "--no-session", "--system-prompt", ""];

// After
const sessionFile = path.join(cwd, ".pi", "sessions", `${memberSlug}.jsonl`);
const sessionArgs = fs.existsSync(sessionFile)
  ? ["--session", sessionFile]
  : []; // first run: pi creates a new session at default location; we'd need to track it
const args = ["--mode", "json", "-p", ...sessionArgs, "--system-prompt", ""];
```

The session file path management is a complication: pi creates sessions in a configured `sessionDir`, not at an arbitrary path. We'd use `--session <path>` to open an existing file, but initial creation needs care. Alternatively, pass `--no-session` for the first task and then switch — but then we lose that first conversation.

A cleaner approach: let pi write to its default session dir, but capture the session ID from the `get_state` response (not available in `--mode json`). This makes Option A awkward without at least partial RPC adoption.

**Tradeoffs:**

| | |
|---|---|
| ✅ | No long-running process management |
| ✅ | Crash-safe: context survives process death |
| ✅ | Parallelism unchanged (fresh process per task) |
| ❌ | Context window grows unboundedly without explicit compaction |
| ❌ | Spawn overhead on every task (same as today) |
| ❌ | Session file path management is fiddly with the current `--mode json` flow |
| ❌ | Re-reading context on every spawn gets expensive as sessions grow |

**Verdict:** Solves persistence but not in-context continuity. Awkward to implement cleanly with `--mode json`.

---

### Option B — Long-Running RPC Process per Member (Medium Complexity)

**What it is:** Replace per-task `spawn` with a persistent `RpcClient` per named member. The org extension holds a `Map<memberName, RpcClient>` and routes tasks to existing clients. A new client is created on first access and kept alive until explicitly stopped or idle for too long.

**How it works:**
```typescript
// In the org extension module scope
const liveMembers = new Map<string, {
  client: RpcClient;
  lastUsed: number;
  pendingTask: boolean;
}>();

async function getOrCreateClient(config: AgentConfig, memberName: string, cwd: string): Promise<RpcClient> {
  const key = `${cwd}::${memberName}`;
  let entry = liveMembers.get(key);
  if (!entry) {
    const client = new RpcClient({
      cwd,
      model: config.model,
      args: [
        "--no-session",              // or named session for crash recovery
        "--system-prompt", "",
        "--append-system-prompt", await buildSystemPromptFile(config, memberName, cwd),
      ],
    });
    await client.start();
    entry = { client, lastUsed: Date.now(), pendingTask: false };
    liveMembers.set(key, entry);
  }
  entry.lastUsed = Date.now();
  return entry.client;
}

async function runTask(config, memberName, task, cwd, signal, onProgress, onStream): Promise<RunResult> {
  const client = await getOrCreateClient(config, memberName, cwd);
  const events: AgentEvent[] = [];
  const unsub = client.onEvent(ev => {
    events.push(ev);
    // translate to onStream/onProgress
  });
  await client.prompt(`Task for ${memberName}: ${task}`);
  await client.waitForIdle();
  unsub();
  const text = await client.getLastAssistantText();
  return { exitCode: 0, output: text ?? "", stderr: "", usage: extractUsage(events) };
}
```

**Idle timeout management:**
```typescript
// Sweep loop — kill clients idle > 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of liveMembers) {
    if (!entry.pendingTask && now - entry.lastUsed > 10 * 60 * 1000) {
      entry.client.stop();
      liveMembers.delete(key);
    }
  }
}, 60_000);
```

**Parallelism concern:** ~~The same named member cannot run two tasks concurrently on a single `RpcClient`.~~ **This concern was invalidated on review** (see note below). `resolveOrScale()` already guarantees that a named member is always idle before being assigned — if a named member is `working`, the call falls through to auto-hire a new member of the same role. Therefore no `RpcClient` will ever receive two concurrent `prompt()` calls.

> **Correction note (2026-05-01):** The original design stated that parallel mode should stay on fresh spawns because "a single RpcClient can't handle concurrent tasks." While technically true of `RpcClient`, it is architecturally irrelevant: `resolveOrScale()` enforces that each named member is idle at assignment time. In parallel mode, N tasks go to N distinct members (or N distinct auto-hired members), each with their own `RpcClient`. No client ever sees concurrent `prompt()` calls. Parallel mode should therefore also use persistent clients.

**Context window management:**
- Enable `autoCompaction` when starting the client: the framework handles it automatically.
- Or call `client.compact()` between tasks if context exceeds a threshold.
- `client.getSessionStats()` returns token counts for monitoring.

**System prompt injection:** `RpcClient` accepts `args` at construction, which are passed to the `pi` CLI at spawn. `--append-system-prompt <file>` works here, but the file must exist for the lifetime of the client. Currently `runTask` writes a temp file and deletes it after. Under Option B, write it once to `.pi/prompts/members/<slug>.md` at client creation time instead.

**Crash recovery:** If the RpcClient process dies unexpectedly, the `liveMembers` entry becomes stale. Detect this via the process `exit` event and remove the entry; next task recreates fresh. Context is lost on crash unless combined with a named session file.

**Tradeoffs:**

| | |
|---|---|
| ✅ | True in-context continuity — conversation history carries over |
| ✅ | No spawn overhead after first task |
| ✅ | Auto-compaction available natively |
| ✅ | `RpcClient` is already written and typed — minimal new code |
| ✅ | Clean API boundary: `prompt()` + `waitForIdle()` |
| ❌ | Long-lived processes consume memory (one node process per active member) |
| ✅ | Parallelism safe: each member guaranteed idle at assignment; no concurrent prompt() calls |
| ❌ | Crash = context loss (unless paired with session file) |
| ❌ | System prompt file lifecycle changes (can no longer be a temp file) |
| ❌ | Memory file injection timing: currently injected per-task (reads fresh content each spawn); with RPC the memory file is read once at client start, stale after first task |

**The memory file timing problem** is notable: today, the memory file is read at spawn and injected into the system prompt. With a persistent client, the system prompt is fixed. Members could still read/write their memory file as a tool call, but the injection mechanism changes. Possible fix: between tasks, send the updated memory as a `followUp` message rather than re-injecting via system prompt.

---

### Option C — Session-Backed RPC (Higher Complexity, Highest Value)

**What it is:** Option B with named session files per member, giving both in-context continuity (fast, no re-read) and disk persistence (crash recovery, continuity across org restarts).

**Key additions over Option B:**
```typescript
const sessionFile = path.join(cwd, ".pi", "sessions", `member-${memberSlug}.jsonl`);
const client = new RpcClient({
  cwd,
  args: [
    fs.existsSync(sessionFile) ? `--session` : `--no-session`,
    ...(fs.existsSync(sessionFile) ? [sessionFile] : []),
    "--append-system-prompt", systemPromptFile,
  ],
});
```

If the process crashes, the next task starts a new `RpcClient` opening the same session file — it resumes from exactly where it left off, including all tool calls and intermediate reasoning.

This also enables a `/recap <member>` command: open the session file and summarise recent context, useful for the EM to see what a member "knows".

**Additional tradeoffs over Option B:**

| | |
|---|---|
| ✅ | Crash recovery with full context |
| ✅ | Context survives org restarts |
| ✅ | Enables `/recap`, `/compact-member` operator commands |
| ❌ | Session files can grow large; need periodic compaction policy |
| ❌ | Complicates the `/fire` command — session file should be removed or archived |
| ❌ | Multiple concurrent org sessions on the same project would conflict on the same session file (file locking needed) |

---

## Comparing the Options

| Dimension | Option A (Session Replay) | Option B (Live RPC) | Option C (Session-Backed RPC) |
|---|---|---|---|
| In-context continuity | ❌ (re-reads file) | ✅ | ✅ |
| Cross-restart continuity | ✅ | ❌ | ✅ |
| Crash resilience | ✅ | ❌ | ✅ |
| Parallelism | ✅ unchanged | ✅ safe (resolveOrScale guarantees idle) | ✅ safe (resolveOrScale guarantees idle) |
| Memory file freshness | ✅ per-task | ❌ fixed at spawn | ❌ fixed at spawn |
| Auto-compaction | ❌ manual only | ✅ native | ✅ native |
| Implementation effort | Medium (fiddly) | Low-Medium | Medium |
| Ops complexity | Low | Medium | High |

---

## Recommendation

**Implement Option B first, with the memory file problem addressed explicitly.**

Rationale:
1. The `RpcClient` is already written and exported by the framework. The core of Option B is ~100 lines of new code in `org/index.ts` and a refactor of `runTask`.
2. True in-context continuity (the actual ask) requires a live context window, not a file replay. Option A doesn't deliver the stated goal.
3. Option C's extra value (crash recovery, cross-restart) can be layered on top of Option B incrementally without architectural rework.

**The memory file injection problem must be solved as part of Option B**, not deferred. The cleanest fix:
- Stop injecting memory via system prompt at spawn time for persistent clients.
- After each task completes, send a follow-up to the client: *"Please update your memory file now."* — this is already the expected behaviour pattern, just made explicit.
- On client creation (first task), still inject the memory file content as the first `prompt()` prefix or a `followUp` before the real task.

**Parallelism**: persistent clients should be used for **all** delegation modes including parallel. `resolveOrScale()` already guarantees every member is idle before assignment — multiple parallel tasks go to multiple distinct members, each on their own `RpcClient` with no concurrency risk. The earlier recommendation to keep spawn for parallel was based on a faulty premise.

---

## Proposed ADR

```
## ADR-004: Team Member Persistence via RPC Clients

Status: Proposed

Context:
The org extension spawns a fresh pi subprocess per task. Members are stateless
between tasks. The stakeholder wants in-context continuity so members can
accumulate knowledge without externalising everything to memory files.

The pi framework ships RpcClient (dist/modes/rpc/rpc-client.js), a typed
client that keeps a pi process alive and accepts multiple sequential prompts.
This is the designed embedding API.

Decision:
Replace the per-task spawn approach in runTask() with a persistent RpcClient
per named member, stored in a module-level Map keyed by `${cwd}::${memberName}`.

- All delegation modes (single, async, parallel, chain) use persistent clients.
- Parallel mode assigns each task to a distinct idle member (enforced by
  resolveOrScale), so each RpcClient receives exactly one prompt() at a time.
- Clients are idle-reaped after 10 minutes of inactivity.
- Memory file injection moves from system-prompt-at-spawn to an explicit
  follow-up request after each task completes.
- Auto-compaction is enabled via client.setAutoCompaction(true) at creation.
- System prompt files become stable per-member files at
  .pi/prompts/members/<slug>.md rather than ephemeral temp files.

Consequences:
(+) Members carry conversation context across sequential tasks.
(+) Reduced LLM latency after first task (no cold-start file reads).
(+) Auto-compaction handles context window growth natively.
(-) Each active member consumes a long-lived node process.
(-) Crash loses in-flight context (acceptable; memory file is the safety net).
(+) No hybrid needed — one code path for all delegation modes.
(-) Memory injection timing changes require careful testing.

Future: Pair with named session files (Option C) for crash recovery.
```

---

## Open Questions

1. **Should the persistent client use `--no-session` or a named session file?** Start with `--no-session` for simplicity; file persistence can be added later.

2. **What happens when `/fire` is called on a member with a live client?** The client must be stopped and the entry removed from the map. The `/fire` command handler needs updating.

3. **Can two org extension instances (two EM sessions on the same project) conflict on the same member client?** Yes — but this is a separate concurrency concern that exists today at the file level too. Punting for now.

4. **What's the right idle timeout?** 10 minutes is a guess. Should it be configurable per member, or driven by the org session lifecycle?

5. **Does `--append-system-prompt` in `RpcClient.args` work the same way as in the current spawn?** The flag is parsed in `main.js` and passed as `appendSystemPrompt` to `createAgentSessionFromServices`. It applies to the session's initial setup. With RPC mode this happens once at start — subsequent `newSession()` calls would lose it. This needs verification.

6. **What events does `RpcClient.onEvent` emit?** These are `AgentSessionEvent` objects from `pi-agent-core`. The usage stats extraction from events (currently done from `message_end` JSON in `--mode json`) needs remapping to the RPC event format.
