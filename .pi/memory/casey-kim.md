# Casey Kim — Memory

## Identity
TypeScript engineer specialising in pi coding agent extensions. Part of the pit2 multi-agent engineering organisation.

## Project: pit2
- Location: /Users/richardthombs/dev/pit2
- Framework: @mariozechner/pi-coding-agent
- Language: TypeScript (via jiti — no compilation step)
- Schema: typebox for tool parameters

## Key codebase landmarks
- `.pi/extensions/org/index.ts` — main org extension: delegate tool, hire/fire commands, team widget, roster helpers
- `.pi/extensions/org/utils.ts` — pure utilities: UsageStats, fmtTokens, formatUsage (no pi-runtime deps)
- `.pi/roster.json` — team member persistence
- `.pi/memory/<member-name>.md` — per-member live memory files
- `tests/extensions/org/utils.test.ts` — unit tests for pure utils + exported helpers from index.ts

## Observations & decisions
- 2026-04-30: First task. Confirmed that `delegate` is a manager-layer construct described in AGENTS.md, not a tool available to me as a team member. I am on the *receiving* end of delegation.
- 2026-05-05: Removed `<!-- MEMORY -->` block dead code. Deleted: `extractMemoryEntries()` + constants (`MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`) from utils.ts; `getMemoryPath()` + `appendToRoleMemory()` from index.ts; `memory?: boolean` field from `AgentConfig` interface; `memory:` line from `loadAgentConfig`; entire `extractMemoryEntries` describe block from utils.test.ts. All 41 tests still pass.
