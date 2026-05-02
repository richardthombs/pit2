# Morgan Ellis — QA Memory

## Project: pit2 — multi-agent engineering organisation (pi extension)

### Codebase Landmarks
- Extension entry: `.pi/extensions/org/index.ts`
- Pure utilities: `.pi/extensions/org/utils.ts` (no pi-runtime deps — safe to test in isolation)
- Team roster: `.pi/roster.json` (managed via `loadRoster`/`saveRoster`)
- Agent role definitions: `.pi/agents/<role>.md` (frontmatter + body)
- Member memory files: `.pi/memory/<member-id>.md` (free-form; owned by the agent itself)

### Architecture Notes
- Memory is per-member (free-form files), not per-role structured blocks
- System prompt per member written to `.pi/prompts/members/<slug>.md` by `buildMemberSystemPromptFile()`
- Memory template at `.pi/prompts/memory.md` — has `[name]` and `[path]` placeholders; loaded by `runTask()` via `fs.readFileSync` with a hardcoded fallback string if the file is missing

### Persistent RpcClient per Member
- `runTask()` uses a persistent `RpcClient` per named member (not a fresh spawn per task)
- Key functions: `getOrCreateClient()`, `stopLiveClient()`, `reapIdleClients()`, `initializeClientMemory()`, `liveMemberKey()`, `memberSystemPromptPath()`
- `liveMembers` Map holds `LiveMemberEntry` (client + lastUsed timestamp)
- Memory injected once as first assistant message (`initializeClientMemory`), not on every task
- Idle reaper: 60s interval, `TASK_IDLE_TIMEOUT_MS = 600_000` (10 min); started in `session_start`, torn down in `session_shutdown`
- `/fire` and `fire` tool both call `stopLiveClient()` + delete the system prompt file
- `RpcClient.newSession(parentSession?)` — sends `{ type: "new_session" }`, returns `{ cancelled: boolean }`. Used by broker to clear context window between tasks. Return value is ignored in broker (non-fatal catch handles errors).

### Beads Integration — Tool Registration
- `runBd()` helper: `execFile` with `BEADS_DIR=<cwd>/.beads` env, `timeout: 15_000`
- `ensureBeadsInit()`: checks `beadsReady.has(cwd)` first; if `.beads/` dir exists skips init; uses `--stealth --non-interactive`; non-fatal (notifyFn on failure)
- `beadsReady` Map<string, boolean> at module scope; `beadsGuard()` inside export default fn
- All 7 beads tools registered between `fire` tool and the team-management tools (delegate tool was removed)
- `bd dep add` arg order: `["dep", "add", blocked_id, blocker_id]` (blocked first)
- `bd close` + `bd update` responses are arrays — parsed with `[0]`; `bd create` is a single object
- `bd close` flag is `--reason` (not `--close-reason`); `--close-reason` is an unknown flag and will error
- `bd_list` uses `--limit=0` (avoids 50-item default cap) and `--status=open,in_progress` default
- `bd create --deps=id1,id2` (bare IDs, no type prefix) defaults to `dependency_type: "blocks"` — the listed IDs block the newly created task (correct direction for a `blocked_by` parameter)
- `bd_task_create` has `blocked_by: Type.Optional(Type.Array(Type.String()))` → `--deps=${params.blocked_by.join(',')}` when provided and non-empty
- `bd_task_create` has `description: Type.Optional(...)` param → `--description=${params.description}` when provided
- Known open: `beads.role` not set after init → stderr warning on every `bd` call (non-blocking, cosmetic)
- Known open: `design` param silently dropped when `status === "closed"` in `bd_task_update`

### Beads Integration — Broker
- `broker.ts` exports `Broker` class + module-level singleton (`export const broker = new Broker()`)
- Deps injected via `broker.configure(...)` — called in `export default fn` in index.ts (9 params total)
- `broker.configure()` params: `runBd`, `resolveOrScale`, `runTask`, `memberState`, `notifyEM`, `deliverResult(taskId, taskTitle, role, memberName, output)`, `scheduleDoneReset(memberName)`, `accumulateMemberUsage(memberName, usage)`, `getLiveClient(cwd, memberName) => RpcClient | undefined`
- `broker.start(cwd)` / `broker.stop()` — stop called in `session_shutdown`; start called automatically in `session_start` after `ensureBeadsInit()`
- `broker.start()` is idempotent: `if (this.active) return;` guard; does NOT update `activeCwd` if already active; clears `failureCounts`
- `SYSTEM.md` EM identity is `.pi/SYSTEM.md` (not `.pi/agents/SYSTEM.md`)

### Broker — Polling & Dispatch
- Primary trigger: `onTaskUpdated(cwd, taskId)` event (event-driven); safety-net: 30s `setTimeout` via `_schedulePoll()`
- `_poll()` runs `bd ready --type=task --json` → returns array of `BeadsTask[]` (tasks with all blockers resolved and status `open`/`in_progress`)
- `_enqueueWrite(cwd, fn)` serialises all bd writes per-cwd; chain kept alive with `next.catch(() => {})`
- `buildUpstreamContext` is a `private` method on `Broker` class
- `resolveOrScale` has 4 params: `(cwd, memberState, memberName|undefined, roleName|undefined)` — loads roster internally

### Broker — `_runAndClose` Brief Template
```
Your task is described in bead ${task.id}.
Retrieve the full details (title, description, design, acceptance criteria) with:
  BEADS_DIR=${beadsDir} bd show ${task.id} --json
The description field contains the full task specification.
Then ${verb} as specified.
```
Where `verb` comes from `Broker.ROLE_VERBS[role] ?? "complete"` (e.g. "test", "implement", etc.)

### Broker — Two-Phase Execution
- Phase 1: `runTask()` called with brief → agent produces deliverable; result captured immediately
- Phase 2 (memory update): if exit code 0 and `liveClient` exists, `liveClient.prompt("Memory update phase: review your memory file and update it if anything from the task you just completed is worth recording. Do not include any other commentary.")` + `waitForIdle(30_000)`. Phase-2 errors are notified but non-fatal.
- Capture happens between phases — phase-2 output cannot contaminate the delivered result

### Broker — Failure & Error Handling
- 3-strike failure policy: on 3rd failure `_requeueTask` sets `--status=deferred`; deferred tasks don't appear in `bd ready` so no repeat `notifyEM` fires
- Error-recovery overwrite guard (commit a53d534): `captureResult` does `bd show` first; if `status === "closed" && close_reason` truthy, returns early. `bd close` "not found" errors swallowed (treated as success).
- Notification spam fix, failureCounts reset fix, duplicate `newSession()` fix — all resolved

### Broker — captureResult
- `captureResult` closes AFTER artifact capture (safer than close-then-capture)
- `remaining` initialised to `0` before try; silent catch forces file-offload on `bd show` failure
- Both `TEXT_CAP` and `remaining` gates required for notes append
- Pre-existing (not fixed): `--append-notes=VALUE` (single arg) in text-fit path vs `--append-notes` + VALUE (two args) in file-offload path — format inconsistency
- Pre-existing (not fixed): two sequential `bd update` calls in file-offload path not atomic
- File-offload path: result written to `.pi/task-results/<bead-id>.md`; notes = `[Full output written to file — see metadata.result_file]`

### Broker — Context Contamination
- **Root cause:** prior task output bleeds into the agent's context window when sequential tasks run on the same member; `newSession()` before each dispatch is the primary mitigation
- **Two-phase fix guards against:** agent's own memory-update prose displacing the deliverable
- **Two-phase fix does NOT guard against:** upstream task output appearing at top of assistant response window (context not fully cleared); confirmed under parallel stress load
- **close_reason formatting sensitivity:** if agent puts word and sentence on same line, entire line becomes `close_reason`. If word is its own paragraph, only the word is captured. Not a code bug — a response-formatting issue.
- **Double/triple dispatch under load:** concurrent dispatches can stack responses; all append to notes but only the last-to-close sets `close_reason`. Delivered result is usually clean, but capacity waste grows.
- **File-offload path:** verified working under parallel stress load ✓

### delegate tool removal
- `delegate` tool, `DelegateParams`, `AssigneeFields`, `asyncMode`, `/async` command removed
- `setMemberStatus()` is now dead code — non-blocking
- File header JSDoc comment still references `delegate` tool — cosmetic, non-blocking

### Context Usage Polling
- `runTaskWithStreaming` captures `contextPct` post-task via `entry.client.getSessionStats()`
- Reaper `setInterval` (60s) also polls all `liveMembers` — `status !== "working"` filter removed; `?? { status: "idle" }` fallback added
- `contextPct`: `undefined` = not polled, `null` = model doesn't report, `number` = percentage
- Widget renders `ctx:XX%` unconditionally when `contextPct` is a number (threshold removed)

### Known Open Items (non-blocking)
- `fmtTokens` imported in `index.ts` but never used — dead import
- `MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `extractMemoryEntries()` remain as dead exports in `utils.ts` — harmless
