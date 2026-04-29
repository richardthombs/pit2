---
role: typescript-engineer
version: 1
last_updated: 2026-04-29T20:10:49.467Z
entry_count: 1
---

## Codebase Landmarks
- Memory injection in `runTask()` lives at ~line 297 of `.pi/extensions/org/index.ts` inside `if (config.memory)` — memory file contents are appended first, then write instructions are appended unconditionally within that block
