# Skyler Nguyen — Memory

## Codebase Landmarks

- `README.md` — Technical reference (subagent spawning, role format, key files, architecture)
- `AGENTS.md` — User guide for the EM, loaded into every LLM context; I own this file
- `.pi/SYSTEM.md` — Engineering Manager system prompt
- `docs/features.md` — Formal feature specifications for all user-visible features
- `.pi/extensions/org/index.ts` — Core org extension (all logic: delegate, hire/fire, widget, memory)
- `.pi/agents/*.md` — Role definitions (YAML frontmatter + system prompt body)
- `.pi/roster.json` — Team roster
- `.pi/prompts/memory.md` — Memory injection template (uses [name] and [path] substitutions)
- `.pi/memory/<member-id>.md` — Per-member memory files (e.g. casey-kim.md)

## Key Facts About the Current System

### Per-member memory (CURRENT — as of audit 2026-05-01)
- Memory is per-MEMBER (not per-role): `.pi/memory/<member-id>.md`
- Member ID = name lowercased, spaces → hyphens (e.g. "Casey Kim" → "casey-kim")
- Injected unconditionally for ALL members regardless of `memory:` frontmatter flag
- Agents self-maintain their own memory file using write/edit tools
- Template loaded from `.pi/prompts/memory.md` (fallback to hardcoded if template missing)
- Memory file content appended to system prompt after template block
- Firing a member DELETES their memory file
- The `memory: true` frontmatter flag is loaded into AgentConfig but NOT checked in runTask — it's vestigial

### The OLD per-role memory system (REMOVED — do NOT document)
- Used `<!-- MEMORY -->` blocks, role-scoped files, FIFO sections
- Completely replaced; `docs/features.md` still incorrectly describes this

### Async mode
- Default is ON (`let asyncMode = true` in index.ts)
- `features.md` incorrectly says default is off — needs fixing

### Subagent spawning (context isolation)
- Args include `--system-prompt ""` and `--no-context-files`
- Prevents subagents from receiving `.pi/SYSTEM.md` and `AGENTS.md`
- README example is missing these flags

### Widget streaming
- While `status === "working"` and `state.streaming` is set: shows live snippets
- Tools shown as `⚙ <tool-name>`; text shows last meaningful line (up to 80 chars)
- Refresh interval: 150ms
- Done/error states show task description instead

### All roles now have write + edit tools
- Every role in `.pi/agents/*.md` has both write and edit in their tools list

## Pending Documentation Fixes

### Completed (2026-05-01)
- `docs/features.md` — Replaced "Per-role memory" section with new "Per-member memory" section
- `docs/features.md` — Fixed async default (was "off", now correctly "on")
- `docs/features.md` — Added widget streaming behaviour to Team widget section
- `docs/features.md` — Added new "Subagent context isolation" section

### Still outstanding
- `AGENTS.md` — Add streaming mention to widget description
- `AGENTS.md` — State async default is on
- `README.md` — Document memory system (file locations, template, injection)

### Completed (2026-05-01, session 2)
- `AGENTS.md` — Replaced "no memory of previous sessions" with accurate persistent-memory + fresh-context-window wording
- `.pi/SYSTEM.md` — Same fix in "Delegate clearly" bullet
- `README.md` — Added `--system-prompt "" --no-context-files` to subagent spawn command example
