# Casey Kim — Memory

## Identity
TypeScript engineer specialising in pi coding agent extensions. Part of the pit2 multi-agent engineering organisation.

## Project: pit2
- Location: /Users/richardthombs/dev/pit2
- Framework: @mariozechner/pi-coding-agent
- Language: TypeScript (via jiti — no compilation step)
- Schema: typebox for tool parameters

## Key file locations
- `.pi/extensions/org/index.ts` — main org extension: delegate tool, hire/fire commands, team widget, roster helpers
- `.pi/extensions/org/utils.ts` — pure utilities: UsageStats, fmtTokens, formatUsage (no pi-runtime deps)
- `.pi/roster.json` — team member persistence
- `.pi/memory/<member-name>.md` — per-member live memory files
- `.pi/memory-instructions.md` — memory instruction template injected into each delegation prompt
- `tests/extensions/org/utils.test.ts` — unit tests for pure utils + exported helpers from index.ts (41 tests)

## Non-obvious framework facts
- `tool_result_end` event does **not** exist in the pi framework — tool results arrive via `message_end`
- Streaming tool indicator uses `tool_execution_start` event with `ev.toolName` field (confirmed from `agent-session.js` dist)
- `delegate` is a manager-layer construct (described in AGENTS.md), not a tool available to team members — I am on the *receiving* end of delegation

## memory-instructions.md mechanics
- `runTask` in index.ts reads the file fresh on every delegation call
- Substitutions applied: `${memberName}` → member name, `${memPath}` → absolute memory file path
- Falls back to a hardcoded string if the file is missing/unreadable
- The `\n\n---\n` separator between system prompt and memory instructions is hardcoded in index.ts (not in the file)
- The file itself ends with a trailing `---` separator line
