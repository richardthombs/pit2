# Sam Chen — Memory

## File Map (most-accessed)

- pi-agent-core internals: `pi-coding-agent/node_modules/@mariozechner/pi-agent-core/dist/` — `agent-loop.js`, `agent-session.js`, `compaction/compaction.js`
- org extension: `.pi/extensions/org/index.ts`
- agent definitions: `.pi/agents/*.md`

## Compaction behaviour

Fires at `agent_end` (post-turn) and at start of `prompt()` — never mid-stream.
Default: `reserveTokens: 16384`, `keepRecentTokens: 20000`. Two triggers: threshold (post `agent_end`, no retry) and overflow (LLM error, auto-retries via `agent.continue()`).

## Subagent context leaks in `runTask()` [resolved]

`runTask()` subagents previously inherited AGENTS.md and EM's SYSTEM.md unintentionally.
Fix applied: `--no-context-files` / `-nc` and explicit `--system-prompt` arg.

## `/reload` system prompt behaviour

`/reload` is fully in-process: `handleReloadCommand()` → `session.reload()` → `_rebuildSystemPrompt()`.
`--append-system-prompt <file>` IS re-read; `--append-system-prompt <literal text>` is NOT (no path to re-read).

## RpcClient process lifecycle

`session_shutdown` fires on both quit AND reload. Fire-and-forget fix applied: shutdown now awaits all `client.stop()` calls.
On reload: `session_shutdown` then `session_start(reason:"reload")` — state/usage/timers cleared, clients recreated lazily.

## `getSessionStats()` quirk (RPC mode)

Returns aggregate totals; no per-turn `contextTokens`. `contextUsage.percent` returns `null` right after compaction (before next assistant turn).
For per-turn usage, accumulate from `message_end` events: `event.message.usage`.

## `ctx:XX%` widget [bugs fixed]

- Clobber bug fixed: use `{ ...prev, status, task }` to preserve `contextPct` when updating member state.
- Reaper gap fixed: now polls all `liveMembers` regardless of status.
- Widget renders whenever `typeof contextPct === "number"`.
