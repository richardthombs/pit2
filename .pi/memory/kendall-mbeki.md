# Kendall Mbeki — Memory

## Codebase structure

- Broker implementation: `/Users/richardthombs/dev/pit2/.pi/extensions/org/broker.ts`
  - Single-file, exports a module-level `broker` singleton
  - `RunTaskFn = (config, memberName, task, cwd) => Promise<RunResult>` — single-phase black box, no multi-turn support
  - `captureResult()` has three branches: git-commit (SHA in metadata), text-fits (append-notes ≤40KB), file-offload (>.pi/task-results/<id>.md)
  - `summarise()` takes first non-empty line of output, truncated to 150 chars — used as `bd close --reason`
  - `deliverResult` callback delivers output to EM after bead is committed
  - Write serialisation: all bd writes go through `_enqueueWrite` per-cwd promise chain; `_runAndClose` itself runs outside the queue (parallel task execution)

- Memory/prompt template: `/Users/richardthombs/dev/pit2/.pi/prompts/memory.md` — generic template (name/path are placeholders filled at agent creation time)

## Decisions made

- **ADR-007 (Proposed):** Use Option C (structured `<result>` block) to separate task result from memory commentary. Rationale: Option A conflicts with broker's own `captureResult` writes; Option B requires refactoring `RunTaskFn` to multi-phase; Option C is a ~5-line extraction function + brief template change with graceful fallback. See pit2-qxj for full analysis.
  - `extractResult(output)` → regex `/<result>([\s\S]*?)<\/result>/i`, fallback to full output
  - Pass `captured` (not `result.output`) to `captureResult()` and `deliverResult()`
  - Add `<result>…</result>` instruction to brief template in `_runAndClose`
