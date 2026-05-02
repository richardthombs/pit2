# Morgan Ellis — QA Engineer Memory

## Project: pit2

### bd CLI facts
- `bd comment <id> <text>` (no `--add` flag; positional text or `--file`/`--stdin`)
- `bd close <id>` to mark done; `--status=done` is invalid (valid: open, in_progress, blocked, deferred, closed, pinned, hooked)
- `bd` v1.0.3 (Homebrew) at `/opt/homebrew/bin/bd`
- Storage: **Dolt embedded** (not SQLite). No `.db` files. Data in `.beads/embeddeddolt/pit2/.dolt/`. PRAGMA journal_mode does not apply.
- `BEADS_DIR` env var controls which database is used for isolation in tests.
- bd detects `test-` prefix in titles and warns to stderr ("Creating test issue in production database") — cosmetic warning, exits 0.
- `bd delete <id> --force` works for cleanup; fallback `bd update <id> --status=deferred`.

### Concurrency test findings (pit2-xcg.5.2.6 — Suite A lite, 2026-05-02)
- 5 concurrent `bd create` × 3 rounds: **0/15 failures**
- `bd ready` during 5 concurrent creates × 5 rounds: **0/5 failures**
- Sequential creates then `bd ready` × 3 rounds: **0/3 failures**
- **Conclusion:** No concurrency failures at 5-parallel-creates scale. Dolt serialises writes correctly at this load level.

### Test infrastructure
- Isolated test DB: `cp -r .beads/ /tmp/test-beads-a-lite/` + `BEADS_DIR=/tmp/test-beads-a-lite`
- Node.js test scripts work well with `execFile` + `promisify` for concurrent bd calls.

### TypeScript baseline for broker/index (as of pit2-xcg.5.3.1)
- `npx tsc --noEmit` (no local `tsc`); produces 68 TS7006 + 6 TS2307 errors — all pre-existing.
- Only acceptable new error per spec: `TS2307: Cannot find module '@mariozechner/pi-coding-agent'`.
- Use `git stash` / `git stash pop` to diff error counts against baseline when verifying "no new errors".

### broker.ts / index.ts structural notes
- `broker.configure()` is the injection point for all dependencies; constructor is empty.
- `liveMembers` map in index.ts uses key `${cwd}::${memberName}` — eviction deletes by this key.
- `_enqueueWrite` and `_enqueueMemoryPhase` are separate serialisation chains (per-cwd and per-role respectively).
- `captureResult` is now: closed-guard → 60 KB size check (throws) → `bd update --append-notes` → `bd close --reason`. All file-offload and metadata complexity removed (pit2-xcg.5.3.6).
