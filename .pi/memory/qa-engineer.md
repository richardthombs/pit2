# Morgan Ellis — QA Engineer Memory

## Project: pit2

### bd CLI facts
- `bd comment <id> <text>` (no `--add` flag; positional text or `--file`/`--stdin`)
- `bd close <id>` to mark done; `--status=done` is invalid (valid: open, in_progress, blocked, deferred, closed, pinned, hooked)
- `bd` v1.0.3 (Homebrew) at `/opt/homebrew/bin/bd`
- Storage: **Dolt embedded** (not SQLite). No `.db` files. Data in `.beads/embeddeddolt/pit2/.dolt/`. PRAGMA journal_mode does not apply.
- `BEADS_DIR` env var controls which database is used for isolation in tests.
- bd detects `test-` prefix in titles and warns to stderr ("Creating test issue in production database") — cosmetic warning, exits 0.
- `bd delete <id> --force` works for cleanup; fallback `bd update <id> --status=deferred`.

### Concurrency test findings (pit2-xcg.5.2.6 — Suite A lite, 2026-05-02)
- 5 concurrent `bd create` × 3 rounds: **0/15 failures**
- `bd ready` during 5 concurrent creates × 5 rounds: **0/5 failures**
- Sequential creates then `bd ready` × 3 rounds: **0/3 failures**
- **Conclusion:** No concurrency failures at 5-parallel-creates scale. Dolt serialises writes correctly at this load level.

### Test infrastructure
- Isolated test DB: `cp -r .beads/ /tmp/test-beads-a-lite/` + `BEADS_DIR=/tmp/test-beads-a-lite`
- Node.js test scripts work well with `execFile` + `promisify` for concurrent bd calls.

### TypeScript baseline for broker/index (as of pit2-vsw.3, commit f5ce354)
- `npx tsc --noEmit` (no local `tsc`); baseline error count has drifted — was 71, confirmed **76 errors** as of pit2-xcg.16.2 review (2026-05-03). All pre-existing.
- Only acceptable new error per spec: `TS2307: Cannot find module '@mariozechner/pi-coding-agent'`.
- Use `git stash` / `git stash pop` to diff error counts against baseline when verifying "no new errors".

### Roster / dispatch architecture note
- `qa-engineer` label triggers broker dispatch (via `bd ready` → claim cycle). QA tasks are also EM-assigned manually. **Broker is actively running spurious agent sessions** against closed/in-progress QA tasks — not just failing claims gracefully. Confirmed: (1) agent ran pit2-vsw.4 a second time against a closed bead; (2) broker re-dispatched pit2-xcg.16.2 after I had already closed it (status=closed in bd, broker still dispatched). Severity: medium — wastes context, produces noise output. Fix: remove `qa-engineer` from broker roster OR add closed-status guard to claim step OR stop labelling QA tasks and use direct assignment only.

### broker.ts / index.ts structural notes
- `broker.configure()` is the injection point for all dependencies; constructor is empty.
- `liveMembers` map in index.ts uses key `${cwd}::${memberName}` — eviction deletes by this key.
- `_enqueueWrite` and `_enqueueMemoryPhase` are separate serialisation chains (per-cwd and per-role respectively).
- `captureResult` is now: closed-guard → 60 KB size check (throws) → `bd update --append-notes` → `bd close --reason`. All file-offload and metadata complexity removed (pit2-xcg.5.3.6).
- `waitForIdleOrExit(client, timeoutMs)` helper exists in **both** `index.ts` and `broker.ts` (duplicate by design — avoids circular import). If the helper ever needs fixing, **both copies must be updated**. All three `client.waitForIdle()` call sites replaced: index.ts:316 (initializeClientMemory), index.ts:529 (runTask), broker.ts:458 (memory update phase). `TASK_IDLE_TIMEOUT_MS` reduced to 120_000 (was 600_000). Empty `finally {}` in `_runAndClose` is dead syntax, not a bug (pit2-wfxn.1, approved pit2-wfxn.2).
- `drainInbox` (index.ts ~line 1121): outer try → catch → 200ms retry → inner catch logging `err.stderr`. `firstErr` not logged. Committed d4ac179 (pit2-vsw.5, approved).
- `agent_end` handler calls `drainInbox` without a `ctx.hasUI` guard — intentional. Subagents have `broker.active = false` (never call `broker.start`), so `drainInbox` exits immediately on the first guard. No hasUI check needed there.
- **session_start handler structure (post pit2-vsw.7):** Unconditional: `memberState/Usage/Timers.clear()`, `ensureBeadsInit` (notify callback wrapped in try/catch for subagent safety). Gated on `ctx.hasUI`: team notify, `updateWidget`, `fs.watch` roster watcher, idle reaper `setInterval`, `broker.start`, `drainInbox`, advisory notifications.
- Unhandled rejection crash paths fixed (pit2-vsw.3, commit f5ce354): `_enqueueWrite`/`_enqueueMemoryPhase` .catch handlers wrap `notifyEM` in try-catch; all 4 timer callbacks (scheduleWidgetRefresh, scheduleDoneReset, reaperInterval, rosterWatcher) add `.catch((err)=>{…})` to updateWidget calls; updateWidget body wrapped in double try-catch; session_start advisory notify calls wrapped in try-catch. All verified clean; pit2-vsw.4 closed. Minor residuals: (1) `notifyEM` inside `_enqueueMemoryPhase` inner catch lacks its own try-catch — no crash path (outer chain catch still guards), but can emit a secondary misleading error on stale sessions.
- **All `.catch(() => {})` silent catches eliminated (pit2-1rnz.15):** all 11 occurrences replaced. Any new `.catch(() => {})` is a regression.
- **All `console.error` calls fully eliminated (pit2-1rnz.17/18):** `logInbox(cwd, message)` defined in `utils.ts` (lines 56–67), imported in both `index.ts` and `broker.ts`. Zero `console.error` calls remain in either file — including the `scheduleInboxPing` line 856 that was misreported as "pre-existing/acceptable" in bead notes; it was also replaced. Any new `console.error` anywhere in either file is a regression. Bead notes from the implementer were inaccurate — always verify independently.
- `updateWidget` is fully internally guarded (two try/catch blocks) — cannot propagate a rejection in practice. All timer/event `.catch()` handlers on `updateWidget` now call `logInbox` (post pit2-1rnz.17).
- Reaper `setInterval` async callback has no outer try/catch — all internal awaits are individually guarded and `reapIdleClients()` is synchronous/non-throwing, so no current crash path. Watch for new code added to this block.
- **Audit pattern:** when checking `.catch()` coverage on a specific function, grep for bare calls to that function across the whole file, not just timer callbacks. Proximity bias can cause misses.
