# Skyler Nguyen — Memory

## Key File Locations

- `AGENTS.md` — User guide for the EM; I own this file (loaded into every LLM context — keep concise)
- `docs/features.md` — Formal feature specifications for all user-visible features
- `.pi/extensions/org/index.ts` — Core org extension (all logic: delegate, hire/fire, widget, memory)
- `.pi/prompts/memory.md` — Memory injection template (uses [name] and [path] substitutions)
- `.pi/memory/<member-id>.md` — Per-member memory files (member ID = name lowercased, spaces → hyphens)

## Per-Member Memory System

- Memory is per-MEMBER, not per-role; injected unconditionally for ALL members
- Template from `.pi/prompts/memory.md`; content appended to system prompt after template block
- Firing a member deletes their memory file
- `memory: true` frontmatter flag is vestigial — loaded into AgentConfig but NOT checked in runTask

## Async Mode

- Default is ON (`let asyncMode = true` in index.ts)

## Subagent Spawning (Context Isolation)

- Args include `--system-prompt ""` and `--no-context-files`
- Prevents subagents from receiving `.pi/SYSTEM.md` and `AGENTS.md`

## Widget Streaming

- While `status === "working"` and `state.streaming` is set: shows live snippets
- Tools shown as `⚙ <tool-name>`; text shows last meaningful line (up to 80 chars)
- Refresh interval: 150ms; done/error states show task description instead
