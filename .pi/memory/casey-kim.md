# Casey Kim — Memory

## Identity
TypeScript engineer specialising in pi coding agent extensions. Part of the pit2 multi-agent engineering organisation.

## Project: pit2
- Location: /Users/richardthombs/dev/pit2
- Framework: @mariozechner/pi-coding-agent
- Language: TypeScript (via jiti — no compilation step)
- Schema: typebox for tool parameters

## Key codebase landmarks
- `.pi/extensions/org/index.ts` — main org extension: roster helpers, `getOrCreateClient`, `runTask`, `delegate` tool, `/hire`/`/fire`/`/team`/`/roles` commands, `liveMembers` map.
- `.pi/extensions/org/utils.ts` — shared utilities: `UsageStats`, `formatUsage`, `fmtTokens`, plus memory helpers (`MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `extractMemoryEntries`) that are no longer imported by `index.ts`.
- `.pi/prompts/memory.md` — external template for the memory identity block injected into member system prompts. Uses `[name]` and `[path]` placeholders; `runTask()` loads it with a silent fallback to a hardcoded string on read error.
- `.pi/prompts/members/<slug>.md` — per-member stable system-prompt files written by `buildMemberSystemPromptFile()`; deleted on `stopLiveClient()`.

## Persistent RpcClient architecture
Each live member gets one long-running `RpcClient`, stored in `liveMembers: Map<string, LiveMemberEntry>` keyed `cwd::memberName`.

Key decisions and gotchas:
- **Bun guard**: `process.argv[1]?.startsWith("/$bunfs/root/")` — throw early if running under bun (RpcClient incompatible).
- **`@mariozechner/pi-ai` imports**: NOT a direct dep of pit2. Only safe as `import type` — jiti erases it at runtime. It lives in pi-coding-agent's nested node_modules.
- **`RpcClientOptions`**: exported from `@mariozechner/pi-coding-agent` root (confirmed in `dist/index.d.ts`).
- **`getOrCreateClient()`**: writes system-prompt file, calls `client.start()` + `setAutoCompaction(true)`, attaches exit listener via `(client as any).process`.
- **`initializeClientMemory()`**: sends memory file contents as a first message, guarded by `entry.initialized`. Wrapped in try/catch — failure calls `stopLiveClient()` then rethrows (clean up broken clients immediately).
- **`reapIdleClients()`**: 10-min idle timeout (`TASK_IDLE_TIMEOUT_MS = 600_000`), checked every 60s via a module-level `reaperInterval`.
- **`runTask()`**: streams via `onEvent()`, awaits `waitForIdle(600_000)`, calls `client.abort()` on cancel. Crash removes entry from map and throws a wrapped error including the original `.cause` and `err.message`.
- **`stopLiveClient()`**: called by `/fire` command and `fire` tool before roster splice; also deletes the member's system-prompt file.
- **`delegate` tool**: manager-layer only. Not available to team members; we are on the receiving end.

## Step 3 — broker integration into index.ts
- broker.ts: replaced constructor-with-params with no-arg constructor + `configure(runBd, resolveOrScale, runTask, memberState, notifyEM)` method using `!` definite-assignment fields; added `export const broker = new Broker()` singleton at end of file
- index.ts import changed from `{ Broker }` to `{ broker }`
- `const broker = new Broker(...)` replaced with `broker.configure(...)` (same deps, same position in extension function)
- `bd_task_update` hook: removed `params.status === "open"` guard from index.ts; broker.onTaskUpdated now always called when `broker.active`; passes `params.status ?? ""` (broker internally filters on status === "open")
- `bd_task_create` and `bd_broker_start` were already fully implemented; no changes needed there

## Step 2 — broker.ts rewrite (on `beads-integration` branch)
- Existing skeleton was mostly correct; three key fixes applied:
  1. `pollTimer` → `pollingInterval` (task spec naming)
  2. `captureResult` signature: `(cwd, taskId, output, commitBefore)` — `commitAfter` computed inside via `getHeadCommit`
  3. file-change path uses `--set-metadata git_commit=<sha>`; large-output uses `--set-metadata result_file=<path>` (design doc §17.3 pattern)
- `liveKeys` and `writeQueue` are NOT private (task spec says they're visible properties)
- `buildUpstreamContext` exported as a named export (module-level function)
- `extractBlockerContext` is module-level but not exported (called only by `buildUpstreamContext`)
- Broker constructor signature: `(runBd, resolveOrScale, runTask, memberState, notifyEM)` — matches index.ts instantiation
- `_dispatchCycle` is called inside the write queue to serialise claims; `_runAndClose` fires outside it (agents run in parallel)

## Step 1 of broker refactor (on `beads-integration` branch)
- `resolveOrScale` extracted to module scope (was also defined as closure inside `delegate`'s execute)
- New module-scope signature: `(cwd, memberState, liveMembers, memberName, roleName)` — all positional, no optionals
- Broker lambda updated to: `(cwd, ms, role) => resolveOrScale(cwd, ms, liveMembers, undefined, role)`
- `liveMembers` is module-scope but passed as param so broker (and future callers) can use it without closure access
- The closure version had `updateWidget(ctx)` inside auto-hire path; dropped in extraction (callers always call updateWidget after anyway)

## Beads Integration A (implemented on `beads-integration` branch)
Spec: `.pi/docs/spec-beads-integration-a.md` | Reference: `.pi/docs/beads-em-reference.md`

### What was added to `index.ts`
- `execFile as execFileCb` added to child_process import; `promisify` from node:util; `const execFile = promisify(execFileCb)` at module scope.
- `runBd(cwd, args)` — module-scope helper; sets `BEADS_DIR=<cwd>/.beads` in env; 15s timeout.
- `beadsReady: Map<string, boolean>` — module-scope registry keyed by cwd.
- `ensureBeadsInit(cwd, notifyFn)` — idempotent; checks `fs.existsSync(beadsDir)` first; calls `bd init --stealth --non-interactive`; non-fatal on error.
- `session_start` handler: `await ensureBeadsInit(ctx.cwd, ...)` added after reaper setup.
- `beadsGuard(cwd)` — inline function inside `export default fn`; returns error result if `beadsReady.get(cwd) !== true`.
- 7 tools registered between `fire` and `delegate`: `bd_workstream_start`, `bd_task_create`, `bd_task_update`, `bd_dep_add`, `bd_list`, `bd_show`, `bd_ready`.

### Critical bd CLI gotchas
- **`bd dep add` order**: `bd dep add <blocked-id> <blocker-id>` — dependent FIRST, prerequisite SECOND. Wrong order silently inverts the dep.
- **No `done` status**: valid values are `open`, `in_progress`, `blocked`, `deferred`, `closed`.
- **`bd update` and `bd show` return arrays**: parse with `[0]`. Only `bd create` returns a single object.
- **`bd close` vs `bd update --status=closed`**: use `bd close --reason=...` to set `closed_at` correctly.
- **`--append-notes`**: appends with newline separator (safer than `--notes` which replaces).
- **`--status` multi-value**: comma-separated only (`open,in_progress`). Repeating the flag returns empty array.
- **`--limit=0`**: add to `bd list` to bypass the 50-result default cap.
- **`--non-interactive`**: required for `bd init` when stdin is not a TTY (always the case in execFile).
- **`bd ready` includes epics**: use `--type=task` to filter to delegatable tasks only.
