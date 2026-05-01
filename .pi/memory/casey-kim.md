# Casey Kim — Memory

## Identity
TypeScript engineer specialising in pi coding agent extensions. Part of the pit2 multi-agent engineering organisation.

## Project: pit2
- Location: /Users/richardthombs/dev/pit2
- Framework: @mariozechner/pi-coding-agent
- Language: TypeScript (via jiti — no compilation step)
- Schema: typebox for tool parameters

## Key codebase landmarks
- `.pi/extensions/org/index.ts` — main org extension: roster helpers, `runTask`/`runTaskWithStreaming`, `delegate` tool, `/hire`/`/fire`/`/team`/`/roles` commands.
- `.pi/extensions/org/utils.ts` — shared utilities: `UsageStats`, `formatUsage`, `fmtTokens`, `MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `extractMemoryEntries` (all still present here; index.ts now only imports `UsageStats`, `fmtTokens`, `formatUsage`).

## Observations & decisions
- 2026-04-30: First task. Confirmed that `delegate` is a manager-layer construct described in AGENTS.md, not a tool available to me as a team member. I am on the *receiving* end of delegation.
- My role prompt contains no mention of `delegate` — it is purely for the Engineering Manager's use.
- 2026-04-30: Second task. Committed dead-code removal from `index.ts` (commit `81b8b53`): dropped `appendToRoleMemory()`, `getMemoryPath()`, and unused imports `MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `extractMemoryEntries`. These were orphaned by the per-member memory refactor. Symbols remain in `utils.ts`.
- 2026-04-30: Third task. Created `.pi/prompts/memory.md` as an external template for the memory identity block. Updated `runTask()` in `index.ts` to load it via a nested try/catch inside the existing outer try/catch: reads the template, replaces `[name]`/`[path]` placeholders, falls back silently to the hardcoded string on any read error.
- 2026-04-30: Fourth task. Committed all three outstanding changes as commit `ecd8bad`: memory template externalisation, dead-code removal from `index.ts`, and `write`/`edit` additions to five role tool lists. Left `.pi/memory/jordan-blake.md` and `morgan-ellis.md` unstaged (untracked, not part of described changeset).
- 2026-05-01: Fifth task. Implemented persistent RpcClient-per-member per spec at `.pi/docs/spec-member-persistence-implementation.md`. Commit `54f0b84`.
  - Added `liveMembers: Map<string, LiveMemberEntry>` at module scope, keyed `cwd::memberName`.
  - `getOrCreateClient()`: writes stable system-prompt file to `.pi/prompts/members/<slug>.md`, calls `client.start()` + `setAutoCompaction(true)`, attaches exit listener via `(client as any).process`.
  - `buildMemberSystemPromptFile()`: role prompt + memory instructions (no file contents); re-written each time a new client starts.
  - `initializeClientMemory()`: sends memory file contents as a message on first use; guarded by `entry.initialized`.
  - `reapIdleClients()`: 10-min idle timeout, checked every 60s via `reaperInterval` (closure var).
  - `stopLiveClient()`: used by `/fire` command and `fire` tool before roster splice; also deletes `.pi/prompts/members/<slug>.md`.
  - New `runTask()`: `onEvent()` for live streaming, `waitForIdle(300_000)`, `client.abort()` for cancel, crash removes from map.
  - **Key decisions**: bun guard = `process.argv[1]?.startsWith("/$bunfs/root/")` throws; `import type { AssistantMessage, TextContent }` from `@mariozechner/pi-ai` (type-only, erased by jiti); task timeout = 300_000ms; crash error = `"Member process crashed or disconnected — client removed"`.
  - `@mariozechner/pi-ai` NOT a direct dep of `pit2` but safe as `import type` (jiti erases it). Verified it's in pi-coding-agent's nested node_modules.
  - `RpcClientOptions` exported from `@mariozechner/pi-coding-agent` root (confirmed in dist/index.d.ts).
- 2026-05-01: Seventh task. Committed documentation updates as commit `a95c3eb`: AGENTS.md + README.md memory-wording fixes, subagent spawn command updated (`--system-prompt "" --no-context-files`), `.pi/SYSTEM.md` delegate-clearly fix + new `## Working Practices` section, `docs/features.md` per-member memory rewrite + async-default correction + live-widget snippet behaviour + new subagent context isolation section. Staged only the four in-scope files; left memory files, memory.md template, etc. unstaged.
- 2026-05-01: Sixth task. Applied four QA fixes. Commit `8e1b95c`:
  1. `TASK_IDLE_TIMEOUT_MS`: `300_000` → `600_000`; comment "5 minutes" → "10 minutes".
  2. `runTask` catch: replaced bare `throw new Error(...)` with wrapped error that carries original `.cause` and includes `err.message` in the message string.
  3. Removed dead `spawn` import; updated stale file-header comment (was "spawns an isolated pi subprocess").
  4. Hardened `initializeClientMemory()` call with try/catch: on failure calls `stopLiveClient()` then rethrows, so broken clients are cleaned up immediately rather than waiting for the 10-min reaper.
- 2026-05-01: Eighth task. Staged and committed all remaining unstaged/untracked changes as commit `2464849`: new docs (design + spec for member persistence), new named-member memory files (alex-rivera, jordan-blake, morgan-ellis, skyler-nguyen), updated casey-kim + sam-chen memories, deleted old role-named memory files (pi-specialist, prompt-engineer, qa-engineer, typescript-engineer), and memory template wording update.
