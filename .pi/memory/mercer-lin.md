# Mercer Lin — Memory

## Beads Repository

- Source: https://github.com/gastownhall/beads (latest commit `8694c53589f1`, 2026-04-30)
- Skill files (canonical agent docs): `claude-plugin/skills/beads/` in the repo; fetch via raw.githubusercontent.com
- Most important resource files: SKILL.md, DEPENDENCIES.md, WORKFLOWS.md, MOLECULES.md, AGENTS.md, ASYNC_GATES.md, BOUNDARIES.md, RESUMABILITY.md, INTEGRATION_PATTERNS.md
- `bd prime` auto-generates a live context summary; canonical source of truth per ADR-0001
- Version as of last research: 0.60.0

## Label System (Verified Against Source)

- **Native label system**: full CRUD — `bd label add/remove/list/list-all/propagate`
- **At creation**: `bd create "Title" -l software-architect --json` or `--label`
- **Via update**: `--add-label`, `--remove-label`, `--set-labels a,b,c` (set replaces all atomically)
- **Query**: `bd list --label x --json` (AND), `--label-any x,y` (OR), both work on `bd ready` too
- **`bd ready --json` INCLUDES labels**: `buildReadyIssueOutput` calls `GetLabelsForIssues` — no follow-up `bd show` needed
- **`bd swarm status --json` does NOT include labels**: summary counts only
- **Reserved namespace**: `provides:` prefix hard-fails on `bd label add`; use `bd ship` instead
- **`bd label add --json`** → array: `[{"status":"added","issue_id":"...","label":"..."}]`
- **`bd label list --json`** → array of strings: `["label1","label2"]`

## `bd show --json` Full Shape (Verified Against types.go)

- Returns **array** `[IssueDetails]` — parse with `[0]`
- `IssueDetails` = embedded `Issue` + `labels`, `dependencies`, `dependents`, `comments`, `parent`, epic progress fields
- `description` is `omitempty` — **absent entirely if empty**; broker must handle missing key gracefully
- Same omitempty: `design`, `notes`, `acceptance_criteria`, `assignee`, `close_reason`, `external_ref`, `metadata`
- `priority` has **no omitempty** — always present, even at 0 (P0)
- `dependencies`/`dependents` entries include `dependency_type` field (e.g., `"blocks"`, `"parent-child"`)
- `parent` field is computed from parent-child dep and added at JSON serialization time

## Key Beads Facts (Expensive to Rediscover)

### JSON Response Shapes (Verified Against Live `bd` v1.0.3)
- `bd create --json` → **single object** `{id, title, issue_type, status, ...}`
- `bd update --json` → **array** `[{id, title, status, ...}]` — parse with `[0]`
- `bd show --json` → **array** `[{...}]` — parse with `[0]`
- `bd close --json` → **array** `[{id, closed_at, close_reason, ...}]`
- `bd dep add --json` → **single object** `{issue_id, depends_on_id, type, status: "added"}`
- `bd list --json` → array; `bd ready --json` → array
- `beads.role` warning goes to **stderr** — stdout JSON is always clean

### `bd dep add` Argument Order (Critical, Counterintuitive)
- `bd dep add <blocked-id> <blocker-id>` — first arg IS blocked, second IS the blocker
- Equivalently: `bd dep add <blocked-id> --depends-on=<blocker-id>`
- Wrong order silently creates inverted dependency — no error, just wrong `bd ready` output

### Valid Status Values
- `open`, `in_progress`, `blocked`, `deferred`, `closed`, `pinned`, `hooked`
- **No `done` status** — use `bd close` to mark completion
- `bd close <id> --reason="..."` sets `closed_at` + `close_reason`; prefer over `bd update --status=closed`

### `bd list --status` Multi-value Syntax
- `--status=open,in_progress` ✅ (comma-separated, single flag)
- `--status open --status in_progress` ❌ returns empty array

### Other Flags Confirmed
- `bd create`: `--type`, `--parent` (not `--epic-id`), `--design`, `--notes`, `--json`
- `bd update`: `--append-notes` exists (appends vs `--notes` which replaces)
- `bd init`: requires `--non-interactive` in non-TTY (execFile) context
- `bd create --type`: accepts `epic|task|bug|feature|chore|decision`; default `task`
- `bd dep add --type`: default is `blocks` (redundant to specify but harmless)
- `bd list` default limit: 50 — use `--limit=0` for all results
- `bd ready --type=task` filters out epics (which otherwise appear in ready output)

### Bugs Found in spec-beads-integration-a.md §3.6 (Alex Rivera)
- Tool 4 `bd_dep_add`: blocker/blocked IDs in wrong order in the `runBd` call
- Tool 3 `bd_task_update`: uses `"done"` status (invalid) and parses `bd update` as single object
- Tool 6 `bd_show`: parses `bd show` as single object (should be `[0]`)
- All documented in `/Users/richardthombs/dev/pit2/.pi/docs/beads-em-reference.md`



- **Embedded mode is single-writer** (file-locked). Multi-agent concurrent writes require Server mode (`bd init --server` → external `dolt sql-server`).
- **Atomic claim**: `bd update <id> --claim` atomically sets assignee + in_progress in one command; prevents double-assignment in multi-agent scenarios.
- **`bd ready`** computes the "ready front" automatically — only `blocks` dep type affects it; `related`, `parent-child`, `discovered-from` are informational only.
- **Wisps** (`bd mol wisp`) are ephemeral issues stored in `.beads-wisp/`, NOT synced to git/Dolt — designed for ephemeral orchestration that shouldn't pollute the audit trail.
- **Agent beads** (`--type=agent`) are first-class: state machine (idle/spawning/running/working/stuck/done/dead), slot `hook` = current work item, slot `role` = role definition bead. Witness system monitors heartbeats.
- **Async gates** (`bd gate`) block a workflow on external conditions: human approval, CI run, PR merge, timer, mail. Auto-close via `bd gate eval`.
- **Git-free operation**: `BEADS_DIR=/path/.beads bd init --stealth` — no git required.
- **JSON output**: every command supports `--json`; structured for programmatic consumption.
- **`bd swarm status <epic-id> --json`** returns `{ready, active, blocked, completed, progress_percent, ready_count, ...}` — the richest single-call signal for a broker; re-derives state from live graph
- **`bd show --watch`** polls at 2-second interval using `id:status:updatedAt_nanoseconds` snapshot comparison — CLI-only, single-issue, NOT a broker API
- **File watching on `.beads/` is explicitly broken** — Dolt embedded mode writes don't produce filesystem events; `inotify`/`chokidar`/`fsnotify` will never fire
- **No event system exists** — no webhook, stream, callback, or pub/sub in v0.60.0; `bd daemon` referenced in README but `daemon.go` absent from main branch (unmerged PR #433)
- **`bd close --suggest-next`** flag shows newly unblocked issues after a close — useful for a broker that calls `bd close` itself to get near-zero latency on close events
- **`bd prime`** is prose Markdown for LLM context injection, not structured data — brokers should call `bd ready --json` or `bd swarm status --json` instead

## pit2 Architecture (Relevant to Beads Integration)

- EM is sole coordinator; subagents are stateless (fresh context per delegation)
- All coordination state is in EM's conversation context — no persistent task store
- `delegate` tool spawns pi subprocesses; `chain` = sequential, `tasks` = parallel
- Member memory files at `.pi/memory/<member-id>.md` provide per-member persistence, NOT shared task state
- EM uses workstream labels for async result correlation — fragile across context compaction
- No dependency graph, no work queue, no agent state persistence across sessions

## Storage Capabilities (Verified Against Schema + Source)

### Field size limits (from `0001_create_issues.up.sql`)
- `notes TEXT` → **64KB hard cap** (MySQL TEXT type = 65,535 bytes). No app-level check; ceiling is enforced by Dolt only.
- `description TEXT`, `design TEXT`, `acceptance_criteria TEXT` → same 64KB cap
- `external_ref VARCHAR(255)` → 255 bytes; indexed; for short external refs ("gh-123", URLs)
- `spec_id VARCHAR(1024)` → 1KB; indexed; for specification document links
- `metadata JSON` → effectively unlimited (~1GB, stored as LONGBLOB in Dolt)
- `title VARCHAR(500)` → 500 chars; enforced at application level in `types.go Validate()`

### `--append-notes` is NOT uncapped
- Implemented as pure string concat in `update.go` with **zero length check** before DB write
- The ceiling is Dolt's TEXT column limit (64KB), not an app-level guard
- Hitting the cap will produce a Dolt error, not a clean beads error

### No attachment mechanism
- No `bd attach` command; no attachment table in any of the 32 schema migrations
- beads is not an artifact store

### `metadata JSON` is the right field for artefact references
- Go type comment: "tool annotations, file lists, etc." — explicitly designed for this use
- Supports incremental edits: `--set-metadata key=value`, `--unset-metadata key`
- `bd show --json` returns full metadata verbatim (no truncation anywhere in JSON path)
- Pattern for Integration B: agent writes artifact to file/git, stores ref in metadata:
  `bd update <id> --set-metadata result_file=/path/to/result.json --set-metadata git_commit=<sha>`

### `bd show --json` — no truncation
- JSON path in `show.go` serialises full `IssueDetails` struct with `outputJSON(allDetails)` — no truncation, pagination, or max-length check anywhere
- Full `notes`, `metadata`, `description`, etc. returned verbatim

## Integration Recommendations (From First Analysis)

- **Best quick win**: EM uses bd to persist workstream state + decision rationale; survives context compaction; subagents don't need bd access (lowest friction)
- **For horizontal scaling**: bd as shared work queue — EM populates, agents claim via `bd update --claim`; requires Server mode for concurrent writes
- **`bd gate`** maps naturally to pit2's async delegation pattern — gates could encode "wait for task A before dispatching task B" outside EM context window
- **Wisps** are well-suited for ephemeral per-workstream orchestration state (don't pollute audit trail)
- **Mismatch**: pit2 subagents are stateless/ephemeral, so `type=agent` beads with heartbeats don't fit naturally — agents can't maintain running heartbeat state
- **Mismatch**: Not every delegation warrants a bead — BOUNDARIES.md `bd vs TodoWrite` test applies; only multi-session or complex-dependency work merits tracking
