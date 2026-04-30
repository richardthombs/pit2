---
role: prompt-engineer
version: 1
last_updated: 2026-04-30T04:57:48.999Z
entry_count: 9
---

## Conventions
- The beads-specialist role uses only bash and read tools (no write/edit); all task management goes through the `bd` CLI. No `memory:` frontmatter line was included per explicit request pattern — check task brief each time.
- `bd create` uses `--description` (not `--desc`), `--type epic` (not `--epic`), and `bd prime` is a context-primer for AI agents (SessionStart hooks), not a compaction command — Dolt handles compaction internally.
- The beads-specialist role is an expert advisor/integration architect (not an operator): no CLI reference section, no task-management responsibilities, bash is for research only (fetching source, inspecting help), and the role explicitly covers when NOT to use beads.
- The beads-specialist role uses tools: read, bash, grep, find (not just bash, read) — grep and find were added in the advisor rewrite to support codebase research tasks.
- The beads-specialist role now includes web_search and fetch_content in its tools line, enabling live web research in addition to local codebase inspection.

## Decisions
- The `## Role Memory` body section (memory-emit instructions) has been removed from all five opted-in role files; the `memory: true` frontmatter flag remains and the org extension now controls memory behaviour dynamically.
- The beads-specialist role body was rewritten to be source-discovery-driven (points to https://github.com/gastownhall/beads) rather than carrying baked-in domain summaries; the agent is expected to read source before answering.
- The `### Roles` table was removed from SYSTEM.md; the EM is now directed to use `/roles` as the source of truth for available roles and descriptions, keeping role metadata DRY.

## Codebase Landmarks
- beads-specialist role definition lives at `.pi/agents/beads-specialist.md`; beads (`bd`) is a graph issue tracker backed by Dolt with hash-based task IDs and a dependency-aware `bd ready` command.
