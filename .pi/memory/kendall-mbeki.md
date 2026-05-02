# Kendall Mbeki — Memory

## Codebase structure

- Broker implementation: `/Users/richardthombs/dev/pit2/.pi/extensions/org/broker.ts`
  - Single-file, exports a module-level `broker` singleton
  - `RunTaskFn = (config, memberName, task, cwd) => Promise<RunResult>` — single-phase black box, no multi-turn support
  - `captureResult()` has three branches: git-commit (SHA in metadata), text-fits (append-notes ≤40KB), file-offload (>.pi/task-results/<id>.md)
  - `summarise()` takes first non-empty line of output, truncated to 150 chars — used as `bd close --reason`
  - `deliverResult` callback delivers output to EM after bead is committed
  - Write serialisation: all bd writes go through `_enqueueWrite` per-cwd promise chain; `_runAndClose` itself runs outside the queue (parallel task execution)
  - `buildUpstreamContext(blockers)` — injects up to 2 000 chars of blocker notes into brief; scoped to `dependency_type === 'blocks'` only (epic-wide injection was the upstream-bleed bug, fixed in a53d534)
  - `newSession()` called on `liveClient` before each task run — clears conversation window to prevent session residue bleed between sequential tasks on the same member
  - Memory update phase: after `result.exitCode === 0`, broker sends a follow-up `liveClient.prompt()` asking agent to update memory; runs after `result.output` is already captured so memory commentary cannot affect `captureResult` or `deliverResult`

- Memory/prompt template: `/Users/richardthombs/dev/pit2/.pi/prompts/memory.md` — generic template (name/path are placeholders filled at agent creation time)

## Decisions made

- **ADR-007 (Proposed):** Use Option C (structured `<result>` block) to separate task result from memory commentary. Rationale: Option A conflicts with broker's own `captureResult` writes; Option B requires refactoring `RunTaskFn` to multi-phase; Option C is a ~5-line extraction function + brief template change with graceful fallback. See pit2-qxj for full analysis.
  - `extractResult(output)` → regex `/<result>([\s\S]*?)<\/result>/i`, fallback to full output
  - Pass `captured` (not `result.output`) to `captureResult()` and `deliverResult()`
  - Add `<result>…</result>` instruction to brief template in `_runAndClose`
  - **Residual risk (open):** `summarise()` still trusts first line of raw `result.output`; if an agent echoes upstream context at top of response, `close_reason` is still wrong. ADR-007 Option C fixes this.
