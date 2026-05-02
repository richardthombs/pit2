# Remy Osei — Memory

## Project: pit2 (`/Users/richardthombs/dev/pit2`)

### Branch context
- Active branch is `beads-integration`. Main development of the org extension happens here.

### Key files
- **org extension:** `/Users/richardthombs/dev/pit2/.pi/extensions/org/index.ts` (~1978 lines; 50 KB read limit cuts off around line 1404 — use offset to read the rest)
- **broker:** `/Users/richardthombs/dev/pit2/.pi/extensions/org/broker.ts`
- **utils:** `/Users/richardthombs/dev/pit2/.pi/extensions/org/utils.ts`
- **Tests:** only `tests/extensions/org/utils.test.ts` — no tests for broker or index

### org extension structure
- `MemberState` holds per-member runtime state including `contextPct?: number | null` (null = model doesn't report usage; undefined = not yet polled)
- `broker.configure()` is called inside the `export default function(pi)` body in `index.ts` — it injects closure-scoped deps (runBd, resolveOrScale, runTaskWithStreaming, memberState, notifyEM, deliverResult, scheduleDoneReset, newSession, getLiveClient)
- `broker.start(cwd)` is called in the `session_start` handler (inside `export default`) immediately after `ensureBeadsInit()`; `start()` is idempotent — early-returns if already active

### broker.ts structure
- `configure()` injects dependencies rather than the constructor (module-level singleton pattern)
- `getLiveClient` is the 9th parameter to `configure()`, injected so broker can call `newSession()` and `prompt()` on members
- `_runAndClose()` is the private method that drives the full task lifecycle: newSession → runTask → memory-update phase → state update
- Two-phase execution: after a successful task, `_runAndClose` prompts the member's live client with a memory-update message and calls `waitForIdle(30_000)` before marking the member idle

### Key API facts
- `RpcClient` is imported from `@mariozechner/pi-coding-agent`
- `client.getSessionStats()` returns an object with `contextUsage?.percent` (number | undefined)
- `client.prompt(msg)` sends a message; `client.waitForIdle(timeoutMs)` waits for completion
- `client.newSession()` clears the conversation window while keeping the RpcClient process alive
- `bd_task_create` tool accepts `blocked_by: string[]` — maps to `--deps=<comma-separated IDs>`; prefer this over `bd_dep_add` when creating tasks that are immediately blocked

### Tooling gotchas
- **Edit tool atomicity:** when one edit in a batch fails, the entire batch is rolled back — no partial applies. Verify patterns before mixing many independent edits in one call.
- **Box-drawing characters:** the edit tool can't reliably match `─` (U+2500) and similar box-drawing chars — use a Python script for those edits instead.
