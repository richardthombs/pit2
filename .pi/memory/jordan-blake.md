# Jordan Blake — Memory

## Key File Locations

- Identity/memory injection: `.pi/extensions/org/index.ts`, inside `delegateToMember()`.
- Canonical memory instructions: `.pi/memory-instructions.md`.

## Non-obvious Behaviours

- Template placeholders in the injection block are `${memberName}` and `${memPath}` — only these two.
- Agent memory files are pre-populated directly into the system prompt before delegation, so agents receive their history without needing to read it. They are still told to read for freshness/safety.
- Memory update must happen *before* the final response (not after) — tool calls after the final assistant text block corrupt EM task-result extraction.

## Canonical Identity/Memory Injection Block Text

```
\n\n---\n## Your Identity & Memory\n\nYour name is ${memberName}. Your memory file is at ${memPath}.\n\nAt the start of each task, read your memory file if it exists to recall relevant context.\n\nBefore writing your final response: silently update your memory file using write/edit tools — no commentary, no confirmation. After your final response, produce no further text.
```
