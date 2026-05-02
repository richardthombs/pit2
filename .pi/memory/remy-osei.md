# Remy Osei — Memory

## Project: pit2 (`/Users/richardthombs/dev/pit2`)

### Branch context
- Active branch is `beads-integration`. Main development of the org extension happens here.

### org extension (`/Users/richardthombs/dev/pit2/.pi/extensions/org/index.ts`)
- As of 2026-05-01 on `beads-integration`, the file already contains all four context-window-usage changes:
  - `contextPct?: number | null` on `MemberState`
  - Post-task `getSessionStats()` call in `runTaskWithStreaming()`
  - Async reaper that polls `getSessionStats()` for working members
  - `XX%` display in `buildWidgetLines()` (shown for any non-null number — threshold removed 2026-05-01; `ctx:` label prefix removed 2026-05-01)
- The file is ~1978 lines; the 50 KB read limit cuts off around line 1404.

### `setMemberStatus` helper (added 2026-05-01)
- Inserted right after `memberMemoryPath` (~line 194)
- Was accidentally omitted in the previous task (the batch that added it was rolled back; subsequent batches only fixed call sites)

### Auto-start broker on session_start (added 2026-05-02)
- `broker.start(ctx.cwd)` called in `session_start` handler immediately after `ensureBeadsInit()` (~line 937)
- `broker.start()` is now idempotent: early-returns if `this.active` is already true (guard at top of method)
- `SYSTEM.md` updated in both "How to Work" and "Required actions" sections — `bd_broker_start` no longer a required manual step; tool still available for explicit restarts
- The `bd_broker_start` tool itself also calls `broker.start()`; the idempotent guard makes that a no-op if already running

### Two-phase execution (added 2026-05-02)
- `broker.ts` `_runAndClose()` now runs a memory update phase after a successful task:
  - Calls `this.getLiveClient(cwd, memberName)?.prompt(...)` + `waitForIdle(30_000)` before updating member state
  - Wrapped in try/catch; failures log via `notifyEM` but don't affect result delivery
  - `getLiveClient` is injected via `configure()` as the last parameter (9th parameter)
- `memory.md` (`/Users/richardthombs/dev/pit2/.pi/prompts/memory.md`) updated: agents told to wait for a follow-up prompt for memory; no commentary in main response
- The edit tool can't match box-drawing `─` (U+2500) chars reliably — use Python script for those edits

### Edit tool atomicity
- When one edit in a batch fails, the ENTIRE batch is rolled back — no partial applies
- Always verify the patterns match before mixing many independent edits in one call

### `bd_task_create` tool — `blocked_by` parameter (added 2026-05-02)
- `blocked_by: Type.Optional(Type.Array(Type.String(), ...))` added to schema
- Maps to `--deps=<comma-separated IDs>` on `bd create` — bare IDs mean "new task is blocked by these"
- `bd_dep_add` description updated: now clarifies it's for already-created tasks; `blocked_by` is preferred for fan-in creation

### Key API facts
- `RpcClient` is imported from `@mariozechner/pi-coding-agent`
- `client.getSessionStats()` returns an object with `contextUsage?.percent` (number | undefined)
- `client.prompt(msg)` sends a message; `client.waitForIdle(timeoutMs)` waits for completion
- `null` is used in `memberState.contextPct` to mean "model doesn't report context usage"; `undefined` means "not yet polled"
