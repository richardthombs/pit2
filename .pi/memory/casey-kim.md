# Casey Kim — Memory

## Identity
TypeScript engineer specialising in pi coding agent extensions. Part of the pit2 multi-agent engineering organisation.

## Project: pit2
- Location: /Users/richardthombs/dev/pit2
- Framework: @mariozechner/pi-coding-agent
- Language: TypeScript (via jiti — no compilation step)
- Schema: typebox for tool parameters

## Key codebase landmarks
- `.pi/extensions/org/index.ts` — main org extension: roster helpers, `runTask`/`runTaskWithStreaming`, `delegate` tool, `/hire`/`/fire`/`/team`/`/roles` commands.
- `.pi/extensions/org/utils.ts` — shared utilities: `UsageStats`, `formatUsage`, `fmtTokens`, `MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `extractMemoryEntries` (all still present here; index.ts now only imports `UsageStats`, `fmtTokens`, `formatUsage`).

## Observations & decisions
- 2026-04-30: First task. Confirmed that `delegate` is a manager-layer construct described in AGENTS.md, not a tool available to me as a team member. I am on the *receiving* end of delegation.
- My role prompt contains no mention of `delegate` — it is purely for the Engineering Manager's use.
