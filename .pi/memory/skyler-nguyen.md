# Skyler Nguyen — Memory

## Key File Locations

- `AGENTS.md` — User guide for the EM; I own this file (loaded into every LLM context — keep concise)
- `docs/features.md` — Formal feature specifications for all user-visible features
- `.pi/extensions/org/index.ts` — Core org extension
- `.pi/prompts/memory.md` — Memory injection template (uses [name] and [path] substitutions)
- `.pi/memory/<member-id>.md` — Per-member memory files (member ID = name lowercased, spaces → hyphens)
- `.beads/` — Workstream state directory at project root (runtime artifact, not in source)

## Documentation Corpus State

### Known accurate
- Beads workstream feature: fully documented in `docs/features.md` and `AGENTS.md`
- Broker (Integration B): fully documented in `docs/features.md` and `AGENTS.md`
- Team roster and role descriptions: `AGENTS.md`
- Memory system: documented in `docs/features.md`

### Where things are documented
- Full feature specs (beads, broker, memory, delegation): `docs/features.md`
- Concise tables for EM daily use: `AGENTS.md`
- Architecture overview and key files: `README.md`
- EM guidance on when/how to use beads: `.pi/SYSTEM.md` "Workstream State (Beads)" section

### Known gaps / deferred
- None currently identified

## Terminology

- **Members** (not "agents") — the AI team members managed by the EM
- **Workstream** — a tracked unit of work in the beads system (not "task", which is overloaded)
- **Broker** — the autonomous dispatcher (Integration B) that routes labelled workstreams to members
- **Delegate** — the EM command to assign a task to a specific named member
- **Roster** — the current active team (`.pi/roster.json`)

## Broker Behaviour (user-visible)

- Dispatches workstreams labelled with a `role` to available team members autonomously
- Unlabelled workstreams are EM-owned; broker never touches them
- 3 consecutive failures → workstream set to `deferred`, EM notified
- Large task results (>40 KB) stored in `.pi/task-results/<id>.md`; smaller results in beads notes

## Memory System

- Memory is per-member, not per-role; injected into every member's system prompt unconditionally
- Template: `.pi/prompts/memory.md`; content from `.pi/memory/<member-id>.md` appended after template block
- `memory: true` frontmatter flag in role definitions is vestigial — memory is injected regardless of it
- Firing a member deletes their memory file
