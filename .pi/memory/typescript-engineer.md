# Sage Okonkwo — Memory

## Codebase

- Main extension file: `.pi/extensions/org/index.ts` (~1700 lines) — contains roster management, RPC client lifecycle, beads widget rendering, and all tool/command registrations.
- Supporting files: `.pi/extensions/org/broker.ts`, `.pi/extensions/org/utils.ts`
- Agent role definitions: `.pi/agents/<role>.md` (frontmatter + body = system prompt)
- Roster stored at `.pi/roster.json`
- Role-scoped memory files: `.pi/memory/<role>.md` (shared across members of same role)

## EM vs Subagent Session Discrimination

- `ctx.hasUI` is the reliable discriminator — `true` only in the EM's interactive session, `false` in RPC subagent sessions
- In `session_start`, all EM-only setup is gated on `ctx.hasUI`: roster notification, `updateWidget`, roster watcher, reaper interval, `broker.start()`, `drainInbox()`, advisory notifications
- `ensureBeadsInit` is intentionally unconditional — subagents need bd tools too; its notify callback is wrapped in try/catch for subagent safety
- `broker.active` stays `false` in subagent sessions (belt-and-suspenders guard in `drainInbox` now works correctly)

## RPC Client Helpers

- `waitForIdleOrExit(client, timeoutMs)` helper exists in both `index.ts` and `broker.ts` — races `client.waitForIdle()` against a 500ms process-exit poll; use instead of bare `client.waitForIdle()` everywhere
- `TASK_IDLE_TIMEOUT_MS` is 300_000 (5 min); `MEMORY_INIT_TIMEOUT_MS` is 30_000
- `broker.ts` intentionally avoids importing from `index.ts` (circular import risk) — any helper needing `RpcClient` must be defined locally in `broker.ts`; `utils.ts` has "no pi-runtime imports" so it cannot hold `RpcClient`-dependent utilities

## Broker / runBd

- `runBd(cwd, args, extraEnv?)` in `index.ts` — optional third arg merges into the `env` object alongside `BEADS_DIR`
- `RunBdFn` type in `broker.ts` mirrors this signature
- Claim calls use `BEADS_ACTOR: member.name` env var (not `--assignee` flag) for audit attribution
- `_runBdRetry` gives three attempts (immediate, 500 ms, 2 s) — use it for any bd write that can hit SQLite lock contention (close, notes-write, claim)
- `captureResult` uses `_runBdRetry` for both `--append-notes` and `close`; close failure is caught independently so the inbox write always fires
- `failureCounts` is a broker-instance Map that intentionally persists across `stop()`/`start()` — do not add `.clear()` to either method
- "Already claimed" in `_dispatchCycle`: member stays idle, warning sent to EM — do NOT set memberState to working
- Beads has **no claim-expiry mechanism** — a claimed task stays `in_progress` until manually closed; the EM must run `bd close <id>` to release it

## Logging

- `logInbox(cwd, msg)` is defined in `utils.ts` and imported in `index.ts` — appends a timestamped `[org:inbox]` line to `<cwd>/.pi/logs/org-inbox.log`; silently swallows write errors; creates the log dir on first use
- `utils.ts` restricts to "no pi-runtime imports" but Node.js built-ins (`node:fs`, `node:path`) are fine — `logInbox` uses both
- `drainInbox` uses `logInbox` for all error paths (bd list failure ~line 1234, close failure ~line 1247, sendUserMessage failure ~line 1259)
- Remaining `console.` lines in `index.ts`: ~383 (`console.warn`) and ~856 (`console.error` in `scheduleInboxPing`) — both outside `drainInbox`, intentional, leave alone

## TypeScript/Compilation

- Extensions loaded via `jiti` — no compilation step needed; `tsc --noEmit` for type-checking only
- Many pre-existing `implicit any` and missing-module errors in `tsc` output — not introduced by my changes, safe to ignore when verifying a targeted edit

## Beads Widget

- `BeadsTree` holds `nodes: BeadsTreeNode[]` (root epics only), `orphans: BeadItem[]` (tasks without an epic parent), and `closedOrphans: BeadItem[]` (recently-closed tasks without an epic parent)
- `BeadsTreeNode` has `bead`, `children`, `tasks`, and `closedTasks: BeadItem[]` (recently-closed tasks under this node)
- `BeadItem.status` includes `"closed"`; `BeadItem.closed_at?: string` for RFC3339 close timestamp
- `RECENTLY_CLOSED_WINDOW_MS = 15 * 60 * 1000` — closed tasks within this window appear in widget with `✓` symbol
- `refreshBeadsCache` fires two parallel `bd list` queries: open/in_progress + `--closed-after=<RFC3339>`; both wrapped in a single `try/catch` — if either throws, the entire refresh is skipped (cache preserved stale)
- `buildBeadsTree`: epics exclude closed ones; tasks split into `tasks` (non-closed) and `closedTasks` (closed) per node; same split for orphans
- `buildBeadsLines` uses a recursive `renderNode(node, indentStr, isLast, depth)` with `MAX_DEPTH = 4`
- `indentStr` accumulates by appending `"│   "` (not last) or `"    "` (last) at each depth level — produces correct box-drawing continuation lines
- `itemIdx` is unified across `children` and `tasks` in `renderNode` so the last item (regardless of type) correctly gets `"└─ "`
- `isLastNode` accounts for `closedOrphans` when determining last item in the orphan section
- `agent_end` handler calls `drainInbox` then `updateWidget` (EM-only via `ctx.hasUI`), unconditionally after drain completes
