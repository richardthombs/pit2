# Sam Chen — Memory

## pi-agent-core package location

Key files are NOT in `pi-coding-agent/dist/` — they live in a nested package:
- `pi-coding-agent/node_modules/@mariozechner/pi-agent-core/dist/`
- e.g. `agent-loop.js`, `agent-session.js`, `compaction/compaction.js` are all there

## Compaction behaviour

Fires at `agent_end` (post-turn) and at start of `prompt()` — never mid-stream.

Default settings (`compaction.js`):
- `reserveTokens: 16384` — fires when within 16K of context limit
- `keepRecentTokens: 20000` — keeps newest ~20K verbatim; older msgs summarised by LLM

Two triggers in `_checkCompaction` (agent-session.js):
1. **Threshold** (post `agent_end`): compact, no auto-retry
2. **Overflow** (LLM error): removes error, compacts, auto-retries via `agent.continue()`

Full history is sent every turn until compaction fires (no windowing at the loop layer).

## Subagent context leaks in `runTask()`

`runTask()` at `.pi/extensions/org/index.ts` ~line 279 spawns subagents that inherit two unintended context sources:

1. **AGENTS.md** — `DefaultResourceLoader.loadProjectContextFiles()` auto-injects `AGENTS.md` (and `CLAUDE.md`) for all sessions. Fix: add `args.push("--no-context-files")` (or `"-nc"`) to `runTask()`.
2. **EM's SYSTEM.md** — `discoverSystemPromptFile()` auto-loads `.pi/SYSTEM.md` as the base system prompt. Fix: pass an explicit `--system-prompt` arg in `runTask()`.

Neither fix has been applied yet.

## `getSessionStats()` quirk (RPC mode)

`client.getSessionStats()` returns aggregate totals but lacks per-turn `contextTokens`. For the same granularity as `--mode json` stdout, accumulate from `message_end` events:
```ts
if (event.type === "message_end" && event.message.role === "assistant") {
  const u = event.message.usage;  // { input, output, cacheRead, cacheWrite, totalTokens, cost }
}
```
`getSessionStats()` shape: `{ tokens, cost, contextUsage: { tokens, contextWindow, percent } }` — no `totalTokens` per turn.
