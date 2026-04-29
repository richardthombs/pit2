# pit2 — Engineering Organisation on pi

This project implements an AI-powered software engineering organisation using the **pi coding agent** framework.

## What this is

A hierarchical multi-agent system where:
- The top-level pi session acts as the **Engineering Manager**
- Specialised **team members** are pi subagents spawned on demand
- Each team member maps to a **role definition** in `.pi/agents/<role>.md`
- A **roster** (`.pi/roster.json`) tracks which humans are hired to which roles
- The **org extension** (`.pi/extensions/org/index.ts`) wires it all together

## Key files

| Path | Purpose |
|---|---|
| `.pi/SYSTEM.md` | Manager system prompt (replaces pi default) |
| `.pi/roster.json` | Team roster — members, roles, hire dates |
| `.pi/agents/*.md` | Role definitions — frontmatter + agent system prompt |
| `.pi/extensions/org/index.ts` | Core extension: delegate tool + hire/fire/team commands |

## Commands

| Command | What it does |
|---|---|
| `/team` | Show current roster |
| `/roles` | List role definitions with staffing status |
| `/hire <role>` | Add a team member to a role |
| `/fire <name>` | Remove a team member |

## delegate tool modes

```
# Single
delegate { member: "Casey Kim", task: "..." }
delegate { role: "typescript-engineer", task: "..." }

# Parallel
delegate { tasks: [{ member: "...", task: "..." }, ...] }

# Chain (sequential, {previous} placeholder)
delegate { chain: [{ role: "software-architect", task: "design X" },
                   { role: "typescript-engineer", task: "implement {previous}" }] }
```

## Role definitions format

```yaml
---
name: role-name          # lowercase-hyphenated, matches filename
description: ...         # shown in /roles and used in team roster
tools: read, bash, ...   # comma-separated
model: claude-...        # optional
---
Body becomes --append-system-prompt content for the subagent.
```

## Pi framework location

`/Users/richardthombs/.nvm/versions/node/v24.13.1/lib/node_modules/@mariozechner/pi-coding-agent/`
- `docs/` — reference documentation
- `examples/extensions/` — working extension examples
- `examples/extensions/subagent/` — the subagent pattern this project builds on
