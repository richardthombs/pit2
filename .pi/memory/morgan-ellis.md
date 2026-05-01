# Morgan Ellis — QA Memory

## Project: pit2 — multi-agent engineering organisation (pi extension)

### Codebase Landmarks
- Extension entry: `.pi/extensions/org/index.ts`
- Pure utilities: `.pi/extensions/org/utils.ts` (no pi-runtime deps — safe to test in isolation)
- Team roster: `.pi/roster.json` (managed via `loadRoster`/`saveRoster`)
- Agent role definitions: `.pi/agents/<role>.md` (frontmatter + body)
- Member memory files: `.pi/memory/<member-id>.md` (free-form; owned by the agent itself)

### Architecture Notes
- Memory is per-member (free-form files), not per-role structured blocks — was refactored from the latter
- System prompt per member written to `.pi/prompts/members/<slug>.md` by `buildMemberSystemPromptFile()`
- Memory template at `.pi/prompts/memory.md` — has `[name]` and `[path]` placeholders; loaded by `runTask()` via `fs.readFileSync` with a hardcoded fallback string if the file is missing

### Persistent RpcClient per Member
- `runTask()` uses a persistent `RpcClient` per named member (not a fresh spawn per task)
- Key functions: `getOrCreateClient()`, `stopLiveClient()`, `reapIdleClients()`, `initializeClientMemory()`, `liveMemberKey()`, `memberSystemPromptPath()`
- `liveMembers` Map holds `LiveMemberEntry` (client + lastUsed timestamp)
- Memory injected once as first assistant message (`initializeClientMemory`), not on every task
- Idle reaper: 60s interval, `TASK_IDLE_TIMEOUT_MS = 600_000` (10 min); started in `session_start`, torn down in `session_shutdown`
- `/fire` and `fire` tool both call `stopLiveClient()` + delete the system prompt file

### Beads Integration A — merged (branch: beads-integration)
- `runBd()` helper: `execFile` with `BEADS_DIR=<cwd>/.beads` env, `timeout: 15_000`
- `ensureBeadsInit()`: checks `beadsReady.has(cwd)` first; if `.beads/` dir exists skips init; uses `--stealth --non-interactive`; non-fatal (notifyFn on failure)
- `beadsReady` Map<string, boolean> at module scope; `beadsGuard()` inside export default fn
- All 7 tools registered between `fire` tool and `delegate` tool
- `bd dep add` arg order: `["dep", "add", blocked_id, blocker_id]` (blocked first)
- `bd close` + `bd update` responses are arrays — parsed with `[0]`; `bd create` is a single object
- `bd_list` uses `--limit=0` (avoids 50-item default cap) and `--status=open,in_progress` default
- Known open: `beads.role` not set after init → stderr warning on every `bd` call (non-blocking, cosmetic)
- Known open: `design` param silently dropped when `status === "closed"` in `bd_task_update`

### Known Open Items (non-blocking)
- `fmtTokens` imported in `index.ts` but never used — dead import, should be cleaned up
- `MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `extractMemoryEntries()` remain as dead exports in `utils.ts` — harmless
