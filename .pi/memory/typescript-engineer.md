---
role: typescript-engineer
version: 1
last_updated: 2026-04-30T11:50:27.219Z
entry_count: 6
---

## Conventions
- All `runTask()` calls in the delegate tool are routed through `runTaskWithStreaming()` — the wrapper that injects the `onStream` callback for live widget updates; never call `runTask()` directly from call sites

## Pitfalls
- When editing files where a prior edit adds lines, any line-number-based changes (e.g. via Python script using 0-indexed array) must be applied BEFORE subsequent edits that shift line numbers — or use a single-pass script to do all changes at once.

## Codebase Landmarks
- Memory injection in `runTask()` lives at ~line 297 of `.pi/extensions/org/index.ts` inside `if (config.memory)` — memory file contents are appended first, then write instructions are appended unconditionally within that block
- The `memberMemoryPath()` helper is defined at ~line 184 of `.pi/extensions/org/index.ts`, alongside `getMemoryPath()` for legacy role-based memory
- As of the per-member memory refactor, `config.memory` is parsed from frontmatter but no longer acted upon in `runTask()` — all members get always-on per-member memory injection regardless of that flag
- `StreamEvent`, `extractStreamSnippet`, `lastMeaningfulLine`, and `ANSI_STRIP_RE` are module-level utilities defined just before the Tool parameter schemas section (~line 434) in `.pi/extensions/org/index.ts`; `scheduleWidgetRefresh` and `runTaskWithStreaming` are inside the extension closure between `accumulateUsage` and `buildWidgetLines` (~line 558)
