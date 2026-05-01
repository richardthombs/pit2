# Morgan Ellis — QA Memory

## Project: pit2 — multi-agent engineering organisation (pi extension)

### Codebase Landmarks
- Extension entry: `.pi/extensions/org/index.ts`
- Pure utilities: `.pi/extensions/org/utils.ts` (no pi-runtime deps — safe to test in isolation)
- Team roster: `.pi/roster.json` (managed via `loadRoster`/`saveRoster`)
- Agent role definitions: `.pi/agents/<role>.md` (frontmatter + body)
- Member memory files: `.pi/memory/<member-id>.md` (e.g. `morgan-ellis.md`)

### Architecture Notes
- Commit `336406d` refactored memory from per-role (structured `<!-- MEMORY -->` blocks) to per-member (free-form file read/write by the agent itself)
- `appendToRoleMemory()` and `extractMemoryEntries()` were removed in that commit as dead code
- `getMemoryPath()` was also dead (no callers) — now removed from index.ts ✓
- `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `MEMORY_DIR` were dead imports in index.ts — now removed ✓

### Current Dead Code in utils.ts (non-blocking)
- `MEMORY_DIR`, `VALID_MEMORY_SECTIONS`, `MAX_MEMORY_ITEMS_PER_SECTION`, `extractMemoryEntries()` remain as dead exports in utils.ts
  — they were not removed from utils.ts as part of this cleanup (not required by spec)
  — lower priority than index.ts cleanup; harmless

### New Dead Import Found (2026-04-30, second review)
- `fmtTokens` is imported from utils.ts in index.ts (line 28) but never used in index.ts
  — not one of the four target symbols in this review cycle
  — should be cleaned up in a future pass

### QA Decisions
- 2026-04-30 (first review): Approved with notes — dead code removal was clean but left 3 residual items in index.ts (getMemoryPath, VALID_MEMORY_SECTIONS, MAX_MEMORY_ITEMS_PER_SECTION). Non-blocking.
- 2026-04-30 (second review): APPROVED — all four target symbols are gone from index.ts. One additional minor issue found: `fmtTokens` is a dead import not part of this cleanup scope.

### Persistent RpcClient per Member (2026-05-01, fifth review)
- Feature: `runTask()` refactored from per-task `spawn` to persistent `RpcClient` per named member
- New module-scope additions: `LiveMemberEntry` interface, `liveMembers` Map, `liveMemberKey()`, `memberSystemPromptPath()`, `buildMemberSystemPromptFile()`, `initializeClientMemory()`, `getOrCreateClient()`, `reapIdleClients()`, `stopLiveClient()`
- New imports: `RpcClient`, `RpcClientOptions` from `@mariozechner/pi-coding-agent`; `AssistantMessage`, `TextContent` from `@mariozechner/pi-ai`
- System prompt written to `.pi/prompts/members/<slug>.md` (stable, per-member)
- Memory injected once as first message (`initializeClientMemory`), not on every task
- Idle reaper: 60s interval, 10-minute idle timeout — started in `session_start`, torn down in `session_shutdown`
- `/fire` and `fire` tool both call `stopLiveClient()` + delete system prompt file (above spec)

**QA Findings (2026-05-01):**
- MEDIUM: `TASK_IDLE_TIMEOUT_MS = 300_000` (5 min) — spec says 600_000 (10 min). Should be corrected.
- Minor: `throw err` replaced by generic `new Error("Member process crashed...")` — original error detail lost
- Minor: `spawn` is a dead import after refactor; file-header comment still says "spawns a subprocess" (stale)
- Low: `initializeClientMemory()` is outside try/catch in runTask — timeout path leaves member unusable until reaper
- QA: APPROVED WITH NOTES (finding 1 should be fixed before shipping)

### Three Documentation Fixes Verified (2026-05-01, seventh review)
- Fix 1 (AGENTS.md): "no memory of previous sessions" → persistent memory files + fresh context window sentence ✓
- Fix 2 (SYSTEM.md): "Delegate clearly" bullet updated correctly ✓
  — BUT: unannounced `## Working Practices` section (~16 lines, 6 archetypes) also added in same diff; not in HEAD previously; not mentioned in task brief
  — Content coherent and non-harmful, but out-of-scope; flagged to EM
- Fix 3 (README.md): spawn command now includes `--system-prompt ""` and `--no-context-files` ✓
- QA: APPROVED WITH NOTES (Working Practices addition needs explicit acknowledgement)

### Four Targeted Fixes Verified (2026-05-01, sixth review)
- Fix 1: `TASK_IDLE_TIMEOUT_MS = 600_000` with comment "10 minutes" ✓
- Fix 2: catch block in `runTask()` uses `${err?.message ?? err}` in message + `.cause = err` ✓
- Fix 3: `spawn` removed from `node:child_process` import; `type ChildProcess` retained; header comment updated ✓
- Fix 4: `initializeClientMemory()` wrapped in try/catch that calls `stopLiveClient()` + re-throws ✓
- `fmtTokens` dead import still present (pre-existing, non-blocking)
- QA: APPROVED

### tools: write+edit added to five agent role definitions (2026-04-30, fourth review)
- Files: `beads-specialist.md`, `pi-specialist.md`, `qa-engineer.md`, `release-engineer.md`, `software-architect.md`
- All five `tools:` lines match spec exactly; no other lines modified in any file
- `release-engineer.md` had tools reordered (`bash, read` → `read, write, edit, bash`) as a side-effect — correct
- QA APPROVED

### Memory Template Feature (2026-04-30, third review)
- New file `.pi/prompts/memory.md` — template for the memory identity block with `[name]` and `[path]` placeholders
- Change is unstaged (working directory) not yet committed; template file is untracked
- `runTask()` now loads template via `fs.readFileSync` in an inner try/catch; fallback is the old hardcoded string
- QA APPROVED WITH NOTES: one trailing-newline discrepancy between template-derived and fallback memBlock — non-blocking
- `fmtTokens` dead import in index.ts still present (noted in previous cycle, still not cleaned up)
