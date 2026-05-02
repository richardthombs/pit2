# Morgan Ellis — QA Memory

## Project: pit2 — multi-agent engineering organisation (pi extension)

### Codebase Landmarks
- Extension entry: `.pi/extensions/org/index.ts`
- Pure utilities: `.pi/extensions/org/utils.ts` (no pi-runtime deps — safe to test in isolation)
- Team roster: `.pi/roster.json` (managed via `loadRoster`/`saveRoster`)
- Agent role definitions: `.pi/agents/<role>.md` (frontmatter + body)
- Member memory files: `.pi/memory/<member-id>.md` (free-form; owned by the agent itself)

### Architecture Notes
- Memory is per-member (free-form files), not per-role structured blocks — was refactored from the latter
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

### Beads Integration A — merged (branch: beads-integration)
- `runBd()` helper: `execFile` with `BEADS_DIR=<cwd>/.beads` env, `timeout: 15_000`
- `ensureBeadsInit()`: checks `beadsReady.has(cwd)` first; if `.beads/` dir exists skips init; uses `--stealth --non-interactive`; non-fatal (notifyFn on failure)
- `beadsReady` Map<string, boolean> at module scope; `beadsGuard()` inside export default fn
- All 7 tools registered between `fire` tool and `delegate` tool
- `bd dep add` arg order: `["dep", "add", blocked_id, blocker_id]` (blocked first)
- `bd close` + `bd update` responses are arrays — parsed with `[0]`; `bd create` is a single object
- `bd close` flag is `--reason` (not `--close-reason`); `--close-reason` is an unknown flag and will error
- `bd_list` uses `--limit=0` (avoids 50-item default cap) and `--status=open,in_progress` default
- `bd create --deps=id1,id2` (bare IDs, no type prefix) defaults to `dependency_type: "blocks"` — the listed IDs block the newly created task (correct direction for a `blocked_by` parameter). Verified by live test.
- `bd_task_create` now has `blocked_by: Type.Optional(Type.Array(Type.String()))` → `--deps=${params.blocked_by.join(',')}` when provided and non-empty; `bd_dep_add` description updated to steer agents toward `blocked_by` for fan-in creation
- Known open: `beads.role` not set after init → stderr warning on every `bd` call (non-blocking, cosmetic)
- Known open: `design` param silently dropped when `status === "closed"` in `bd_task_update`

### Beads Integration B — Broker (branch: beads-integration)
- `broker.ts` exports `Broker` class + module-level singleton (`export const broker = new Broker()`)
- Deps injected via `broker.configure(runBd, resolveOrScale, runTask, memberState, notifyEM)` — called in `export default fn` in index.ts
- `broker.start(cwd)` / `broker.stop()` — stop called in `session_shutdown`; start now also called automatically in `session_start` after `ensureBeadsInit()`
- `broker.start()` is idempotent: `if (this.active) return;` guard as first line — safe to call multiple times; does NOT update `activeCwd` if already active
- `_enqueueWrite(cwd, fn)` serialises all bd writes per-cwd; stores `next.catch(() => {})` to keep chain alive
- `buildUpstreamContext` is now a `private` method on `Broker` class (was previously module-level export)
- `resolveOrScale` has 4 params: `(cwd, memberState, memberName|undefined, roleName|undefined)` — no `liveMembers` param (dead param was removed); loads roster internally
- ~~notification spam after 3 task failures~~ — FIXED: `_requeueTask` uses `--status=deferred` on 3rd failure; deferred tasks don't appear in `bd ready` so no repeat `notifyEM` fires
- ~~`failureCounts` not reset on `broker.start()`~~ — FIXED: `start()` calls `this.failureCounts.clear()`
- `captureResult` closes AFTER artifact capture (spec pseudocode says close-then-capture, impl is safer)
- `onTaskUpdated` has extra `taskId` param vs design spec — both call site and handler are consistent
- `captureResult` Fix: `remaining` initialised to `0` before try; silent catch forces file-offload on `bd show` failure; both `TEXT_CAP` and `remaining` gates required for notes append — reviewed & confirmed correct
- `captureResult` Fix: `.catch(notifyEM)` on captureResult inside `_enqueueWrite` fires before the chain's blanket swallower — reviewed & confirmed correct
- ~~Residual gap D (error-recovery overwrite)~~ — FIXED (commit a53d534): guard at top of `captureResult` does `bd show` and returns early if `status === "closed" && close_reason` truthy; `bd close` "not found" errors now swallowed (treated as success). `newSession()` also called before each task dispatch to clear prior context window (addresses gap B).
- ~~Duplicate `newSession()` calls~~ — FIXED: "1b" block (`liveClientForReset`) removed; single `liveClient.newSession()` call remains before `runTask`.
- Pre-existing (not fixed): `--append-notes=VALUE` (single arg) in text-fit path vs `--append-notes` + VALUE (two args) in file-offload path — format inconsistency
- Pre-existing (not fixed): two sequential `bd update` calls in file-offload path not atomic; partial failure leaves notes/metadata inconsistent

### Broker Callback Wiring — broker-only dispatch change (reviewed)
- `Broker.configure()` now has 9 params: original 5 + `deliverResult(taskId, taskTitle, role, memberName, output)`, `scheduleDoneReset(memberName)`, `accumulateMemberUsage(memberName, usage)`, `getLiveClient(cwd, memberName) => RpcClient | undefined`
- `getLiveClient` wired in index.ts as `(cwd, memberName) => liveMembers.get(liveMemberKey(cwd, memberName))?.client`
- `deliverResult` format: `` **Task completed: ${taskTitle}**\nBead `${taskId}` · Role: ${role} · Member: ${memberName}\n\n${output} ``
- Old module-level `deliverResult` was removed along with delegate tool (see delegate tool removal section)
- `RunTaskFn` in broker.ts is 4-arg only — no signal/onProgress; broker-dispatched tasks cannot be cancelled via abort signal (pre-existing limitation)
- `SYSTEM.md` EM identity is `.pi/SYSTEM.md` (not `.pi/agents/SYSTEM.md`)

### description field gap — FIXED
- `bd_task_create` now has `description: Type.Optional(...)` param → `--description=${params.description}` when provided
- `_runAndClose` brief template now says "title, description, design, acceptance criteria" + "The description field contains the full task specification."

### delegate tool removal (reviewed)
- `delegate` tool, `DelegateParams`, `AssigneeFields`, `asyncMode`, `/async` command, and delegate-specific `deliverResult(memberName, roleName, content)` all removed
- `setMemberStatus()` is now dead code (was only called by delegate async paths) — non-blocking
- File header JSDoc comment still references `delegate` tool — cosmetic, non-blocking
- `resolveOrScale`, all beads tools, all team mgmt commands/tools intact
- `broker.configure()` call site clean — no references to removed items
- No new TS errors (all errors are pre-existing TS2307 module resolution + TS7006 implicit any)

### Context Usage Polling
- `runTaskWithStreaming` captures `contextPct` post-task via `entry.client.getSessionStats()`
- Reaper `setInterval` (60s) also polls all `liveMembers` — fix landed as uncommitted working-tree change: removed `status !== "working"` filter, added `?? { status: "idle" }` fallback
- `contextPct`: `undefined` = not polled, `null` = model doesn't report, `number` = percentage
- Widget renders `ctx:XX%` unconditionally when `contextPct` is a number (threshold removed in `66905af`)

### Broker Fan-out/Fan-in — Memory Contamination (FIXED & VERIFIED)
- Original failure: agents write memory-update reasoning as final message, displacing actual deliverable; `captureResult` captures whatever the model's final message is
- Confirmed broken via pit2-qob: Alex Rivera (pit2-qob.1) and Remy Osei (pit2-qob.4) returned memory-update paragraphs instead of their ocean word
- Fix: two-phase execution approach
- Verified fixed via pit2-1kb: all four upstream tasks (.1–.4) returned clean single-word `close_reason` values; no prose contamination in any deliverable
- **Residual gap A (pit2-3jx):** two-phase fix guards against agent's own memory-update prose, but NOT against upstream task output appearing at the top of the assistant response window. In pit2-3jx.3, notes opened with `**Persistent**` (matching .1's output) before the agent's own "cleansing" answer; `close_reason` captured the contaminated prefix. Root cause: prior task output bleeding into the agent's context/response, not the agent's own memory phase.
- **Residual gap B (pit2-52r — parallel stress):** under 25-task parallel load, broker dispatched multiple tasks to the same member sequentially; prior task's result remained in the context window. In pit2-52r.3, agent produced cross-agent commentary as its phase-1 first message — captured verbatim as `close_reason`. Two-phase fix cannot help when phase-1 itself is contaminated by prior task context. Confirmed again in pit2-52r.17: notes showed three injections of "Profound" (from .16 context), but close_reason was correctly captured as "Ineffable" — two-phase capture held despite note contamination.
- **Residual gap C (pit2-52r — double/triple dispatch):** pit2-52r.1 notes contained two stacked responses (double dispatch); pit2-52r.17 (Sam Chen / pi-specialist) contained three stacked responses (triple dispatch) on the same stress run. Pattern: dispatches 2+ append to notes but bead close race means only the Nth-to-close dispatch sets `close_reason`. Delivered word was clean in both cases but capacity waste is significant and worsening.
- ~~**Residual gap D** (error-recovery overwrite)~~ — FIXED in commit a53d534 (see captureResult notes above). The `bd close` race condition is also fixed via "not found" catch.
- **File-offload path verified (pit2-52r.14):** result written to `.pi/task-results/<bead-id>.md`, notes = `[Full output written to file — see metadata.result_file]`, metadata.result_file set correctly. Works under parallel stress load. ✓

### beads CLI flag gotcha
- `bd close` reason flag is `-r` / `--reason`, NOT `--close-reason` (returns "unknown flag" error)

### Known Open Items (non-blocking)
- `fmtTokens` imported in `index.ts` but never used — dead import, should be cleaned up
- `MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `extractMemoryEntries()` remain as dead exports in `utils.ts` — harmless
