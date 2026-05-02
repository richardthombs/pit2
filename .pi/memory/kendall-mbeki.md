# Kendall Mbeki — Memory

## Codebase structure

- Broker implementation: `/Users/richardthombs/dev/pit2/.pi/extensions/org/broker.ts`
  - Single-file, exports a module-level `broker` singleton
  - `RunTaskFn = (config, memberName, task, cwd) => Promise<RunResult>` — single-phase black box, no multi-turn support
  - `configure()` — dependency injection, must be called before `start()`; safe to re-call on reload (replaces all injected closures in place)
  - `captureResult()` has three branches: git-commit (SHA in metadata), text-fits (append-notes ≤40KB), file-offload (>.pi/task-results/<id>.md)
  - `captureResult()` already-closed guard: `bd show` at entry; if `status === 'closed' && close_reason` exists, returns immediately (prevents overwrite on retry)
  - `close_reason` is a structured string built inline from usage stats (`Completed by <name> (<role>) — <secs>s · ↑Xk ↓Xk · $X.XXX`); no `summarise()` function exists
  - `deliverResult` callback delivers output to EM after bead is committed
  - Write serialisation: all bd writes go through `_enqueueWrite` per-cwd promise chain; `_runAndClose` itself runs outside the queue (parallel task execution)
  - `buildUpstreamContext(blockers)` — injects up to 2 000 chars of blocker notes into brief; scoped to `dependency_type === 'blocks'` only (epic-wide injection was the upstream-bleed bug, fixed in a53d534)
  - `newSession()` called on `liveClient` before each task run — clears conversation window to prevent session residue bleed between sequential tasks on the same member
  - Memory update phase: after `result.exitCode === 0`, broker sends a follow-up `liveClient.prompt()` asking the agent to update its memory file. Safe because: (a) the return value of that prompt is discarded — it cannot affect `result.output`, `captureResult`, or `deliverResult`; (b) `captureResult`/`deliverResult` are already enqueued in the write queue before this phase completes
  - `_requeueTask` — increments `failureCounts`; on count < 3 re-opens to `open`; on count ≥ 3 sets `deferred` and notifies EM (hard stop). Counters reset on `broker.start()` via `failureCounts.clear()`

- Memory/prompt template: `/Users/richardthombs/dev/pit2/.pi/prompts/memory.md` — generic template (name/path are placeholders filled at agent creation time)

## Decisions made

- **ADR-007 (Proposed):** Use Option C (structured `<result>` block) to separate task result from memory commentary. Rationale: Option A conflicts with broker's own `captureResult` writes; Option B requires refactoring `RunTaskFn` to multi-phase; Option C is a ~5-line extraction function + brief template change with graceful fallback. See pit2-qxj for full analysis.
  - `extractResult(output)` → regex `/<result>([\s\S]*?)<\/result>/i`, fallback to full output
  - Pass `captured` (not `result.output`) to `captureResult()` and `deliverResult()`
  - Add `<result>…</result>` instruction to brief template in `_runAndClose`
