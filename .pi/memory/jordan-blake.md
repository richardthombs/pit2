# Jordan Blake — Memory

## Key File Locations

- Identity/memory injection: `.pi/extensions/org/index.ts`, inside `delegateToMember()`.
- Canonical memory instructions: `.pi/memory-instructions.md`.

## Non-obvious Behaviours

- Template placeholders in the injection block are `${memberName}` and `${memPath}` — only these two.
- Agent memory files are pre-populated directly into the system prompt before delegation, so agents receive their history without needing to read it. They are still told to read for freshness/safety.
- Memory update must happen *before* the final response (not after) — tool calls after the final assistant text block corrupt EM task-result extraction.

## AGENTS.md vs SYSTEM.md Boundary

- `AGENTS.md` = pure reference: commands, syntax, descriptions of what exists. No instructions.
- `.pi/SYSTEM.md` = all EM behavioural instructions (how to work, delegate, prioritise, etc.).
- The "delegate clearly" instruction (tasks must be self-contained) lives in SYSTEM.md only. AGENTS.md retains only the factual note: "Each team member maintains a personal memory file that persists across sessions."

## Canonical Identity/Memory Injection Block Text

```
\n\n---\n## Your Identity & Memory\n\nYour name is ${memberName}. Your memory file is at ${memPath}.\n\nAt the start of each task, read your memory file if it exists to recall relevant context.\n\nBefore writing your final response: silently update your memory file using write/edit tools — no commentary, no confirmation. After your final response, produce no further text.
```
