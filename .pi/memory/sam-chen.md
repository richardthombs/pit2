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

## Investigation: Agent turn count per task (2026-05-05)

### Key finding: Variable, unbounded turns

The agent loop lives in:
- `@mariozechner/pi-agent-core/dist/agent-loop.js` → `runLoop()` function
- Called via `Agent.prompt()` in `@mariozechner/pi-agent-core/dist/agent.js`

### Loop structure (from agent-loop.js)

```
outer while(true):          // loops if follow-up messages queued
  inner while(hasMoreToolCalls || pendingMessages.length > 0):
    streamAssistantResponse()  // ONE LLM call = ONE turn
    if (toolCalls.length > 0): execute tools, hasMoreToolCalls = true
    else: hasMoreToolCalls = false → break inner loop
  check followUpMessages → re-enter outer loop if any
```

**Each iteration of the inner while-loop = one LLM round-trip (one turn).**

### Turn count rules
- Minimum: **1 turn** (no tools called, pure text response)
- Typical: **N+1 turns** where N = number of tool-call batches
- Example: read file, edit file, done = 3 turns (initial + tool1 result + tool2 result)
- No hardcoded maximum — `shouldStopAfterTurn` callback exists but is **never set** by pi-coding-agent

### What drives turns
1. Whether the model decides to call tools
2. How many sequential tool-call batches the model uses
3. `steering` messages injected mid-run (add extra turns)
4. `followUp` messages (add turns after agent would otherwise stop)

### pit2 doesn't control turn count at all
- `runTask()` passes `--mode json -p --no-session` — delegates entirely to pi
- No `--max-turns` flag exists in pi's CLI
- No `shouldStopAfterTurn` is wired up
- pit2 only passively collects `message_end` events for token accounting

### Key files
- `/Users/richardthombs/.nvm/versions/node/v24.13.1/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` — the loop
- `/Users/richardthombs/.nvm/versions/node/v24.13.1/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-agent-core/dist/agent.js` — Agent class
- `/Users/richardthombs/.nvm/versions/node/v24.13.1/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/print-mode.js` — `runPrintMode`, calls `session.prompt()` once

## Investigation: Subagent teardown sequence (2026-05-05)

### Complete teardown sequence (normal completion)

**Inside pi subprocess:**
1. `agent-loop.js` exits inner loop (no tool calls, no follow-ups)
2. `agent_end` emitted → `_processAgentEvent` → retry check (no-op on clean exit), compaction check (skipped for `--no-session`)
3. `session.prompt()` returns in `agent-session.js`
4. `runPrintMode` `finally` fires (`print-mode.js`):
   a. Remove SIGTERM/SIGHUP signal handlers
   b. `await disposeRuntime()` → `AgentSessionRuntime.dispose()`:
      - `emitSessionShutdownEvent` → fires `session_shutdown` to extensions
      - `session.dispose()`: invalidates extension ctx, disconnects agent subscription, clears listeners, `cleanupSessionResources(sessionId)` (bash op cancellations etc.)
   c. `await flushRawStdout()` — drain stdout pipe (critical for last JSON line delivery)
5. `process.exit(exitCode)` — subprocess ends

**No session file is written.** `--no-session` → `SessionManager.inMemory()` → `persist = false` → `_persist()` is a no-op throughout. Zero disk writes for conversation history.

**In pit2 (`runTask` finally block) — runs synchronously before return:**
- `fs.unlinkSync(tmpFile)` — deletes temp role system prompt file
- `fs.rmdirSync(tmpDir)` — deletes temp dir
- Then: member status → "done", `accumulateUsage()`, `updateWidget()`
- `scheduleDoneReset()`: 5-minute setTimeout to flip status → "idle" and re-render widget

### Key files
- `print-mode.js` — runPrintMode, the finally block
- `agent-session-runtime.js` — `dispose()` method
- `agent-session.js` — `session.dispose()`: invalidate/unsubscribe/cleanupSessionResources
- `session-manager.js` line 444 — `persist` flag; line 1003 — `inMemory()`
- `main.js` line 165 — `noSession → SessionManager.inMemory()`
- `output-guard.js` — `flushRawStdout()`
- `session-resources.js` (pi-ai) — `cleanupSessionResources` registry

### Notable gotcha
The org extension IS loaded in subagents (pit2 doesn't pass `--no-extensions`), so `session_shutdown` IS fired to it. The handler calls `rosterWatcher?.close()` and clears `memberTimers` — but both are no-ops because those are only initialised in the EM session's `session_start`, not in subagents.

## Investigation: Two-step delegate feasibility (2026-05-05)

### Q1: What conversation data does pit2 currently capture?

`processLine()` in `runTask()` fires on `message_end` events. The pi framework emits `message_end` for **every** message role:
- `user` — the task prompt
- `assistant` — includes both text parts AND `toolCall` items (`content[].type === "toolCall"` with `.name`, `.arguments`)
- `toolResult` — one per tool call executed: `{ role:"toolResult", toolCallId, toolName, content, isError }`

So `messages[]` already contains the **complete turn-by-turn history** — assistant thinking text, all tool calls by name/args, all tool results with their full output — the moment the task finishes.

**Two dead-code paths that never fire:**
- `ev.type === "tool_result_end"` — no such event type exists; toolResult messages arrive via `message_end`
- Tool streaming: pit2 listens for `tool_use`, `tool_use_start`, `tool_call` — but the framework emits `tool_execution_start` (with `toolName` property). The streaming indicator never fires.

**The problem:** `messages[]` is local to `runTask()` and not returned in `RunResult`. Only the final assistant text is exposed.

### Q2: What needs to change to capture full history?

Almost nothing — the data is already there:
1. Add `messages: JsonMessage[]` to `RunResult` interface → return it from `runTask()`
2. Write a `buildConversationTranscript(messages: JsonMessage[]): string` serialiser (~30 lines)

### Q3: How would step 2 work mechanically?

Step 2 = a second pi subprocess (`runTask()` call) that receives the transcript as part of its task prompt. Options:
- **As chain step**: add a memory-writer step to the chain with `{previous}` = serialised transcript
- **Post-task call**: after main `runTask()` returns, call `runMemoryUpdate(config, memberName, transcript, cwd)` with a memory-writer role
- **Inline in chain**: least invasive, uses existing chain infra

Serialisation format (text): structured transcript with role headers, tool names, and abbreviated content. Full tool output bodies should be truncated (e.g. 500 chars each) to control token volume.

**Token risk:** A 20+ tool-call task produces 30k–100k+ tokens when fully serialised. Mitigations:
- Truncate tool result content to N chars per result
- Include only tool names + args, not outputs
- Use only final assistant message as sole memory input (simplest but loses process detail)

### Q4: Feasibility verdict

**Straightforward extension — ~2–4 hours of work.**
- No rework needed; the full conversation is already in `messages[]`
- Adding `messages` to `RunResult` is a 2-line change
- The rest is new code: serialiser, memory-writer role, post-task call
- Biggest implementation choice: where to call step 2 (chain vs post-task hook)
- Biggest runtime risk: token volume on large tasks

### Key code locations
- `processLine()`: captures `message_end` for all roles — already has full history
- `RunResult` interface: needs `messages: JsonMessage[]` field
- `getFinalOutput()`: only extracts last assistant text (for final output); step 2 needs the raw messages
- agent-loop.js event types: `message_end`, `message_start`, `tool_execution_start/end`, `turn_start/end`, `agent_start/end`
- No `tool_result_end`, `tool_use`, `tool_use_start`, `tool_call` events exist in this version of pi
