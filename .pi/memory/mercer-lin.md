# Mercer Lin — Memory

## Beads Repository

- Source: https://github.com/gastownhall/beads (latest commit `0fa5f210f41af9f03b1888480ce5c7ec97c03eb4`, 2026-05-02)
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
- **`dependencies` = what THIS issue depends on (its blockers)**; `dependents` = what depends on THIS issue (downstream)
- Each element is a **full embedded `Issue` object** + `dependency_type` string — broker gets blocker title/status/notes in one call, no follow-up needed
- `dependencies` is `omitempty` — absent entirely when task has no deps; broker must handle missing key
- To get only true blockers: filter `dependencies` where `dependency_type == "blocks"` (other values: `"related"`, `"parent-child"`, `"discovered-from"`)

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
- `bd create`: `--type`, `--parent` (not `--epic-id`), `--design`, `--notes`, `--json`, `--deps`
- `bd update`: `--append-notes` exists (appends vs `--notes` which replaces)
- `bd init`: requires `--non-interactive` in non-TTY (execFile) context
- `bd create --type`: accepts `epic|task|bug|feature|chore|decision`; default `task`
- `bd dep add --type`: default is `blocks` (redundant to specify but harmless)
- `bd list` default limit: 50 — use `--limit=0` for all results
- `bd ready --type=task` filters out epics (which otherwise appear in ready output)

### `bd create --deps` — Inline Dependency Creation (Verified Against create.go)
- Flag: `--deps="A,B,C"` (comma-separated, bare IDs or `type:id` format)
- **Bare ID** (no colon): new task IS BLOCKED BY the listed ID — correct for fan-in pattern
- **`blocks:X`** (explicit with colon): SWAPS direction — new task BLOCKS X (counterintuitive, don't use for fan-in)
- **`discovered-from:X`**, **`related:X`**: work as expected (no swap)
- **Atomicity in embedded mode**: `CreateIssue` writes to Dolt working set (no commit); deps also written to working set; single `store.Commit()` at end — issue + deps committed together, zero `bd ready` race window
- **Atomicity in server mode**: `CreateIssue` commits internally first, then deps added — race window EXISTS (not relevant for pit2 today)
- `--graph <file.json>`: batch-creates a whole issue graph atomically from JSON — alternative for multi-issue fanout materialisation

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

### Storage schema — confirmed against source (migration path: `internal/storage/schema/migrations/`)

**`issues` table TEXT fields (all 64KB Dolt-enforced, zero app-level length check except title):**
- `title VARCHAR(500) NOT NULL` → app-enforced: required + max 500 chars in `Validate()`
- `description TEXT NOT NULL` → 64KB, no app check
- `design TEXT NOT NULL` → 64KB, no app check
- `acceptance_criteria TEXT NOT NULL` → 64KB, no app check
- `notes TEXT NOT NULL` → 64KB, no app check; `--append-notes` does NOT pre-check length before DB write
- `close_reason TEXT DEFAULT ''` → 64KB, no max app check; `validation.on-close` only warns on short reasons
- `payload TEXT DEFAULT ''` → 64KB; for `type=event` audit beads
- `waiters TEXT DEFAULT ''` → 64KB; comma-separated mail addresses for gate notifications
- `external_ref VARCHAR(255)` → 255 chars; indexed; no app check
- `spec_id VARCHAR(1024)` → 1KB; indexed; no app check
- `metadata JSON` → ~1GB (LONGBLOB in Dolt); **must be valid JSON** (json.Valid check in Validate())
- `source_repo VARCHAR(512)` → 512 chars; internal routing, not synced

**`comments` table:**
- `text TEXT NOT NULL` → 64KB; required (NOT NULL); no app length check
- `author VARCHAR(255) NOT NULL` → 255 chars; required

**`dependencies` table:**
- `metadata JSON` → ~1GB; no app validation
- `thread_id VARCHAR(255)` → 255 chars; groups replies-to edges

**Critical gotchas:**
- `--append-notes` is pure string concat; no pre-write length check; hits 64KB silently
- `title` is the ONLY field with bilateral app enforcement (required + max 500)
- `metadata` is the only practically unlimited field → use it for artifact refs, not notes
- `source_formula` and `source_location` are in types.go but NOT in 0001 migration — added by later ALTER TABLE; short internal strings
- Migrations live at `internal/storage/schema/migrations/` (NOT `cmd/bd/store/migrations/`)

## broker.ts — Notes Ceiling Bug (Verified Against Source)

- File: `/Users/richardthombs/dev/pit2/.pi/extensions/org/broker.ts`
- `TEXT_CAP = 40 * 1024` (40 KB) — guards **output size only**; does NOT fetch existing `notes` length before `--append-notes`
- **Risk**: on a successful retry, `existing_notes + new_output` can exceed 65,535 bytes → raw Dolt error
- **Silent failure path**: Dolt error propagates out of `captureResult` → absorbed by `writeQueue.set(cwd, next.catch(() => {}))` → task permanently stuck in `in_progress`, EM never notified, output lost
- **Fix A**: Before text-append branch, do `bd show` to get current notes length; compute `remaining = NOTES_CEILING - currentNotesLength`; use file-offload path if `output.length > remaining`
- **Fix B**: In `_runAndClose`, wrap `captureResult` enqueue with `.catch(err => notifyEM(...))` so stuck tasks are visible
- `NOTES_CEILING` constant not yet defined — needs adding alongside `TEXT_CAP`

## Integration Recommendations (From First Analysis)

- **Best quick win**: EM uses bd to persist workstream state + decision rationale; survives context compaction; subagents don't need bd access (lowest friction)
- **For horizontal scaling**: bd as shared work queue — EM populates, agents claim via `bd update --claim`; requires Server mode for concurrent writes
- **`bd gate`** maps naturally to pit2's async delegation pattern — gates could encode "wait for task A before dispatching task B" outside EM context window
- **Wisps** are well-suited for ephemeral per-workstream orchestration state (don't pollute audit trail)
- **Mismatch**: pit2 subagents are stateless/ephemeral, so `type=agent` beads with heartbeats don't fit naturally — agents can't maintain running heartbeat state
- **Mismatch**: Not every delegation warrants a bead — BOUNDARIES.md `bd vs TodoWrite` test applies; only multi-session or complex-dependency work merits tracking
