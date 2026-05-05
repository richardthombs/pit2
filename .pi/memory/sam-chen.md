# Sam Chen — Memory

## pit2 `runTask()` subprocess flags (as-built)

Line 231 of `.pi/extensions/org/index.ts`:
```ts
const args: string[] = ["--mode", "json", "-p", "--no-session", "--system-prompt", "", "--no-context-files"];
```
- `--no-context-files` / `-nc` — suppresses auto-injection of AGENTS.md (and CLAUDE.md) into subagents. Without it every subagent in the project tree would see the full AGENTS.md.
- `--system-prompt ""` (empty string) — prevents `discoverSystemPromptFile()` from auto-loading `.pi/SYSTEM.md` as the base system prompt for subagents. Role prompt is appended via `--append-system-prompt <tmpFile>`.
- No `--no-extensions` is passed — the org extension IS loaded in every subagent. `session_shutdown` fires to it, but roster/timer handlers are no-ops (only initialised in the EM's `session_start`).

## pi framework: how subagent context is built

- `DefaultResourceLoader.loadProjectContextFiles()` in `dist/core/resource-loader.js` — injects AGENTS.md/CLAUDE.md for all sessions unless `--no-context-files` is set.
- `discoverSystemPromptFile()` → `join(cwd, ".pi", "SYSTEM.md")` — auto-loads EM identity prompt as base system prompt unless `--system-prompt` is explicitly passed (even as empty string).
- `buildSystemPrompt` in `dist/core/system-prompt.js` assembles the final prompt.

## pi framework: no turn limit exists

- No `--max-turns` CLI flag in pi.
- `shouldStopAfterTurn` callback exists in `agent-loop.js` but is **never set** by pi-coding-agent.
- Turn count = number of sequential tool-call batches + 1. Unbounded.
- `steering` and `followUp` messages each add extra turns.

## `message_end` event carries ALL conversation roles

`processLine()` in `runTask()` fires on `message_end` for every role:
- `user` — the task prompt
- `assistant` — text parts + `toolCall` items (`content[].type === "toolCall"`, `.name`, `.arguments`)
- `toolResult` — `{ role, toolCallId, toolName, content, isError }`

Complete turn-by-turn history is in `messages[]` (local to `runTask()`), **not** returned in `RunResult`. `RunResult` only exposes `{ exitCode, output, stderr, usage }`.

## Dead event names (do NOT exist in this version of pi)

These events are **never emitted** — code that listens for them silently does nothing:
- `tool_result_end`
- `tool_use`
- `tool_use_start`
- `tool_call`

The real events: `tool_execution_start` (has `.toolName` property), `tool_execution_end`, `message_end`, `message_start`, `turn_start`, `turn_end`, `agent_start`, `agent_end`.

## `--no-session` behaviour

`--no-session` → `SessionManager.inMemory()` → `persist = false` → `_persist()` is a no-op. Zero disk writes for conversation history. Compaction is also skipped.

## Key file locations (pit2)

- `runTask()` / `RunResult`: `.pi/extensions/org/index.ts` line ~222 / ~42
- EM system prompt: `.pi/SYSTEM.md`
- Project context file: `AGENTS.md` (root)
