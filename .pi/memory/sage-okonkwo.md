# Sage Okonkwo — Memory

## Project: pit2 / beads-integration

### Broker (`/.pi/extensions/org/broker.ts`)

- **Sole write serialiser**: all `bd` writes go through `_enqueueWrite` → per-cwd promise chain (`writeQueue`). The chain's `.catch(() => {})` swallows errors to keep the chain alive — this means lambdas passed to `_enqueueWrite` must handle their own errors if surfacing them matters.
- **`captureResult` branching** (as of the bug-fix commit):
  1. File-change (new git commit): record SHA in metadata.
  2. Text output: first fetch current notes length via `bd show <id> --json` → compute `remaining = 50_000 - currentNotesLength`. If `output.length <= TEXT_CAP (40 KB) && output.length <= remaining` → append notes. Otherwise → file-offload to `.pi/task-results/<id>.md` + metadata.result_file.
  3. If `bd show` fails → `remaining = 0` → always file-offload (safe fallback).
- **`bd show --json` response shape**: returns an array; use `(JSON.parse(stdout) as any[])[0]`. Notes are at `.notes` (string | null | undefined).
- **Failure counter** (`failureCounts`): in-memory per task ID, hard-stops at 3. Cleared on `broker.start()`. Third failure defers the task instead of re-opening it.
- **`_runAndClose`** runs outside the write queue (agents execute in parallel); results are re-enqueued via `_enqueueWrite` only for the bd write step.

### Patterns
- `tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck <file>` works for quick TS validation without a tsconfig.
