# Skyler Nguyen — Documentation Steward Memory

## Audit session: 2026-05-05

### Key findings from full audit

**Fixed (in docs/features.md and AGENTS.md):**

1. **Async default was wrong** — implementation sets `asyncMode = true` on init and reset. Docs said "off". Fixed everywhere in features.md and AGENTS.md.

2. **Per-role memory section was inaccurate** — The `<!-- MEMORY -->` block mechanism (section-based, FIFO, opt-in by role) is dead code in the current implementation. `appendToRoleMemory` and `extractMemoryEntries` are defined/imported but never called from `runTask` or the delegate execution path. Replaced with accurate "Per-member memory" section describing the actual system.

3. **Auto-scaling undocumented** — `resolveOrScale()` in index.ts auto-hires when all role members are busy. Added "### Auto-scaling" subsection to delegate tool section.

4. **hire/fire tools undocumented** — Both are LLM-callable tools (not just slash commands). Added "Tool equivalent" notes to both `/hire` and `/fire` sections in features.md.

### Bug/dead code to report to EM (outside documentation scope)
- `appendToRoleMemory()` is defined in index.ts but never called from the execution path
- `extractMemoryEntries` is imported from utils.ts but never called
- The `memory: true` frontmatter field is loaded but not checked
- The documented `<!-- MEMORY -->` block mechanism does not function

### Key implementation facts

- `asyncMode` defaults to `true`, resets to `true` on session_start (startup/resume/reload)
- Per-member memory: `.pi/memory/<member-name>.md` injected via `memberMemoryPath()`; always-on for ALL agents
- Auto-scaling: `withScalingLock` + `resolveOrScale()` in delegate tool execute handler
- `hire` and `fire` tools: registered separately from commands, `fire` tool has no confirmation prompt
- Subagent spawning uses: `--mode json -p --no-session --system-prompt "" --no-context-files --append-system-prompt <tmpfile>`

### Corpus state after this session
- `docs/features.md` — accurate and complete as of 2026-05-05
- `AGENTS.md` — accurate as of 2026-05-05
- `README.md` — not updated (subagent command line slightly wrong: missing `--system-prompt ""` and `--no-context-files`; this is technical-writer scope)
