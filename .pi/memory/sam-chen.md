# Sam Chen — Memory

## Investigation: Subagent awareness of `delegate` tool (2026-04-30)

### Confirmed Leaks

**Primary: AGENTS.md auto-injection**
- `/Users/richardthombs/dev/pit2/AGENTS.md` exists and contains full `delegate` tool reference
- Pi framework auto-discovers and injects AGENTS.md (and CLAUDE.md) for ALL sessions in the project directory tree
- This is controlled by `DefaultResourceLoader.loadProjectContextFiles()` in `dist/core/resource-loader.js`
- Only suppressed by `--no-context-files` / `-nc` CLI flag
- `runTask()` in `.pi/extensions/org/index.ts` does NOT pass this flag — so every subagent gets AGENTS.md injected

**Secondary: SYSTEM.md auto-discovery**
- `/Users/richardthombs/dev/pit2/.pi/SYSTEM.md` is the EM's identity prompt
- Framework discovers it via `discoverSystemPromptFile()` → `join(cwd, ".pi", "SYSTEM.md")`
- Since `runTask()` does NOT pass `--system-prompt`, the framework auto-loads the EM prompt as the BASE system prompt for every subagent
- Role prompt is appended on top via `--append-system-prompt`

### Fix Recommendations
1. Add `args.push("--no-context-files")` (or `"-nc"`) in `runTask()` — single-line fix for AGENTS.md leak
2. Pass explicit `--system-prompt` in `runTask()` to prevent EM SYSTEM.md from being auto-discovered

### Key file locations
- `runTask()`: `/Users/richardthombs/dev/pit2/.pi/extensions/org/index.ts` ~line 279
- Framework resource loader: `dist/core/resource-loader.js` (DefaultResourceLoader)
- Framework system prompt builder: `dist/core/system-prompt.js` (buildSystemPrompt)
- CLI args parsing: `dist/cli/args.js` (--no-context-files flag)
- Project AGENTS.md: `/Users/richardthombs/dev/pit2/AGENTS.md`
- EM System prompt: `/Users/richardthombs/dev/pit2/.pi/SYSTEM.md`
