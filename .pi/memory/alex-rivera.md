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
- `/Users/richardthombs/dev/pit2/.pi/docs/design-beads-scalability.md` — Full scalability analysis: 7 bottlenecks, Integration A–D designs, adoption sequence, limitations

## Pitfalls / Gotchas

- **`cliPath`**: `RpcClient` hardcodes `node` as executor; must set `cliPath: process.argv[1]` for correct node-based invocation. Bun-compiled binary unsupported without patching.
- **`waitForIdle()` default is 60 s** — too short for real tasks; use 600_000 ms for task prompts, 30_000 ms for memory init.
- **`--append-system-prompt` + `newSession()`**: the flag is applied at spawn time; calling `newSession()` later may drop it. Unverified — worth checking if session cycling is ever added.
- **Concurrent EM sessions**: two EM sessions on the same project would share `liveMembers` state and conflict. Punted; no solution in place.
- **`resolveOrScale` guarantees idle-before-assign**: a named member that is busy gets a new clone hired instead. No `RpcClient` ever receives concurrent `prompt()` calls — safe assumption for all delegation modes.
- **Crash recovery**: `(client as any).process` is how you access the child process handle on `RpcClient` (not a public property); attach exit listener there.
- **Event type narrowing**: `AgentEvent.message_end.message` is typed as `AgentMessage`; check `.role === 'assistant'` and cast to `AssistantMessage` (from `@mariozechner/pi-ai`) to access `.usage`.
- **Member system prompt path**: `.pi/prompts/members/<slug>.md` — stable file used as the system prompt for each member's `RpcClient`.

## Integration B Broker — Design Decisions (2026-05-01, updated 2026-05-01)

- **Full design doc**: `.pi/docs/design-beads-integration-b.md` — complete, standalone, includes ADR-005.
- **Broker lives in `broker.ts`** within the org extension (not a separate extension), instantiated by `index.ts`. Tight coupling to `resolveOrScale`, `runTask`, `memberState` makes a separate extension non-viable.
- **Event-driven via TS hooks, not beads events**: Beads has no pub/sub API. Broker is called synchronously from `bd_task_create` and `bd_task_update` tools after successful bd writes. 30s safety-net poll as fallback.
- **Role tagging uses native beads labels** (ADR-005): `bd_task_create` gets optional `role` param → `--label <role>` flag on `bd create`. Broker reads `task.labels?.[0]` from `bd ready --json` directly — **no `bd show` call needed for role routing**.
- **`bd ready --json` includes `labels[]`** confirmed from Go source (`ready.go`). Bare slugs work; `provides:` prefix hard-fails.
- **`bd show --json` `description` is `omitempty`** — absent if empty; check key presence. Not used for routing.
- **`resolveOrScale` must be extracted** from the `delegate` tool closure to module scope — prerequisite refactor. New sig: `resolveOrScale(cwd, roster, memberState, role?, member?)`. ~6 call sites to update.
- **Embedded mode viable** (no dolt server needed) because broker mediates all writes; agents have no direct `bd` access. Write serialisation queue needed for concurrent completions.
- **Broker is opt-in**: activated via `bd_broker_start` tool. `delegate` tool unaffected.
- **Stuck task recovery**: if `runTask` throws, broker resets task to `open` via `bd update --status=open` then notifies EM. 3-failure retry limit (in-memory) before skipping.
- **OQ-3 resolved**: `bd show --json` dep field is `"dependencies"` (array of full issue objects with `dependency_type`). Filter by `dependency_type === 'blocks'`. Field is `omitempty`. Full blocker data (title, notes, metadata) is embedded — no extra `bd show` per blocker needed. `extractBlockerContext(d)` replaces `fetchBlockerContext(id, cwd)` in `buildUpstreamContext`. `Broker.depMap` fallback removed.
- **OQ-4 resolved**: `bd close --reason` has no app-level length limit (64KB Dolt ceiling). 150-char cap is broker convention, not CLI constraint. `--reason-file` flag available for long content.
- **Open: OQ-2** — task brief for agents composed from `title + design`; requires one `bd show` per dispatch (not per poll). Acceptable.
- **ADR-005**: Proposed, documented in `design-beads-integration-b.md` §ADR-005.
- **Option 1/2/3 dispatch path analysis (2026-05-01)**: Recommendation is Option 3 (two coexisting paths). Option 1 breaks chain mode (`{previous}` substitution requires live output). Option 2 adds complexity without capability (forced bead creation, epic assignment problem, broker becomes redundant wrapper). `delegate`=imperative, broker=declarative queue drain — genuinely different patterns.
- **Label-as-ownership-signal invariant** (ADR-006): bead with role label = broker-owned; bead without label = EM-owned. Broker has explicit `if (!role) continue` guard — distinct from resolveOrScale failure path. ADR-006 documented in `design-beads-integration-b.md`.
- **OQ-2 resolved**: broker dispatches with minimal brief: `"Your task is described in bead <id>. BEADS_DIR=<cwd>/.beads bd show <id> --json. Then <verb>."` Agent self-serves context. Verb from `ROLE_VERBS` map in Broker class.
- **`bash` access gap**: `software-architect`, `technical-writer`, `prompt-engineer`, `documentation-steward` all lack `bash` in tools frontmatter. Must be added before broker can dispatch to these roles. Documented in §15 of design-beads-integration-b.md.
- **Remaining open questions**: OQ-1 (failure count tracking in-memory vs beads) and OQ-2 (multi-cwd broker) — both low priority.

## Integration B — Result Capture and Propagation (§17, 2026-05-01)

- **§17 appended** to `design-beads-integration-b.md`. Full design: capture heuristic, `captureResult()`, upstream findings injection, fan-in.
- **Capture heuristic**: `git log -1 --format=%H` before+after `runTask()`; SHA diff → file-change path; same SHA → text-output path.
- **`captureResult()` branches**: file-change → `--set-metadata git_commit=<sha>`; text ≤40KB → `--append-notes`; text >40KB → write `.pi/task-results/<id>.md` + `--set-metadata result_file=<path>`.
- **Close reason**: first non-empty line of output, markdown stripped, 150-char cap (OQ-4: CLI limit unverified).
- **Upstream injection**: at dispatch time, `bd show <taskId>` for blocker dep IDs (field name unverified — OQ-3); `bd show` each blocker; priority order for summary: `metadata.git_commit` > `metadata.result_file` > `notes[:300]`; compose to 2000-char cap; append to brief.
- **Dep field fallback**: if `bd show` dep field unavailable, `Broker.depMap: Map<taskId, Set<blockerId>>` populated by `bd_dep_add` tool hook.
- **Fan-in**: no special logic — §17.4 handles N blockers naturally. Agent synthesises.

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
