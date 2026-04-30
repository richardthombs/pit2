# Quinn Patel — Memory

## Codebase Landmarks

- **Main extension entry:** `/Users/richardthombs/dev/pit2/.pi/extensions/org/index.ts`
- **`runTask()` function:** starts around line ~283, builds the args array at line 292

## Decisions / Changes Made

### 2026-04-30 — Subagent context leak fix (line 292)
Changed the `args` initialisation in `runTask()` from:
```typescript
const args: string[] = ["--mode", "json", "-p", "--no-session"];
```
to:
```typescript
const args: string[] = ["--mode", "json", "-p", "--no-session", "--system-prompt", "", "--no-context-files"];
```
- `--system-prompt ""` — overrides `discoverSystemPromptFile()` so `.pi/SYSTEM.md` (the Engineering Manager prompt) is NOT auto-injected into subagents
- `--no-context-files` — prevents `AGENTS.md` / `CLAUDE.md` from being walked and injected

Both flags verified in `@mariozechner/pi-coding-agent/dist/cli/args.js`.
