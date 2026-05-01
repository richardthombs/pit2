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

## `/reload` system prompt behaviour

`/reload` is fully in-process — no restart, no re-running `createRuntime`.

Call chain: `handleReloadCommand()` (interactive-mode.js:3944) → `session.reload()` (agent-session.js:1894) → `_resourceLoader.reload()` → `_buildRuntime()` → `_refreshToolRegistry()` → `setActiveToolsByName()` → `_rebuildSystemPrompt()` → updates `agent.state.systemPrompt`.

Key facts:
- `_resourceLoader.reload()` calls `discoverSystemPromptFile()` fresh each time, then `readFileSync` on the result — so `.pi/SYSTEM.md` edits **are** picked up.
- `--append-system-prompt <file>` is also re-read from disk on reload (path stored as `appendSystemPromptSource`; `resolvePromptInput` does `readFileSync` if it's a valid path).
- `--append-system-prompt <literal text>` is **not** re-read (no file to re-read; original string reused).
- `.pi/APPEND_SYSTEM.md` (auto-discovered) is also re-read on reload.
- Conversation history and the Agent instance are preserved across reload.

## RpcClient process lifecycle on quit and reload

**Shutdown call chain (quit)**: interactive-mode.js `shutdown()` → `await runtimeHost.dispose()` → `AgentSessionRuntime.dispose()` → `await emitSessionShutdownEvent(reason: "quit")` → `await extensionRunner.emit()` → `await handler()` → `process.exit(0)`.

**`session_shutdown` fires on both quit AND reload.** The org extension handler has no `reason` check — runs identically in both cases.

**The fire-and-forget bug** (`index.ts:868`): `entry.client.stop().catch(() => {})` — not awaited. The handler is `async` but contains no `await`, so it resolves immediately after scheduling the `stop()` Promises.

**On quit**: `process.exit(0)` follows immediately, before the `stop()` async bodies execute. However, subprocesses self-terminate via stdin EOF (spawned with `stdio: ["pipe","pipe","pipe"]`; parent pipe FDs close on exit). No explicit SIGTERM sent — but no true orphan leak either.

**On reload**: process stays alive; event loop continues; `stop()` bodies DO run in the await gaps between reload phases (`settingsManager.reload()`, `_resourceLoader.reload()`). SIGTERM is sent; 1 s SIGKILL fallback in `stop()` fires if needed. Cleanup works in practice.

**`session_start` on reload** (`reason: "reload"` is allowed): clears `memberState`, `memberUsage`, `memberTimers`. Does NOT touch `liveMembers` (already cleared by `session_shutdown`). No new clients created in `session_start` — `getOrCreateClient` is lazy. No double-stop, no orphan conflict.

**Fire-and-forget fix already applied**: `session_shutdown` now does:
```ts
await Promise.all([...liveMembers.values()].map(e => e.client.stop().catch(() => {})));
liveMembers.clear();
```

## `getSessionStats()` quirk (RPC mode)

`client.getSessionStats()` returns aggregate totals but lacks per-turn `contextTokens`. For the same granularity as `--mode json` stdout, accumulate from `message_end` events:
```ts
if (event.type === "message_end" && event.message.role === "assistant") {
  const u = event.message.usage;  // { input, output, cacheRead, cacheWrite, totalTokens, cost }
}
```
`getSessionStats()` shape: `{ tokens, cost, contextUsage: { tokens, contextWindow, percent } }` — no `totalTokens` per turn.

`contextUsage.percent` plumbing: works correctly — `getContextUsage()` (agent-session.js:2378) computes `estimateContextTokens(this.messages).tokens / contextWindow * 100`. Returns `undefined` only if `this.model` unset or `contextWindow <= 0`. Returns `{ tokens: null, percent: null }` only right after compaction fires before the next assistant turn.

## `ctx:XX%` widget display — the real bug (contextPct clobbered)

`runTaskWithStreaming()` correctly calls `getSessionStats()` post-task and writes `contextPct` into `memberState` via spread. But every caller then does a destructive `memberState.set(name, { status, task })` — a fresh object with no `contextPct` — which overwrites what `runTaskWithStreaming` just set. This happens at all 9 completion sites (lines ~1621, 1633, 1666, 1678, 1717, 1724, 1732, 1806, 1820, 1931, 1945). `updateWidget()` is called after the clobber, so the widget always sees `contextPct: undefined`.

**Fix**: either (a) at each `memberState.set` completion site, read back `prev?.contextPct` and include it, or (b) introduce a `setMemberStatus(name, patch)` helper that does `{ ...prev, ...patch }` — cleaner and prevents future regressions.

`buildWidgetLines` renders `contextPct` correctly: `typeof state.contextPct === "number"` guards it — `null` and `undefined` produce empty string, any number (even 0 or 3) renders as `ctx:X%`.

`getContextUsage()` on the subagent server returns a real numeric `percent` for normal tasks (non-compacted, non-aborted). Only returns `{ percent: null }` if last assistant was aborted/error or right after compaction before next turn.

## `ctx:XX%` widget display — the reaper gap (secondary issue)

The 50% threshold was **removed** — `buildWidgetLines()` now shows `ctx:XX%` whenever `contextPct` is a non-null number:
```ts
const ctxStr = typeof state.contextPct === "number" ? ` ctx:${Math.round(state.contextPct)}%` : "";
```

**Why it still doesn't appear after `/reload`**: `session_shutdown` stops and clears all `liveMembers`. `session_start` clears `memberState`. Clients are recreated lazily. The reaper only polls members where `state?.status === "working"` — so idle members after reload are never polled. `contextPct` stays `undefined` until a task completes via `runTaskWithStreaming()`.

**Fix**: In the reaper, remove `if (state?.status !== "working") continue;` and change `if (current)` guard to:
```ts
const current = memberState.get(name) ?? { status: "idle" as MemberStatus };
memberState.set(name, { ...current, contextPct: pct });
anyUpdated = true;
```
This polls all live clients (idle and working alike). Since `liveMembers` is empty right after reload and repopulated lazily, the first post-reload task populates `contextPct` via `runTaskWithStreaming()`; the reaper fix keeps it current thereafter.
