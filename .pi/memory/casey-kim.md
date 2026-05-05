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
- `.pi/memory-instructions.md` — externalized memory instruction template (placeholders: `${memberName}`, `${memPath}`); read fresh each delegation call; separator `\n\n---\n` stays in code
- `tests/extensions/org/utils.test.ts` — unit tests for pure utils + exported helpers from index.ts

## Observations & decisions
- 2026-04-30: First task. Confirmed that `delegate` is a manager-layer construct described in AGENTS.md, not a tool available to me as a team member. I am on the *receiving* end of delegation.
- 2026-05-05: Removed unused `.pi/inbox.jsonl` and `.pi/logs/` artifacts. Confirmed zero runtime references in all `.ts` and `.md` files (`.beads/` history referenced `logInbox`/`.pi/logs/` but those changes were never in git — `utils.ts` and `index.ts` had no trace of `logInbox`). Removed `# Runtime artifacts` block from `.gitignore`. Committed as `46c07ab`.
- 2026-05-05: Removed two dead event listeners from `processLine` in index.ts: (1) `tool_result_end` block — event type doesn't exist in pi framework, tool results arrive via `message_end`; (2) broken streaming indicator checking `tool_use`/`tool_use_start`/`tool_call` — replaced with correct `tool_execution_start` + `ev.toolName` (confirmed from `agent-session.js` dist). All 41 tests still pass.
- 2026-05-05: Removed `<!-- MEMORY -->` block dead code. Deleted: `extractMemoryEntries()` + constants (`MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`) from utils.ts; `getMemoryPath()` + `appendToRoleMemory()` from index.ts; `memory?: boolean` field from `AgentConfig` interface; `memory:` line from `loadAgentConfig`; entire `extractMemoryEntries` describe block from utils.test.ts. All 41 tests still pass.
- 2026-05-05: Updated `## Your Identity & Memory` prompt block in index.ts (line ~249). New wording: instructs agent to read memory at task start, then silently update before final response with no commentary/confirmation — replacing the older "end of each task" free-form guidance. All 41 tests still pass.
- 2026-05-05: Externalized memory instruction text to `.pi/memory-instructions.md`. `runTask` reads the file fresh each call and applies `${memberName}`/`${memPath}` substitutions via `.replace()`; falls back to the same hardcoded string if file is missing/unreadable. `\n\n---\n` separator remains in code. All 41 tests still pass.
