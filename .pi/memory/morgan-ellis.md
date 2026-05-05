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

- 2026-05-05: Dead event listener removal reviewed and approved.
  - Removed `tool_result_end` listener: was pushing `ev.message` to the `messages` array, but this event type does not exist in the framework — dead since initial authorship.
  - Fixed streaming tool indicator: old code checked `ev.name ?? ev.tool_name ?? ev.tool` against event types `tool_use`, `tool_use_start`, `tool_call` — all wrong. Replaced with correct `ev.type === "tool_execution_start"` + `ev.toolName` field.
  - `message_end` message collection and full token accumulation block are 100% intact.
  - No references to the removed/old event names remain in any `.ts` source file. One `tool_use` string in `utils.test.ts` line ~246 is test data for content block filtering, not event type matching — benign.
  - All 41 tests pass after change.

- 2026-05-05: Memory prompt block update reviewed and approved.
  - Single line changed: `let memBlock = …` assignment in `runTask` (line 249 of `index.ts`).
  - New block instructs agents to: (1) read memory at task start, (2) silently update memory via tool calls before final response with no commentary/confirmation, (3) produce no further text after final response.
  - All three instructions confirmed present verbatim in the new template literal.
  - Surrounding injection structure (memPath binding, ${memberName}/${memPath} placeholders, conditional append, non-fatal catch) verified intact.
  - All 41 tests pass.

## QA patterns observed
- `withFileMutationQueue` used for roster writes (safe) but bypassed inside `withScalingLock` during auto-hire (intentional, documented comment in code).
- Abort signal threads through to `spawn` but uses `SIGTERM` + 5s SIGKILL fallback — no leak risk.
- Memory read failure is non-fatal (try/catch, proceeds without memory block).
- Event handlers in `processLine` use simple string equality on `ev.type` — no registration/unregistration lifecycle, just inline parsing.
