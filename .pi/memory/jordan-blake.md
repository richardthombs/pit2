# Jordan Blake — Memory

## Codebase Landmarks

- Memory injection block: `.pi/extensions/org/index.ts` line 249 — template literal inside `delegateToMember()`.
- Pattern: `memberName` and `memPath` are the two template placeholders used in the injected block.
- Memory file pre-population: lines 250–255 append the agent's existing memory file contents directly after the injected block, so agents see their own history without needing to read it themselves at runtime (though they are still instructed to read it for freshness/safety).

## Decisions Made

### 2026-05-05 — Memory update ordering fix
**Problem:** Agents writing commentary about their memory update after their final response corrupted the EM's task-result extraction (which takes the last assistant text block).

**Solution adopted (option 1):** Reword the injection block so agents are told to run write/edit tool calls *before* writing their final response, with an explicit "no commentary, no confirmation" rule and a hard stop after the final response.

**New block text (for line 249):**
```
\n\n---\n## Your Identity & Memory\n\nYour name is ${memberName}. Your memory file is at ${memPath}.\n\nAt the start of each task, read your memory file if it exists to recall relevant context.\n\nBefore writing your final response: silently update your memory file using write/edit tools — no commentary, no confirmation. After your final response, produce no further text.
```

Key structural change: "At the end of each task" → "Before writing your final response" sequences the tool call correctly.
