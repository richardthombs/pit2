# Alex Rivera — Architect Memory

## Identity
Senior software architect on the pit2 project (AI-powered software engineering org built on pi coding agent framework).

## Key Codebase Landmarks

### Org Extension
- Main file: `/Users/richardthombs/dev/pit2/.pi/extensions/org/index.ts`

### Pi Framework
Installed at `/Users/richardthombs/.nvm/versions/node/v24.13.1/lib/node_modules/@mariozechner/pi-coding-agent`
- `dist/modes/rpc/rpc-client.js` + `rpc-client.d.ts` — **RpcClient** (long-running agent embedding API)
  - API: `start()`, `stop()`, `prompt()`, `waitForIdle()`, `compact()`, `newSession()`, `clone()`, `getLastAssistantText()`, `getSessionStats()`
  - Spawns child with `--mode rpc`; `args` array passed through to CLI at spawn time
- `dist/modes/rpc/rpc-types.d.ts` — full RPC protocol type definitions

### Design / Spec Docs
- `/Users/richardthombs/dev/pit2/.pi/docs/design-member-persistence.md` — Options A/B/C, ADR-004 (Proposed)
- `/Users/richardthombs/dev/pit2/.pi/docs/spec-member-persistence-implementation.md` — implementation spec (fully implemented)
- `/Users/richardthombs/dev/pit2/.pi/docs/spec-beads-integration-a.md` — Integration A (EM-only beads persistence) implementation spec

## Pitfalls / Gotchas

- **`cliPath`**: `RpcClient` hardcodes `node` as executor; must set `cliPath: process.argv[1]` for correct node-based invocation. Bun-compiled binary unsupported without patching.
- **`waitForIdle()` default is 60 s** — too short for real tasks; use 600_000 ms for task prompts, 30_000 ms for memory init.
- **`--append-system-prompt` + `newSession()`**: the flag is applied at spawn time; calling `newSession()` later may drop it. Unverified — worth checking if session cycling is ever added.
- **Concurrent EM sessions**: two EM sessions on the same project would share `liveMembers` state and conflict. Punted; no solution in place.
- **`resolveOrScale` guarantees idle-before-assign**: a named member that is busy gets a new clone hired instead. No `RpcClient` ever receives concurrent `prompt()` calls — safe assumption for all delegation modes.
- **Crash recovery**: `(client as any).process` is how you access the child process handle on `RpcClient` (not a public property); attach exit listener there.
- **Event type narrowing**: `AgentEvent.message_end.message` is typed as `AgentMessage`; check `.role === 'assistant'` and cast to `AssistantMessage` (from `@mariozechner/pi-ai`) to access `.usage`.
- **Member system prompt path**: `.pi/prompts/members/<slug>.md` — stable file used as the system prompt for each member's `RpcClient`.

## Beads (Integration A) — Key Decisions

- **7 registered tools** (not bash) for bd access: `bd_workstream_start`, `bd_task_create`, `bd_task_update`, `bd_dep_add`, `bd_list`, `bd_show`, `bd_ready`.
- **`BEADS_DIR=<ctx.cwd>/.beads`** env var drives all bd commands; set in `runBd` helper via `execFile` env option.
- **Init at `session_start`**: `ensureBeadsInit` checks if `.beads/` dir exists; runs `bd init --stealth --non-interactive` if not; sets `beadsReady` Map; non-fatal on failure.
- **`beadsReady` Map** keyed by `cwd`; `true`=ready, `false`=unavailable; tools check it via `beadsGuard()` inline helper.
- **`execFile` + `promisify`**: add `execFileCb` to the existing `node:child_process` import; add `promisify` from `node:util`.
- **`.beads/` in `.gitignore`**: confirmed — add to project root `.gitignore`.
- **SYSTEM.md insertion point**: new "Workstream State (Beads)" section between last "How to Work" para and `## Working Practices` heading.

## Beads CLI Verified Facts (Mercer Lin, 2026-05-01)

- **`bd create` flags**: `--type`, `--parent`, `--design`, `--notes` all valid. Returns **single object** `{id, title, ...}` — NOT array. Add `if (!result?.id) throw` defensively.
- **`bd update` flags**: `--status`, `--notes` (replace), `--append-notes` (append, preferred), `--design` valid. Returns **array** `[{...}]` — use `[0]`.
- **`bd show` flags**: `--json`. Returns **array** `[{...}]` — use `[0]`.
- **`bd close`**: preferred for marking completion. `bd close <id> --reason="..." --json`. Returns array. Sets `closed_at` correctly.
- **`bd dep add` arg order**: `bd dep add <blocked-id> <blocker-id>` — first arg IS blocked, second IS blocker. Counter-intuitive.
- **`bd list --status`**: comma-separated string `--status=open,in_progress`. Repeating the flag returns empty array (bug/quirk).
- **Valid statuses**: `open`, `in_progress`, `blocked`, `deferred`, `closed`, `pinned`, `hooked`. No `done`, no `cancelled`.
- **`bd init` needs `--non-interactive`** when stdin is not a TTY (always true in execFile).
- **`bd ready` includes epics** — use `--type=task` to filter to delegatable tasks only.
- **`bd` emits `beads.role` warning to stderr** on every command if not configured — doesn't corrupt JSON stdout but is noisy.
