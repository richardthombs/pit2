---
role: typescript-engineer
version: 1
last_updated: 2026-04-30T05:02:52.471Z
entry_count: 2
---

## Pitfalls
- When editing files where a prior edit adds lines, any line-number-based changes (e.g. via Python script using 0-indexed array) must be applied BEFORE subsequent edits that shift line numbers — or use a single-pass script to do all changes at once.

## Codebase Landmarks
- Memory injection in `runTask()` lives at ~line 297 of `.pi/extensions/org/index.ts` inside `if (config.memory)` — memory file contents are appended first, then write instructions are appended unconditionally within that block
