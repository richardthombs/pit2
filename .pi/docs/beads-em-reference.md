# Beads EM Reference

**For:** Alex Rivera (spec-beads-integration-a.md) and implementing engineers  
**Source:** `gastownhall/beads` repo, `bd` v1.0.3 (Homebrew) / docs v0.60.0  
**Verified:** All commands tested against live `bd` binary, 2026-05-01  
**Author:** Mercer Lin  

---

## Contents

1. [Exact `bd` Commands](#1-exact-bd-commands)  
2. [Recommended Field Usage for pit2](#2-recommended-field-usage-for-pit2)  
3. [The Single-Writer Constraint](#3-the-single-writer-constraint)  
4. [Granularity Guidance](#4-granularity-guidance)  
5. [Gotchas for the EM Use Case](#5-gotchas-for-the-em-use-case)

---

## 1. Exact `bd` Commands

All commands should be run with `BEADS_DIR=<cwd>/.beads` set in the environment (not as a flag). Use `--json` on every command that produces output — it suppresses the pager and gives structured data. Warnings go to stderr; stdout JSON is always clean.

### `bd init`

```bash
# One-time setup. --stealth disables git hooks and all git ops.
# --non-interactive suppresses prompts (needed for programmatic use).
BEADS_DIR=<cwd>/.beads bd init --stealth --non-interactive
```

**Flag notes:**
- `--stealth` sets `no-git-ops: true` in config. This is correct for the EM's use case — we don't want hooks or commits.
- `--non-interactive` is required when stdin is not a TTY (always true in `execFile`). Without it, `bd init` may wait for input.
- Do **not** use `--server`. Server mode requires an external `dolt sql-server` process. Embedded mode (the default) is correct for a single-writer EM.
- `--quiet` (`-q`) can be added to suppress the "Initialized" message, but is optional since stdout is ignored on init.

---

### `bd create`

```bash
# Create an epic
bd create "auth-refactor" --type=epic --design="Rationale text" --json

# Create a task, attached to an epic
bd create "Implement OAuth2 flow" --type=task --parent=<epic-id> --design="Rationale text" --json

# Create a task with initial notes (rare at creation time — prefer bd update for notes)
bd create "Implement OAuth2 flow" --type=task --parent=<epic-id> --notes="Initial context" --json
```

**JSON response shape (verified):** Single object, not an array:
```json
{
  "id": "pit2-a3f8",
  "title": "auth-refactor",
  "issue_type": "epic",
  "status": "open",
  "priority": 2,
  "created_at": "...",
  "created_by": "...",
  ...
}
```
Access the ID as `result.id` (not `result.issue_id`, not `result.data.id`).

**Flag names (verified against `bd create --help`):**

| Purpose | Flag | Notes |
|---------|------|-------|
| Issue type | `--type=epic\|task\|bug\|feature\|chore\|decision` | Short: `-t`. Default: `task` |
| Parent epic | `--parent=<id>` | Attaches as hierarchical child. Auto-assigns dotted ID, e.g. `epic-id.1` |
| Description | `--description="text"` or `-d` | Problem statement, not rationale |
| Design/rationale | `--design="text"` | Why the work is being done |
| Notes | `--notes="text"` | Initial state; prefer `bd update --notes` post-creation |
| Priority | `--priority=0-4` or `-p` | Default: 2 (medium) |
| JSON output | `--json` | Always include for programmatic use |

**Common mistakes:**
- `--type` is the correct flag, not `--issue-type`. The value `epic` works; aliases like `enhancement` and `feat` also work for `feature`.
- `--parent` is the correct flag for attaching to an epic, not `--epic` or `--epic-id`.
- Do not use `--stdin` or `--body-file` unless description text contains special shell characters (backticks, `$`, nested quotes). For normal rationale text, `--design="text"` is safe.

---

### `bd update`

```bash
# Mark a task done (use bd close, not --status=closed — see §5.5)
bd close <id> --reason="Concise findings summary" --json

# Mark a task in_progress
bd update <id> --status=in_progress --json

# Write notes after a delegation completes
bd update <id> --notes="COMPLETED: X. KEY DECISION: Y." --json

# Append to existing notes (preserves previous notes)
bd update <id> --append-notes="Further finding: Z." --json

# Update design field (if approach changed during execution)
bd update <id> --design="Updated rationale" --json

# Atomic claim (sets assignee + in_progress in one write — not needed for EM-only use)
bd update <id> --claim --json
```

**JSON response shape (verified):** **Array** of one object, not a single object:
```json
[
  {
    "id": "pit2-a3f8",
    "title": "...",
    "status": "in_progress",
    ...
  }
]
```
Parse with `JSON.parse(stdout)[0]`, not `JSON.parse(stdout)`.

**Flag notes:**
- `--append-notes` **exists** and is the safe default for recording findings. It appends with a newline separator, preserving prior notes. Use `--notes` only when replacing the entire notes field is intentional (e.g., a clean session-start handoff).
- **Valid status values**: `open`, `in_progress`, `blocked`, `deferred`, `closed`. There is **no `done` status** — use `closed`.
- **Prefer `bd close <id>` over `bd update --status=closed`** for marking completion. `bd close` sets `closed_at` correctly and supports `--reason` (stored as `close_reason`). `bd update --status=closed` also works but does not accept `--reason`.

---

### `bd dep add`

```bash
# "task-A blocks task-B" (task-B cannot start until task-A is done)
bd dep add <blocked-id> <blocker-id> --type=blocks --json

# Equivalent alternative syntax using flags instead of positional args
bd dep add <blocked-id> --blocked-by=<blocker-id> --type=blocks --json
# or:
bd dep add <blocked-id> --depends-on=<blocker-id> --type=blocks --json
```

**⚠️ Critical argument order (verified):**
- **First positional arg** = the issue that IS blocked (cannot start yet)
- **Second positional arg** = the blocker (must complete first)

This is the reverse of what intuition suggests. The mnemonic: *"First arg depends on second arg."*

Examples:
```bash
# task-001 (implement) blocks task-002 (QA):
bd dep add task-002 task-001 --type=blocks   # ✅ correct
bd dep add task-001 task-002 --type=blocks   # ❌ WRONG — inverts the dependency
```

To verify after adding, run `bd blocked --json`. The issue listed there is the one being blocked — it should be the *second* step in the chain.

**Flag notes:**
- `--type` defaults to `"blocks"`, so `--type=blocks` is redundant but harmless and makes intent explicit.
- The `--type` flag also accepts: `tracks`, `related`, `parent-child`, `discovered-from`, `until`, `caused-by`, `validates`, `relates-to`, `supersedes`. Only `blocks` affects `bd ready` output.
- **JSON response shape**: Single object (not array): `{issue_id, depends_on_id, type, status: "added", ...}`

---

### `bd list`

```bash
# List all open+in_progress issues (recommended default for state reconstruction)
bd list --status=open,in_progress --json

# Filter by type
bd list --type=epic --status=open --json
bd list --type=task --status=open,in_progress --json

# Include closed issues (for full history)
bd list --all --json

# The default bd list (no --status flag) also returns open issues; explicit is cleaner
```

**Flag notes:**
- `--status` accepts a **comma-separated string**: `--status=open,in_progress`. Repeating the flag (`--status open --status in_progress`) returns an empty array — this is a bug/quirk.
- The default limit is 50 (`-n 50`). For a small EM workload this is fine; add `--limit=0` for unlimited.
- `--no-pager` suppresses the pager. Not needed when called via `execFile` (no TTY), but harmless to include.
- **JSON response shape**: Array of objects. Returns `[]` (empty array) when nothing matches, not null.

---

### `bd show`

```bash
# Show a single issue with full detail
bd show <id> --json

# Show with all extended fields (gate status, agent identity, etc.) — rarely needed
bd show <id> --json --long
```

**JSON response shape (verified):** **Array** of one object:
```json
[
  {
    "id": "pit2-a3f8",
    "title": "...",
    "design": "...",
    "notes": "...",
    "status": "...",
    "dependencies": [...],
    "dependents": [...],
    ...
  }
]
```
Parse with `JSON.parse(stdout)[0]`.

---

### `bd ready`

```bash
# Get the ready front — issues with no unresolved blockers
bd ready --json

# Filter to tasks only (excludes epics, which also appear in ready output)
bd ready --type=task --json

# Filter to a specific epic's tasks
bd ready --parent=<epic-id> --json
```

**Important distinction (`bd ready` vs `bd list --ready`):**
> "`bd list --ready` is NOT equivalent — it only filters by `status=open`."  
> — `bd ready --help`

Always use `bd ready`, not `bd list --ready`, to get the true unblocked front.

**JSON response shape (verified):** Array. Returns all open issues with no blocking dependencies. **Epics appear here too** if they have no blockers — use `--type=task` if the EM only wants delegatable tasks.

---

### `bd close`

```bash
# Mark an issue complete (preferred over bd update --status=closed)
bd close <id> --reason="Summary of what was done / key findings" --json

# Close multiple at once
bd close <id1> <id2> <id3> --reason="Batch close" --json
```

**JSON response shape (verified):** Array of closed objects, each with `closed_at` and `close_reason` fields.

---

## 2. Recommended Field Usage for pit2

### Field-by-field guidance for the EM

| Field | Flag | Use it for | Leave blank when |
|-------|------|------------|-----------------|
| `title` | positional or `--title` | Short, unique name. Should match the workstream `[label]` the EM uses in delegation notes. | Never — required. |
| `description` | `--description` / `-d` | Problem statement, stakeholder request context. "What needs to happen and why the stakeholder asked." | Acceptable to omit if `design` covers it. |
| `design` | `--design` | **Decision rationale**: why this workstream was started, what constraint or requirement prompted it, key trade-offs considered. Written for a future EM that has no conversation context. | Short unambiguous tasks where the title is self-explanatory. |
| `notes` | `--notes` / `--append-notes` | **Post-execution findings**: key outputs, decisions made during execution, artefacts produced, caveats. Written after delegation returns. Use `--append-notes` for iterative updates. | At creation time. Notes belong to the execution record, not the plan. |
| `type` | `--type` | `epic` for workstreams, `task` for individual delegations. | — |
| `priority` | `--priority` / `-p` | Optional. Use `0`=critical, `1`=high if the EM needs to triage. Default `2` (medium) is fine for most cases. | When all work is equal priority. |
| `assignee` | `--assignee` / `-a` | Not needed for the EM's use case. The EM does not claim its own tasks; it tracks completion by calling `bd close`. The `--claim` flag is for multi-agent concurrency scenarios (Server mode). | Always omit for Integration A. |
| `acceptance` | `--acceptance` | Not needed for the EM's use case. Acceptance criteria are for agent beads or human-reviewed work. | Always omit for Integration A. |

### What to write in `design`

`design` is captured at **creation time**, before delegation. It answers: *"Why are we doing this, and what were the key constraints?"*

Good:
> "Required to support OAuth2 sign-in. Stakeholder request from onboarding-team on 2026-04-28. Must not break existing session tokens."

Bad:
> "Implement OAuth2 using the RFC 6749 code flow with PKCE extension, then add refresh endpoints." ← This is implementation detail (a plan), not rationale.

### What to write in `notes`

`notes` is updated **after delegation returns**, using `bd update --notes` or `bd close --reason`. It answers: *"What actually happened, and what does a future EM session need to know?"*

Good (for `bd close --reason`):
> "COMPLETED: OAuth2 code flow implemented. Added /auth/callback endpoint. Refresh token uses 7-day TTL. CAVEAT: legacy sessions still use JWTs; migration task not in scope here."

Bad:
> "Done." or pasting raw subagent output.

---

## 3. The Single-Writer Constraint

### What it means

Embedded mode (the default — `bd init` without `--server`) runs the Dolt engine **in-process** with a file lock on `.beads/`. Only one process can write at a time.

**The file lock is enforced at the OS level.** If two processes attempt concurrent writes, the second one will block waiting for the lock, then fail or timeout. It does not silently corrupt data.

### What this means for the EM

In Integration A, the EM is the only writer. This is fine. The single-writer constraint is not a problem here.

The constraint **would matter** if:
- Multiple EM instances ran concurrently (not possible in pit2's current design — one EM per session)
- Subagents were also given `bd` write access (explicitly out of scope for Integration A)
- A CI process or external tool was also writing to the same `.beads/` concurrently

### Symptoms if the constraint is violated

- `bd` command hangs for several seconds, then returns an error mentioning "database is locked" or "failed to acquire lock"
- In logs: `Error: database locked` or `lock timeout`

### What the EM needs to know

1. **Never** run two `bd` commands concurrently in the same `cwd`. The EM's `runBd` helper must await each call before starting the next.
2. If `runBd` is ever called from multiple tool calls in parallel (e.g., if pit2 ever parallelises tool execution), this will deadlock. Serialise all `bd` calls for Integration A.
3. The 15-second timeout in `runBd` should be sufficient — a lock contention scenario in a single-writer setup would be a bug, not normal operation.

### Server mode (future reference)

If pit2 ever moves to concurrent multi-agent writes (Integration B or beyond), the upgrade path is:
```bash
# Start external Dolt server (separate process, keep running)
dolt sql-server --port 3307

# Re-init beads in server mode (one-time migration)
bd init --server --server-port=3307
```
All other `bd` commands are identical between embedded and server mode.

---

## 4. Granularity Guidance

### The BOUNDARIES.md two-part test

Create a bead when **both** of the following are true:

1. **Multi-session relevance**: Will a future EM session (after compaction) need to know this task happened, what it found, or that it's complete?
2. **Dependency value**: Does this task's completion gate another task you're tracking?

If **either** condition applies, create a bead. If **neither** applies, skip it.

For the EM specifically, there is a simplified version of question 1: *"Would I lose something important if the context window compacted right now, before this delegation returns?"*

### Concrete decisions table

| Scenario | Create bead? | Type |
|----------|-------------|------|
| Multi-step workstream (implement → QA → docs) | ✅ Yes | 1 epic + 3 tasks |
| "Check if module X has tests" (research, one-shot) | ❌ No | — |
| Architecture decision (ADR) | ✅ Yes | task (or epic if multi-delegation) |
| Quick config change, single delegation | ❌ No | — |
| 5-sprint roadmap | ✅ Yes | 1 epic per sprint, tasks per delegation |
| Auto-scaled parallel tasks (e.g. 8× typescript-engineer processing files) | One task per delegation, or one representative if they're truly homogeneous | task |
| "Take a quick look at X and let me know" | ❌ No | — |
| A delegation that produces a persistent artefact (PR, ADR, spec) | ✅ Yes | task |

### The 2-week test (from BOUNDARIES.md)

> "Could I resume this work after 2 weeks away, with only the bead to go on?"
> - If yes → the bead is worth creating.
> - If the bead would add nothing — you'd just re-read the conversation — skip it.

### Epic vs task granularity

- **Epic** = one workstream = one `[label]` in EM delegation notes. Created once before the first delegation.
- **Task** = one discrete delegation. One per `delegate` call (or per step in a `chain`). Not for sub-steps within a subagent's own work.
- Do not nest epics under epics. Do not create tasks for internal subagent steps.

### When beads adds no value (from BOUNDARIES.md's "Use TodoWrite for" list)

- Work that completes in a single session and has no follow-on
- Linear, predetermined steps with no discovery or branching
- Informational queries to a member where the answer is used immediately

---

## 5. Gotchas for the EM Use Case

The following are errors or surprises that are expensive to discover by trial and error. Flags for Alex's spec where the current draft has an issue are marked **⚠️ SPEC BUG**.

---

### 5.1 ⚠️ SPEC BUG — `bd dep add` argument order is reversed in spec §3.6 Tool 4

**The spec's `bd_dep_add` implementation has the blocker and blocked IDs in the wrong order.**

The current spec code:
```typescript
// §3.6 Tool 4 — WRONG
await runBd(ctx.cwd, ["dep", "add", params.blocker_id, params.blocked_id, "--type=blocks"]);
```

The correct order (`bd dep add` positional args: `<blocked-id> <blocker-id>`):
```typescript
// CORRECT
await runBd(ctx.cwd, ["dep", "add", params.blocked_id, params.blocker_id, "--type=blocks"]);
```

**Verified against live `bd`:** `bd dep add B A` means "B depends on A" (A blocks B). Running it in the wrong order silently creates an inverted dependency — `bd ready` will show the wrong tasks as ready, and the EM will delegate steps out of sequence.

Alternatively, use the named flag which makes intent unambiguous and doesn't require remembering the positional order:
```typescript
await runBd(ctx.cwd, [
  "dep", "add", params.blocked_id,
  `--depends-on=${params.blocker_id}`,
  "--type=blocks"
]);
```

**Verification command after adding a dep:**
```bash
bd blocked --json  # Should show blocked_id, not blocker_id
```

---

### 5.2 ⚠️ SPEC BUG — `"done"` is not a valid status value

**The `bd_task_update` tool schema in §3.6 Tool 3 includes `Type.Literal("done")`**, but beads has no `done` status.

**Valid statuses (verified against `bd statuses`):** `open`, `in_progress`, `blocked`, `deferred`, `closed`, `pinned`, `hooked`.

Passing `--status=done` to `bd update` will return an error. The EM should use `bd close <id> --reason="..."` instead of setting `status=closed` via `bd update`. See §5.5.

Fix the enum in the tool schema:
```typescript
// Remove Type.Literal("done"), replace with:
Type.Literal("closed"),
```

---

### 5.3 ⚠️ SPEC BUG — `bd update` and `bd show` return arrays, not single objects

**The parse code in §3.6 Tools 3 and 6 treats the JSON as a single object**, but both commands return an array:

```typescript
// §3.6 Tool 3 — WRONG
const result = JSON.parse(stdout) as { id: string; status: string; ... };

// CORRECT
const result = (JSON.parse(stdout) as Array<{ id: string; status: string; }>)[0];
```

**Verified against live `bd`:**
- `bd update <id> --json` → `[{id, title, status, ...}]`
- `bd show <id> --json` → `[{id, title, design, notes, dependencies, ...}]`
- `bd close <id> --json` → `[{id, status: "closed", close_reason, closed_at, ...}]`
- `bd create <title> --json` → `{id, title, ...}` ← single object (correct as-is in the spec)
- `bd dep add --json` → `{issue_id, depends_on_id, type, status: "added"}` ← single object (no parse needed)
- `bd list --json` → `[{...}, {...}]` ← array (correct as-is)
- `bd ready --json` → `[{...}, {...}]` ← array (correct as-is)

Add a defensive check after parsing `bd create` output (given the spec flags this as a risk in §9.3):
```typescript
const result = JSON.parse(stdout);
if (!result?.id) throw new Error(`bd create returned unexpected shape: ${stdout}`);
```

---

### 5.4 `--status` multi-value syntax is comma-separated, not flag-repeated

`bd list --status open,in_progress --json` ✅ works  
`bd list --status open --status in_progress --json` ❌ returns empty array

Always use the comma-separated form.

---

### 5.5 Use `bd close` to mark work done, not `bd update --status=closed`

`bd close <id> --reason="summary"` is the canonical completion command. It:
- Sets `closed_at` timestamp (not set by `bd update`)
- Stores the reason in `close_reason` field (accessible in `bd show`)
- Allows multiple IDs: `bd close id1 id2 id3`

`bd update --status=closed` works as a status change but misses the timestamp and does not accept `--reason`.

**For the `bd_task_update` tool**: the tool currently uses `bd update`. Consider splitting the "done" case to call `bd close --reason=<notes>` instead, which gives a cleaner history. If the tool keeps `bd update`, pass the notes text via `--notes`, not `--reason` (which is a `bd close`-only flag).

---

### 5.6 `bd ready` includes epics, not just tasks

`bd ready --json` returns all open issues with no blocking deps — including epics. An epic with no deps on it will appear as "ready to work." The EM should filter:

```bash
bd ready --type=task --json          # tasks only
bd ready --parent=<epic-id> --json   # tasks under a specific epic
```

---

### 5.7 `beads.role` warning on every command — suppress it

`bd` emits a warning to stderr if `beads.role` is not set in git config:
```
warning: beads.role not configured (GH#2950).
  Fix: git config beads.role maintainer
```

This warning goes to **stderr**, so it does not corrupt the JSON on stdout — the `execFile` implementation is safe. But it will appear in logs on every `bd` call, which is noisy.

**Fix**: after `bd init --stealth`, run one additional command:
```bash
BEADS_DIR=<cwd>/.beads git -C <cwd> config beads.role maintainer
```
Or, in `ensureBeadsInit`, add a second `runBd` call:
```typescript
await runBd(cwd, ["config", "set", "role", "maintainer"]);
```
Check whether `bd config set role maintainer` is the correct form (verify with `bd config --help`). Alternatively, if the stealth init supports a `--role` flag, use that: `bd init --stealth --role=maintainer --non-interactive`.

---

### 5.8 `--non-interactive` is required for `bd init` in `execFile`

Without a TTY, `bd init` may block waiting for interactive prompts (role selection, remote setup). Always include `--non-interactive` (or set `BD_NON_INTERACTIVE=1` in the env). The spec's §2.2 code example omits this flag — it should be:

```bash
bd init --stealth --non-interactive
```

---

### 5.9 `--append-notes` is the right default for `bd_task_update`

`bd update --notes="text"` **replaces** the notes field entirely.  
`bd update --append-notes="text"` **appends** with a newline separator.

For the `bd_task_update` tool, the safer default is `--append-notes`, especially when updating a task multiple times (e.g., once mid-chain, once at completion). The spec's §9.6 flags this as a question — the answer is: **`--append-notes` exists and should be used**.

Suggested tool implementation:
```typescript
if (params.notes) args.push(`--append-notes=${params.notes}`);
```

If the EM ever needs to overwrite the notes entirely (session handoff), it can call `bd update <id> --notes="clean handoff text"` directly via the shell rather than through the tool.

---

### 5.10 `bd list` default limit is 50

`bd list --json` returns at most 50 issues by default. For an EM tracking a large project across many sessions, this could silently truncate results during state reconstruction.

Add `--limit=0` to the `bd_list` tool to return all matching issues:
```typescript
const args = ["list", "--limit=0", "--json"];
```
Or pass through a `limit` parameter if the EM wants pagination control.

---

### 5.11 `bd dep add` has no `--json` return useful data — omit or ignore

`bd dep add --json` returns `{issue_id, depends_on_id, type, status: "added"}`. The `bd_dep_add` tool can safely ignore this and just check for a non-zero exit code. The tool's current spec is fine.

If the dep add fails (e.g., nonexistent ID), `bd` exits non-zero and writes an error JSON to stdout: `{"error": "...", "schema_version": 1}`. The `try/catch` in `runBd` will catch this via the thrown error, which carries `.stderr`. Check `err.stderr ?? err.stdout` for the message.

---

### 5.12 `bd init --stealth` in a directory without git — safe

`--stealth` disables all git operations, so `bd init --stealth` works even if `<cwd>` is not a git repository. The `BEADS_DIR=<cwd>/.beads` env override bypasses git repo discovery entirely. The pit2 use case (`.beads/` alongside `.pi/`) is the supported stealth pattern.

---

## Appendix: Decision Point Resolutions for spec-beads-integration-a.md

Answers to the open items in spec §9:

| § | Question | Answer |
|---|----------|--------|
| 9.2 | Flag syntax — verify before implementing | **Verified.** `--type`, `--parent`, `--design`, `--notes` are all valid `bd create` flags. `--design` and `--notes` are valid `bd update` flags. See §1 of this document for full flag tables. |
| 9.3 | `bd create --json` response shape | **Single object** with `id` at top level. Parse as `JSON.parse(stdout).id`. Add defensive check `if (!result?.id) throw`. |
| 9.4 | `bd` binary unavailability | **Recommendation stands**: always register with guard. The guard error is informative. No change needed. |
| 9.5 | `bd list --status` default | **Change default to `open,in_progress`** (comma-separated). Verified that this syntax works. `--status open --status in_progress` (repeated flag) returns empty — do not use. |
| 9.6 | `--append-notes` flag | **`--append-notes` exists**. Use it as the default in `bd_task_update` to avoid clobbering earlier findings. |
