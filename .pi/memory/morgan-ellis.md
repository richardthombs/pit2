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

## Non-obvious framework behaviours
- Correct event type for streaming tool indicator: `ev.type === "tool_execution_start"`, field is `ev.toolName`. Old names (`tool_use`, `tool_use_start`, `tool_call`, `ev.name`, `ev.tool_name`, `ev.tool`) are all wrong and do not fire.
- `tool_result_end` event type does not exist in the framework — never use it.
- `tool_use` string appears in `utils.test.ts` as test data for content block filtering — not event type matching. Not a bug.
- `.pi/memory/*.md` files may reference old/removed symbol names (`appendToRoleMemory`, `extractMemoryEntries`) — benign documentation artefacts, not live code.

## QA patterns & invariants
- `withFileMutationQueue` used for roster writes (safe) but intentionally bypassed inside `withScalingLock` during auto-hire — documented in code, not a bug.
- Abort signal threads through to `spawn` via SIGTERM + 5s SIGKILL fallback — no leak risk.
- Memory read failure in `runTask` is non-fatal: try/catch, proceeds without memory block if file missing.
- `processLine` event handlers use simple `ev.type` string equality — no registration/unregistration lifecycle, just inline parsing.
