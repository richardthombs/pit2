# Skyler Nguyen — Documentation Steward Memory

## Key implementation facts (pit2 org extension)

- **asyncMode** defaults to `true`; resets to `true` on every `session_start` event (startup, resume, reload). Not configurable off by default.
- **Per-member memory**: `.pi/memory/<member-name>.md` — injected for ALL agents automatically via `memberMemoryPath()`. Always-on; no opt-in required.
- **`<!-- MEMORY -->` block mechanism is dead code** — `appendToRoleMemory()` and `extractMemoryEntries` are defined/imported but never called from the execution path. The `memory: true` frontmatter field is loaded but never checked. Do not document this as a working feature.
- **Auto-scaling**: delegate tool calls `resolveOrScale()` (guarded by `withScalingLock`) — auto-hires a new member when all role members are busy.
- **`hire` and `fire` are LLM-callable tools** (not just slash commands). The `fire` tool has no confirmation prompt.
- **Subagent spawn flags**: `--mode json -p --no-session --system-prompt "" --no-context-files --append-system-prompt <tmpfile>`
- **JSON streaming**: `message_end` collects assistant turns + accumulates usage; `tool_execution_start` triggers widget ⚙ indicator. Widget refreshes on 150 ms debounce.
- **Result extraction**: `getFinalOutput()` scans collected messages last→first, returns first `assistant` message's `text` content block.
- **Async delivery**: `pi.sendUserMessage(content, { deliverAs: "followUp" })` — injects result as follow-up user message when background task completes.
- **Memory instruction placeholders**: `${memberName}` and `${memPath}` substituted from `.pi/memory-instructions.md`; fallback to hardcoded string if file missing.
- **Memory inlining**: existing memory file contents are appended to the memory block in the system prompt (so agent sees prior knowledge immediately), AND agents are also told to read the file at task start.

## Corpus locations

- `AGENTS.md` — project overview (loaded into LLM context; keep concise)
- `README.md` — technical reference; now has Delegation and Per-member Memory sections with Mermaid diagrams
- `docs/features.md` — primary user-facing feature reference (comprehensive and accurate as of 2026-05-10)
- `.pi/extensions/org/index.ts` — source of truth for all tool/command behaviour
- `.pi/agents/*.md` — role definitions
- `.pi/roster.json` — current team
- `.pi/memory-instructions.md` — template injected into every subagent system prompt; uses `${memberName}` and `${memPath}`

## Last audit (2026-05-10)

- `AGENTS.md`: accurate, no changes needed
- `docs/features.md`: accurate and comprehensive, no changes needed
- `README.md`: fixed wrong spawn flags (was missing `--system-prompt ""` and `--no-context-files`); added Delegation and Per-member Memory sections with Mermaid diagrams
