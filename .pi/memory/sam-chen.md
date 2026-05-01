# Sam Chen — Memory

## Investigation: Context window & compaction (2026-05-01)

### Key finding: agent-loop.js is in a nested package
- NOT at `dist/core/agent-loop.js` in the pi-coding-agent package
- ACTUALLY at: `.../pi-coding-agent/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`

### Answer: Full history IS sent every turn (until compaction fires)

**In `streamAssistantResponse()` (agent-loop.js ~line 150):**
```js
let messages = context.messages;  // FULL accumulated history
if (config.transformContext) { messages = await config.transformContext(messages, signal); }
const llmMessages = await config.convertToLlm(messages);  // ALL of them
```
No windowing, no truncation at the loop layer.

### Compaction mechanism (dist/core/compaction/compaction.js)

**Default settings:**
```js
export const DEFAULT_COMPACTION_SETTINGS = {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
};
```

**Trigger: `shouldCompact()`**
```js
return contextTokens > contextWindow - settings.reserveTokens;
// fires when within 16K tokens of the model's context limit
```

**Two triggers (agent-session.js `_checkCompaction`):**
1. **Threshold** (post `agent_end`): if over threshold → compact, NO auto-retry
2. **Overflow** (LLM returned overflow error): removes error msg, compacts, auto-retries via `agent.continue()`

**What compaction does:**
- `findCutPoint()`: walks back from newest, keeps ~20K tokens verbatim (the recent msgs)
- `generateSummary()`: sends older messages to LLM for summarization into structured markdown
- Appends `compaction` entry to session JSONL
- Rebuilds `agent.state.messages` from new session state
- Previous summaries are incrementally updated (UPDATE_SUMMARIZATION_PROMPT)

**Not triggered mid-stream** — only at `agent_end` and at start of `prompt()`.

### If compaction disabled
Sessions fail with hard context overflow error when window fills.

---

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

---

## Investigation: RpcClient — `newSession()` + usage stats (2026-05-01)

### Q1: Does `--append-system-prompt` survive `client.newSession()`?

**YES. It is fully preserved across every session replacement.**

**Call chain:**
1. `main.js` ~line 407: defines `createRuntime` as a **closure** capturing `parsed` (the full parsed CLI args, including `parsed.appendSystemPrompt`)
2. `createRuntime` is passed to `createAgentSessionRuntime()`, which stores it as `this.createRuntime` on `AgentSessionRuntime`
3. `AgentSessionRuntime.newSession()` (`dist/core/agent-session-runtime.js` ~line 130): creates a new `SessionManager`, then calls `this.createRuntime({...})` again
4. That re-runs the closure → calls `createAgentSessionServices({ ..., resourceLoaderOptions: { appendSystemPrompt: parsed.appendSystemPrompt, ... } })` — re-applies the prompt
5. In RPC mode: `rpc-mode.js` `handleCommand("new_session")` → `runtimeHost.newSession(options)` → same `AgentSessionRuntime.newSession()` path

**Conclusion:** `appendSystemPrompt` is baked into the `createRuntime` closure at process startup. Every `newSession()`, `fork()`, `switchSession()`, and `importFromJsonl()` call reuses that same closure, so the value is always re-applied.

### Q2: Usage stats in RPC mode

**Direct equivalent exists — no significant rework needed.**

In `rpc-mode.js`, the session subscriber outputs every `AgentSessionEvent` directly:
```js
unsubscribe = session.subscribe((event) => { output(event); });
```

`_processAgentEvent` in `agent-session.js` calls `this._emit(event)` which fires the subscriber.
`message_end` events with `role === "assistant"` carry the same `usage` object in RPC mode.

**Usage object shape** (from `pi-agent-core/dist/agent.js` EMPTY_USAGE):
```ts
{
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  totalTokens: number,      // context-window tokens (native from LLM, or 0)
  cost: {
    input: number, output: number,
    cacheRead: number, cacheWrite: number,
    total: number
  }
}
```

**This is identical** to what `runTask()` reads from `--mode json` stdout. So `onEvent()` on the RpcClient can use exactly the same extraction logic:
```ts
client.onEvent((event) => {
  if (event.type === "message_end" && event.message.role === "assistant") {
    const u = event.message.usage;
    usage.input      += u.input;
    usage.output     += u.output;
    usage.cacheRead  += u.cacheRead;
    usage.cacheWrite += u.cacheWrite;
    usage.cost       += u.cost.total;
    usage.contextTokens = u.totalTokens;
  }
});
```

**Alternative:** `client.getSessionStats()` returns aggregate totals (no per-turn accumulation needed):
```ts
{ tokens: { input, output, cacheRead, cacheWrite, total }, cost, contextUsage: { tokens, contextWindow, percent } }
```
Note: `getSessionStats()` lacks `contextTokens` (totalTokens per turn) — only `contextUsage.tokens` (current window estimate). Use per-event accumulation for the same granularity as current `runTask()`.

### Key file locations
- `createRuntime` closure: `dist/main.js` ~line 407–426
- `AgentSessionRuntime.newSession()`: `dist/core/agent-session-runtime.js` ~line 130
- RPC `new_session` handler: `dist/modes/rpc/rpc-mode.js` `handleCommand`
- RPC event emission: `dist/modes/rpc/rpc-mode.js` `rebindSession()` → `session.subscribe()`
- `getSessionStats()`: `dist/core/agent-session.js` ~line 2335
- `EMPTY_USAGE` shape: `pi-agent-core/dist/agent.js` ~line 6
