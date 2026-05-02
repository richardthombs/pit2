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
- `_runAndClose()` drives the full task lifecycle: newSession → runTask → enqueue memory phase (fire-and-forget) → state update → captureResult/deliverResult
- Memory phase is now fire-and-forget via `_enqueueMemoryPhase(roleSlug, fn)` — same chain pattern as `_enqueueWrite` but keyed by role slug, not cwd

### Memory: per-role shared files (ADR-008, implemented pit2-nbc.1)
- Memory files are now `.pi/memory/<role-slug>.md` (e.g. `typescript-engineer.md`), NOT per-member
- `roleMemoryPath(cwd, roleSlug)` replaces the old `memberMemoryPath(cwd, memberName)` in `index.ts`
- `initializeClientMemory(client, memberName, cwd, config)` — takes `config: AgentConfig` as 4th param; reads from `roleMemoryPath(cwd, config.name)`
- `buildMemberSystemPromptFile()` injects `roleMemoryPath(cwd, config.name)` into the system prompt
- `/fire` command and `fire` tool do NOT delete the memory file (it's shared); only `memberSystemPromptPath` is cleaned up on fire
- `broker.memoryPhaseQueue: Map<string, Promise<void>>` serialises phase-2 per role slug; cleared in `broker.start()`
- Startup advisory: `session_start` checks for legacy per-member files and warns the EM if the role file is missing

### Key API facts
- `RpcClient` is imported from `@mariozechner/pi-coding-agent`
- `client.getSessionStats()` returns an object with `contextUsage?.percent` (number | undefined)
- `client.prompt(msg)` sends a message; `client.waitForIdle(timeoutMs)` waits for completion
- `client.newSession()` clears the conversation window while keeping the RpcClient process alive
- `bd_task_create` tool accepts `blocked_by: string[]` — maps to `--deps=<comma-separated IDs>`; prefer this over `bd_dep_add` when creating tasks that are immediately blocked

### Tooling gotchas
- **Edit tool atomicity:** when one edit in a batch fails, the entire batch is rolled back — no partial applies. Verify patterns before mixing many independent edits in one call.
- **Edit tool uniqueness:** when the same line appears in two functions (e.g. `const memPath = ...`), include surrounding unique context (e.g. the function signature or a unique comment) to disambiguate.
- **Box-drawing characters:** the edit tool can't reliably match `─` (U+2500) and similar box-drawing chars — use a Python script for those edits instead.
