---
role: pi-specialist
version: 1
last_updated: 2026-04-30T11:47:11.426Z
entry_count: 2
---

## Pitfalls
- Subagents spawned by runTask() in org/index.ts receive .pi/SYSTEM.md as their base system prompt (via auto-discovery) AND AGENTS.md as a context file (via framework auto-injection), because --system-prompt and --no-context-files are never passed. Both must be suppressed to prevent EM-targeted instructions leaking into team members.

## Codebase Landmarks
- Framework AGENTS.md injection: dist/core/resource-loader.js loadProjectContextFiles() walks cwd up to root collecting AGENTS.md/CLAUDE.md unconditionally unless --no-context-files is passed; SYSTEM.md auto-discovered by discoverSystemPromptFile() checks cwd/.pi/SYSTEM.md first.
