# Quinn Patel — Memory

## Codebase Landmarks

- **Main extension entry:** `/Users/richardthombs/dev/pit2/.pi/extensions/org/index.ts`
- **`runTask()` function:** search for `async function runTask` in the entry file above

## CLI Flags for Subagent Spawning

When `runTask()` spawns a pi subagent, the args array must include these flags to prevent the parent agent's context from leaking into subagents:

```typescript
"--system-prompt", "", "--no-context-files"
```

- `--system-prompt ""` — overrides `discoverSystemPromptFile()` so `.pi/SYSTEM.md` (the Engineering Manager prompt) is **not** auto-injected into subagents
- `--no-context-files` — prevents `AGENTS.md` / `CLAUDE.md` from being walked and injected

Both flags are defined in `@mariozechner/pi-coding-agent/dist/cli/args.js`. Without them, every subagent inherits the EM system prompt and context files.
