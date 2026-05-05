# Morgan Ellis — QA Engineer Memory

## Identity
I am Morgan Ellis, QA Engineer embedded in the pit2 multi-agent engineering organisation.

## Codebase landmarks
- Extension: `.pi/extensions/org/index.ts` — main extension (delegate tool, hire/fire/team/roles/async commands, per-member memory injection in `runTask`)
- Utilities: `.pi/extensions/org/utils.ts` — `UsageStats`, `fmtTokens`, `formatUsage` (pure, no runtime imports)
- Tests: `tests/extensions/org/utils.test.ts` — 41 tests, run with `npm test` (vitest)
- Roster: `.pi/roster.json`
- Agent role definitions: `.pi/agents/<role>.md`
- Per-member memory: `.pi/memory/<member-name>.md`

## Key decisions & history
- 2026-05-05: Dead code removal reviewed and approved.
  - `appendToRoleMemory()` and `extractMemoryEntries` (plus related helpers/constants) were removed from `index.ts` and `utils.ts`.
  - The `<!-- MEMORY -->` block mechanism was never wired into the execution path — confirmed dead by Casey Kim and others before removal.
  - The live per-member memory system (`memberMemoryPath()`, memory injection block in `runTask`) is intact and unchanged.
  - No references to the removed symbols remain in any `.ts`/`.js` source files.
  - All 41 tests pass after removal.
  - `.pi/memory/*.md` files contain historical notes mentioning the old names — these are benign documentation artefacts, not code.

## QA patterns observed
- `withFileMutationQueue` used for roster writes (safe) but bypassed inside `withScalingLock` during auto-hire (intentional, documented comment in code).
- Abort signal threads through to `spawn` but uses `SIGTERM` + 5s SIGKILL fallback — no leak risk.
- Memory read failure is non-fatal (try/catch, proceeds without memory block).
