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
| `/async [on\|off]` | Toggle async delegation. When on, `delegate` returns immediately and delivers results as follow-up messages. Bare `/async` toggles; `/async on` or `/async off` sets explicitly. |

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

Tasks must be self-contained: include all context the team member needs (file paths, specs, constraints). Team members have persistent memory files (`.pi/memory/<member-id>.md`) but each task runs in a fresh context window — never assume a member recalls a previous conversation.

## Workstream tracking

For multi-step work, use the beads tools to externalise coordination state that would otherwise live only in the conversation context:

| Tool | Purpose |
|---|---|
| `bd_workstream_start` | Open a new workstream epic |
| `bd_task_create` | Create a task bead. Pass `role` to mark it for broker dispatch. |
| `bd_task_update` | Close a task and record findings |
| `bd_dep_add` | Record ordering dependencies between tasks |
| `bd_list` / `bd_show` | Reconstruct state after context compaction |
| `bd_ready` | Find tasks with no open blockers |
| `bd_broker_start` | Activate autonomous dispatch — broker claims ready labelled tasks and delegates them without EM involvement |
| `bd_broker_stop` | Deactivate broker; in-flight tasks finish normally |

State is stored in `.beads/` at the project root and persists across sessions. Beads is initialised automatically at session start.

**Broker pattern:** Create tasks with a `role` label, record dependencies with `bd_dep_add`, then call `bd_broker_start`. The broker dispatches each task to an available member of the matching role as its blockers close. Tasks that fail 3 times are deferred and the EM is notified. Unlabelled tasks are ignored by the broker — use `delegate` for those.

## Team widget

A live status panel shows the roster and each member's current state (`idle`, `working`, `done`, `error`) below the editor. It updates automatically as tasks run.
