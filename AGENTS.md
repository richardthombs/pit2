# pit2 — Engineering Organisation on pi

An AI-powered software engineering team. The top-level pi session is the **Engineering Manager**; specialised team members are pi subagents spawned on demand via the `delegate` tool.

> For technical details on how it's built, see `README.md`.

## Commands

| Command | What it does |
|---|---|
| `/team` | Show current roster |
| `/roles` | List available roles with staffing status |
| `/hire <role>` | Add a team member (name assigned automatically; max 30 members) |
| `/fire <name>` | Remove a team member (prompts for confirmation) |
| `/async [on\|off]` | Toggle async delegation (on by default). When on, `delegate` returns immediately and delivers results as follow-up messages. Bare `/async` toggles; `/async on` or `/async off` sets explicitly. |

## Delegating work

```
# Single task — by name or role
delegate { member: "Casey Kim", task: "..." }
delegate { role: "typescript-engineer", task: "..." }

# Parallel — up to 8 concurrent tasks
delegate { tasks: [{ member: "...", task: "..." }, ...] }

# Chain — sequential; use {previous} to pass prior output forward
delegate { chain: [{ role: "software-architect", task: "design X" },
                   { role: "typescript-engineer", task: "implement {previous}" }] }
```

Tasks must be self-contained: include all context the team member needs (file paths, specs, constraints). Each member maintains a personal memory file that persists across sessions, but this supplements rather than replaces explicit context in the task brief.

## Team widget

A live status panel shows the roster and each member's current state (`idle`, `working`, `done`, `error`) below the editor. It updates automatically as tasks run.
