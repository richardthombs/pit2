# Alex Rivera — Architect Memory

## Identity
Senior software architect on the pit2 project (AI-powered software engineering org built on pi coding agent framework).

## Key Codebase Landmarks

### Org Extension
- Main file: `/Users/richardthombs/dev/pit2/.pi/extensions/org/index.ts`
- `runTask()` starts at line ~224 — spawns `--mode json -p --no-session --system-prompt "" --no-context-files`
- `runTaskWithStreaming()` at line ~516 wraps `runTask()` with UI streaming
- `delegate` tool registered at line ~889 — supports single / parallel (max 8) / chain modes
- Member memory files: `.pi/memory/<member-slug>.md`
- Parallel mode: `params.tasks` array, up to 8 concurrent spawns
- `liveMembers` pattern does NOT exist yet — this would be new

### Pi Framework (installed at /Users/richardthombs/.nvm/versions/node/v24.13.1/lib/node_modules/@mariozechner/pi-coding-agent)
- `dist/main.js` — CLI entry, `--no-session` → `SessionManager.inMemory()`, normal → `SessionManager.create()`
- `dist/modes/rpc/rpc-client.js` + `rpc-client.d.ts` — **RpcClient class** (long-running agent embedding API)
  - `start()`, `stop()`, `prompt()`, `waitForIdle()`, `compact()`, `newSession()`, `clone()`, `getLastAssistantText()`, `getSessionStats()`
  - Spawns with `--mode rpc`; `args` passed through to CLI at spawn time (so `--no-session`, `--append-system-prompt` etc. work)
- `dist/modes/rpc/rpc-types.d.ts` — full RPC protocol type definitions
- `dist/modes/rpc/rpc-mode.js` — server side (handles `compact`, `new_session`, `switch_session`, etc.)

### Sessions
- `--no-session` → in-memory only, no JSONL file
- Named session: `--session <path>` to resume; `SessionManager.open()` / `SessionManager.create()`
- Sessions live in configured `sessionDir` (default `.pi/sessions/`)

## Design Work Produced

### Member Persistence Design
- File: `/Users/richardthombs/dev/pit2/.pi/docs/design-member-persistence.md`
- Three options: A (session file replay), B (live RPC), C (session-backed RPC)
- **Recommendation: Option B** — use `RpcClient` per member in a module-level Map
- Key insight: `RpcClient` is already written by the framework, this is the designed embedding API
- Proposed ADR-004 in the document
- Memory file injection problem identified: currently injected at spawn, with persistent clients it must shift to explicit follow-up after each task
- Parallel mode uses persistent clients (resolveOrScale guarantees each member is idle at assignment time; no RpcClient ever gets concurrent prompt() calls)

## ADRs Produced
- ADR-004 (Proposed): Team Member Persistence via RPC Clients — in design doc above

## Implementation Spec Produced
- File: `/Users/richardthombs/dev/pit2/.pi/docs/spec-member-persistence-implementation.md`
- Covers all 10 areas: liveMembers map, getOrCreateClient, runTask refactor, idle reaping, /fire updates, memory injection, streaming, cancellation, error handling, what stays the same
- Status: Ready for a typescript-engineer to implement directly

## Pitfalls / Gotchas
- `--append-system-prompt` in RpcClient.args applies once at session start; subsequent `newSession()` calls would lose it (needs verification)
- System prompt files need to be stable (not temp files) for persistent clients
- `/fire` command handler needs to stop/remove any live client for that member
- Two concurrent EM sessions on same project could conflict on same member client (punted)
- `resolveOrScale` guarantees a named member is always IDLE before assignment — if busy it auto-hires a new member of that role. So no RpcClient ever receives concurrent prompt() calls. Parallel mode can safely use persistent clients.
- ADR-004 updated: all delegation modes use persistent clients; no hybrid needed.
- `RpcClient` IS exported from `@mariozechner/pi-coding-agent` main index — safe to import directly
- `RpcClient` hardcodes `node` as executor; use `cliPath: process.argv[1]` for node-based deployments; bun-compiled binary path unsupported without patching
- `AgentEvent.message_end.message` is `AgentMessage`; check `.role === 'assistant'` and cast to `AssistantMessage` (from `@mariozechner/pi-ai`) to get `.usage`
- `message_update` fires live per-token; `tool_execution_start` fires when a tool is invoked
- Memory injection: stable system prompt file at `.pi/prompts/members/<slug>.md` (no file contents); contents injected once via initializeClientMemory() after client.start()
- `waitForIdle()` default 60s; spec uses 600_000ms for tasks, 30_000ms for memory init
- Crash recovery: access `(client as any).process` for exit listener; remove from liveMembers on exit
