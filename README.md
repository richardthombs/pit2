# pit2 — Technical Reference

pit2 implements an AI-powered software engineering organisation on top of the [pi coding agent](https://github.com/mariozechner/pi) framework.

## Architecture

The system is hierarchical:

- The **top-level pi session** runs as the Engineering Manager
- **Team members** are isolated pi subprocesses, each given a role-specific system prompt
- The **org extension** wires everything together: it registers the `delegate` tool and the `/team`, `/roles`, `/hire`, `/fire` commands
- A **roster file** tracks who is hired to which role

Members have no shared state and cannot communicate with each other. All coordination happens through the Engineering Manager.

## Key files

| Path | Purpose |
|---|---|
| `AGENTS.md` | User guide — loaded into every LLM context window; keep concise |
| `.pi/SYSTEM.md` | Engineering Manager system prompt |
| `.pi/roster.json` | Team roster: members, roles, hire dates, used name pool |
| `.pi/agents/*.md` | Role definitions — YAML frontmatter + agent system prompt |
| `.pi/extensions/org/index.ts` | Core extension: delegate tool, hire/fire/team/roles commands |
| `docs/features.md` | Formal feature specifications |

## Role definition format

Role files live in `.pi/agents/<role-name>.md`. They use YAML frontmatter followed by the agent's system prompt body.

```yaml
---
name: role-name          # lowercase-hyphenated; must match filename
description: ...         # one sentence; shown in /roles and the team roster
tools: read, bash, ...   # comma-separated list of pi tool names
model: claude-...        # optional; overrides the default model for this role
---

The body text becomes the --append-system-prompt content for the subagent.
It is appended after pi's default system prompt, so focus on role-specific
instructions rather than repeating general tool usage.
```

## Adding a new role

1. Create `.pi/agents/<role-name>.md` with valid frontmatter and a system prompt body
2. Run `/roles` to confirm it appears
3. Run `/hire <role-name>` to staff it

## Subagent spawning

When a task is delegated, the extension spawns a fresh `pi` subprocess:

```
pi --mode json -p --no-session [--model ...] [--tools ...] --system-prompt "" --no-context-files --append-system-prompt <tmpfile> "Task for <name>: ..."
```

The role's system prompt is written to a temporary file, passed via `--append-system-prompt`, then deleted after the process exits. Output is streamed back as JSON events (`message_end`, `tool_result_end`).

## Name pool

Team members are assigned names from a fixed pool of 30 gender-neutral names. Names are never reused within a project — once assigned (even to a fired member), a name is retired. This means the absolute maximum team size over the project's lifetime is 30 members.

## Pi framework

The pi package is a global npm module. Its location varies by environment; on the reference machine:

```
/Users/richardthombs/.nvm/versions/node/v24.13.1/lib/node_modules/@mariozechner/pi-coding-agent/
├── docs/         # Framework reference documentation
└── examples/
    └── extensions/
        └── subagent/   # The subagent pattern pit2 builds on
```

> This path is environment-specific. Run `npm root -g` or `which pi` to locate it in other environments.
