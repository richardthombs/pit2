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

### Beads Integration A — merged (branch: beads-integration)
- `runBd()` helper: `execFile` with `BEADS_DIR=<cwd>/.beads` env, `timeout: 15_000`
- `ensureBeadsInit()`: checks `beadsReady.has(cwd)` first; if `.beads/` dir exists skips init; uses `--stealth --non-interactive`; non-fatal (notifyFn on failure)
- `beadsReady` Map<string, boolean> at module scope; `beadsGuard()` inside export default fn
- All 7 tools registered between `fire` tool and `delegate` tool
- `bd dep add` arg order: `["dep", "add", blocked_id, blocker_id]` (blocked first)
- `bd close` + `bd update` responses are arrays — parsed with `[0]`; `bd create` is a single object
- `bd_list` uses `--limit=0` (avoids 50-item default cap) and `--status=open,in_progress` default
- Known open: `beads.role` not set after init → stderr warning on every `bd` call (non-blocking, cosmetic)
- Known open: `design` param silently dropped when `status === "closed"` in `bd_task_update`

### Beads Integration B — Broker (branch: beads-integration)
- `broker.ts` exports `Broker` class + module-level singleton (`export const broker = new Broker()`)
- Deps injected via `broker.configure(runBd, resolveOrScale, runTask, memberState, notifyEM)` — called in `export default fn` in index.ts
- `broker.start(cwd)` / `broker.stop()` — stop called in `session_shutdown`
- `_enqueueWrite(cwd, fn)` serialises all bd writes per-cwd; stores `next.catch(() => {})` to keep chain alive
- `buildUpstreamContext` is now a `private` method on `Broker` class (was previously module-level export)
- `resolveOrScale` has 4 params: `(cwd, memberState, memberName|undefined, roleName|undefined)` — no `liveMembers` param (dead param was removed); loads roster internally
- ~~notification spam after 3 task failures~~ — FIXED: `_requeueTask` uses `--status=deferred` on 3rd failure; deferred tasks don't appear in `bd ready` so no repeat `notifyEM` fires
- ~~`failureCounts` not reset on `broker.start()`~~ — FIXED: `start()` calls `this.failureCounts.clear()`
- `captureResult` closes AFTER artifact capture (spec pseudocode says close-then-capture, impl is safer)
- `onTaskUpdated` has extra `taskId` param vs design spec — both call site and handler are consistent
- `captureResult` Fix: `remaining` initialised to `0` before try; silent catch forces file-offload on `bd show` failure; both `TEXT_CAP` and `remaining` gates required for notes append — reviewed & confirmed correct
- `captureResult` Fix: `.catch(notifyEM)` on captureResult inside `_enqueueWrite` fires before the chain's blanket swallower — reviewed & confirmed correct
- Pre-existing (not fixed): `--append-notes=VALUE` (single arg) in text-fit path vs `--append-notes` + VALUE (two args) in file-offload path — format inconsistency
- Pre-existing (not fixed): two sequential `bd update` calls in file-offload path not atomic; partial failure leaves notes/metadata inconsistent

### Broker Callback Wiring — broker-only dispatch change (reviewed)
- `Broker.configure()` now has 8 params: original 5 + `deliverResult(taskId, taskTitle, role, memberName, output)`, `scheduleDoneReset(memberName)`, `accumulateMemberUsage(memberName, usage)`
- `deliverResult` format: `` **Task completed: ${taskTitle}**\nBead `${taskId}` · Role: ${role} · Member: ${memberName}\n\n${output} ``
- Old module-level `deliverResult(memberName, roleName, content)` still present in index.ts — used by `delegate` async paths; different message format. Divergence is intentional until delegate is removed.
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

### Known Open Items (non-blocking)
- `fmtTokens` imported in `index.ts` but never used — dead import, should be cleaned up
- `MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `extractMemoryEntries()` remain as dead exports in `utils.ts` — harmless
