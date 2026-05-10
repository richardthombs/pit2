# Jordan Blake — Memory

## Key File Locations

- Identity/memory injection: `.pi/extensions/org/index.ts`, inside `delegateToMember()`.
- Canonical memory instructions: `.pi/memory-instructions.md`.

## Non-obvious Behaviours

- Template placeholders in the injection block are `${memberName}` and `${memPath}` — only these two.
- Agent memory files are pre-populated directly into the system prompt before delegation, so agents receive their history without needing to read it. They are still told to read for freshness/safety.
- Memory update must happen *before* the final response (not after) — tool calls after the final assistant text block corrupt EM task-result extraction.

## Beads/Workstream Integration

- `.pi/task-management.md` — shared file injected into every agent's context. Contains `${memberName}` template variable only (no `${memPath}`). Describes how agents interact with `bd` for issue tracking.
- Injection order in subagent prompt: `config.systemPrompt` → task-management block → memory block.
- `bd assign` does NOT exist; use `bd update <id> --assignee ""` to clear assignee.
- `bd create --silent` outputs only the new bead ID (nothing else) — use to capture IDs for epics/tasks.
- `bd update <id> --claim` is atomic: sets assignee + status `in_progress` in one CAS operation.
- EM creates bead epics when assigning workstream labels; task beads before each delegation.
- **Agents close their own beads on success** (not the EM): `bd note <id> "<full result>"` then `bd update <id> --status closed`. EM can fetch full detail with `bd show <bead-id>`.
- EM only handles error resets and epic closure.
- `Bead ID: <id>` line goes at the TOP of task briefs (before task description).
- Single-task requests with no workstream label: no beads created at all.

## AGENTS.md vs SYSTEM.md Boundary

- `AGENTS.md` = pure reference: commands, syntax, descriptions of what exists. No instructions.
- `.pi/SYSTEM.md` = all EM behavioural instructions (how to work, delegate, prioritise, etc.).
- The "delegate clearly" instruction (tasks must be self-contained) lives in SYSTEM.md only. AGENTS.md retains only the factual note: "Each team member maintains a personal memory file that persists across sessions."

## Canonical Identity/Memory Injection Block Text

```
\n\n---\n## Your Identity & Memory\n\nYour name is ${memberName}. Your memory file is at ${memPath}.\n\nBefore you begin executing the task, read your memory file if it exists to recall relevant context.\n\nBefore writing your final response: silently update your memory file using write/edit tools — no commentary, no confirmation. After your final response, produce no further text.
```
