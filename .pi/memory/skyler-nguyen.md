# Skyler Nguyen — Documentation Steward Memory

## Key implementation facts (pit2 org extension)

- **asyncMode** defaults to `true`; resets to `true` on every `session_start` event (startup, resume, reload). Not configurable off by default.
- **Per-member memory**: `.pi/memory/<member-name>.md` — injected for ALL agents automatically via `memberMemoryPath()`. Always-on; no opt-in required.
- **`<!-- MEMORY -->` block mechanism is dead code** — `appendToRoleMemory()` and `extractMemoryEntries` are defined/imported but never called from the execution path. The `memory: true` frontmatter field is loaded but never checked. Do not document this as a working feature.
- **Auto-scaling**: delegate tool calls `resolveOrScale()` (guarded by `withScalingLock`) — auto-hires a new member when all role members are busy.
- **`hire` and `fire` are LLM-callable tools** (not just slash commands). The `fire` tool has no confirmation prompt.
- **Subagent spawn flags**: `--mode json -p --no-session --system-prompt "" --no-context-files --append-system-prompt <tmpfile>`

## Corpus locations

- `AGENTS.md` — project overview (loaded into LLM context; keep concise)
- `docs/features.md` — primary user-facing feature reference
- `.pi/extensions/org/index.ts` — source of truth for all tool/command behaviour
- `.pi/agents/*.md` — role definitions
- `.pi/roster.json` — current team
