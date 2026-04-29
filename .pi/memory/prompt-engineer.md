---
role: prompt-engineer
version: 1
last_updated: 2026-04-29T20:43:19.429Z
entry_count: 4
---

## Conventions
- The beads-specialist role uses only bash and read tools (no write/edit); all task management goes through the `bd` CLI. No `memory:` frontmatter line was included per explicit request pattern — check task brief each time.
- `bd create` uses `--description` (not `--desc`), `--type epic` (not `--epic`), and `bd prime` is a context-primer for AI agents (SessionStart hooks), not a compaction command — Dolt handles compaction internally.

## Decisions
- The `## Role Memory` body section (memory-emit instructions) has been removed from all five opted-in role files; the `memory: true` frontmatter flag remains and the org extension now controls memory behaviour dynamically.

## Codebase Landmarks
- beads-specialist role definition lives at `.pi/agents/beads-specialist.md`; beads (`bd`) is a graph issue tracker backed by Dolt with hash-based task IDs and a dependency-aware `bd ready` command.
