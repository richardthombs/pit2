# Beads Capabilities & pit2 Integration Analysis

**Document type:** Architectural reference  
**Author:** Mercer Lin  
**Date:** 2026-05-01  
**Source:** `gastownhall/beads` @ `8694c53`, v0.60.0; `bd` CLI v1.0.3 verified against live binary  
**Related:** [`beads-em-reference.md`](./beads-em-reference.md) — implementation-level command reference

---

## Contents

1. [What Beads Is](#1-what-beads-is)
2. [Core Capabilities](#2-core-capabilities)
3. [Mapping to pit2's Coordination Problems](#3-mapping-to-pit2s-coordination-problems)
4. [Limitations Relevant to pit2](#4-limitations-relevant-to-pit2)
5. [Integration Options A–D](#5-integration-options-ad)

---

## 1. What Beads Is

Beads is a **dependency-aware task graph with persistent, queryable storage**. It is built on [Dolt](https://github.com/dolthub/dolt) — a version-controlled, MySQL-compatible relational database — which means every write is a commit, the full history is retained, and the store survives process restarts.

The core abstraction is the **issue** (also called a bead): a typed, stateful work item with fields for description, design rationale, execution notes, status, priority, assignee, dependencies, and more. Issues form a directed graph — dependencies are first-class, not annotations — and the graph drives a computed "ready front" of unblocked work.

The `bd` CLI is the primary interface. Every command supports `--json` for structured programmatic output. The store can run in **embedded mode** (in-process, file-locked) or **server mode** (external `dolt sql-server`, concurrent connections).

Beads is not a project management SaaS. It is a local, code-adjacent, machine-readable coordination substrate. This is what makes it interesting for an AI orchestration system.

---

## 2. Core Capabilities

### 2.1 Task Tracking

Issues have a rich type system: `epic`, `task`, `feature`, `bug`, `chore`, `decision`. Epics can contain tasks (via `--parent`), giving a two-level hierarchy. Each issue carries:

- **`design`** — rationale captured at creation time ("why we're doing this")
- **`notes`** — execution findings accumulated during work (supports append)
- **`close_reason`** — summary written at completion via `bd close --reason`
- **`status`** — `open | in_progress | blocked | deferred | closed | pinned | hooked`
- **`priority`** — 0 (critical) to 4 (low); default 2

The Dolt backing store means this is a durable record: it persists across process restarts, context windows, and session boundaries. The full history is inspectable.

### 2.2 Dependency Management and `bd ready`

Dependencies between issues are first-class objects, not tags. The primary dependency type is `blocks`: "issue A must complete before issue B can start."

```
bd dep add <blocked-id> <blocker-id> --type=blocks
```

Only `blocks` dependencies affect scheduling. Other types (`related`, `tracks`, `parent-child`, `discovered-from`, `validates`, `supersedes`) are informational and do not influence the ready front.

**`bd ready`** computes the current unblocked work front automatically: all open issues with no unresolved blocking predecessors. This is not a filter on status — it is a graph traversal. It updates dynamically as issues are closed.

```
bd ready --type=task --json          # unblocked tasks
bd ready --parent=<epic-id> --json   # unblocked tasks under a specific epic
```

This is the capability that separates beads from a flat todo list. The EM does not need to manually track which step comes next; the dependency graph encodes it and `bd ready` reads it out.

### 2.3 Atomic Claim Queue

In multi-agent scenarios, `bd update <id> --claim` atomically sets assignee and status to `in_progress` in a single write. This prevents two agents from claiming the same task simultaneously.

```
bd update <id> --claim --json
```

In single-EM operation this is unnecessary; in a work-queue pattern where multiple subagents poll for tasks, it is the correct synchronisation primitive.

### 2.4 State Persistence: Embedded vs Server Mode

**Embedded mode** (default): Dolt runs in-process. A file lock on `.beads/` enforces single-writer access. One process writes at a time; concurrent writes queue and can timeout. This is the right mode for a single EM.

**Server mode**: An external `dolt sql-server` process accepts multiple concurrent connections. Enabled with `bd init --server --server-port=3307`. Required for concurrent multi-agent writes. All `bd` commands are identical between modes — the flag changes init, not command syntax.

**Stealth mode** (`bd init --stealth`): Disables all git operations (no hooks, no commits to the host repo). The `.beads/` directory can sit alongside `.pi/` in a project root without touching the project's git history. Works without git entirely when combined with `BEADS_DIR=/path/.beads`.

### 2.5 Querying and Reporting

```
bd list --status=open,in_progress --json      # all active work
bd list --type=task --parent=<id> --json      # tasks under an epic
bd show <id> --json                           # full detail on one issue
bd ready --type=task --json                   # unblocked tasks
bd prime                                      # natural-language context summary (ADR-0001)
```

`bd prime` is notable: it auto-generates a live summary of the current project state, designed to be injected into an agent's context at session start. It is the canonical "state reconstruction" entry point per ADR-0001.

`bd list` has a default limit of 50. Use `--limit=0` for unbounded results.

### 2.6 Molecules and Wisps

**Molecules** are composite issue patterns — reusable multi-step templates. `bd mol wisp` is the relevant case: **wisps** are ephemeral issues stored in `.beads-wisp/` rather than the main store. They are not committed to Dolt and not synced to git. They are designed for transient orchestration state that should not pollute the audit trail.

Use wisps for ephemeral per-workstream scratch state. Use regular beads for anything that needs to survive session compaction.

### 2.7 Async Gates

`bd gate` blocks a workflow step on an external condition: human approval, CI run completion, PR merge, timer expiry, or incoming mail. Gates are first-class issues with their own status transitions.

```
bd gate create "Wait for CI on PR #42" --condition=ci --ref=pr/42
bd gate eval <gate-id>     # auto-evaluate and close if condition met
```

A gate in `blocked` status appears in `bd ready` as not ready. Once the external condition is satisfied and the gate closes, downstream issues become ready automatically.

This maps cleanly to pit2's async delegation pattern: a gate can encode "do not dispatch task B until the CI triggered by task A passes" outside the EM's context window.

### 2.8 Agent Beads

Beads has first-class support for tracking agents themselves as issues (`--type=agent`). Agent beads have a dedicated state machine:

```
idle → spawning → running → working → stuck → done | dead
```

Fields: `hook` (current work item), `role` (role definition bead). A **witness system** monitors heartbeats — if an agent bead goes stale without a heartbeat update, the witness can mark it `stuck` or `dead`.

This is designed for long-lived, persistent agent processes that can maintain a heartbeat loop. The feature is architecturally coherent but has limited fit with pit2's current subagent model (see §4.1).

---

## 3. Mapping to pit2's Coordination Problems

pit2's EM faces five structural coordination problems. Here is how beads addresses each.

### Problem 1: Context Compaction Destroys Workstream State

**The problem:** The EM's conversation context is the only place workstream state lives. When context compacts, in-flight delegations, decisions made, and partial results are lost. The EM restarts blind.

**Beads solution:** The EM writes workstream state to beads at each transition — create a bead when a workstream starts, update notes when a delegation returns, close with `--reason` when complete. On restart, `bd prime` or `bd list --status=open,in_progress` reconstructs current state in seconds.

The key field is `design` (written at creation, captures why) plus `notes` (written during execution, captures what was found). Together they give a future EM session enough context to resume without re-reading conversation history.

**Fit:** Excellent. This is the highest-value, lowest-friction use of beads for pit2.

---

### Problem 2: No Dependency Graph

**The problem:** The EM currently manages sequencing in its head (or in conversation prose). There is no machine-readable record of "task B cannot start until task A completes." Dependencies are implicit, fragile, and lost on compaction.

**Beads solution:** `bd dep add` makes dependencies explicit. `bd ready` reads them out automatically. The EM creates tasks with `--type=blocks` dependencies at workstream-design time, then queries `bd ready --type=task` at dispatch time to know what is actually dispatchable.

This shifts sequencing logic from the EM's reasoning to the graph. The EM still designs the dependency structure, but it does not have to maintain it mentally — the graph does.

**Fit:** Strong. The `bd ready` query is exactly the EM's question: "what can I dispatch right now?"

---

### Problem 3: No Horizontal Scaling Primitive

**The problem:** When multiple subagents should work in parallel on a pool of similar tasks, the EM currently fans out manually — it holds all task assignments in context, tracks which are in-flight, and handles completions. This does not scale and breaks on compaction.

**Beads solution:** The EM populates a pool of tasks in beads and subagents claim work with `bd update --claim`. The claim is atomic — no double-assignment. Completed tasks are closed with findings in `--reason`. The EM's role reduces to: seed the pool, monitor `bd list --status=open,in_progress`, act on `bd ready` as tasks complete.

**Constraint:** This pattern requires **Server mode** to avoid write contention. Concurrent agents writing to an embedded store will deadlock. The embedded → server migration is a one-time `bd init --server` operation; command syntax is unchanged.

**Fit:** Strong design fit; requires Server mode and a deliberate architecture shift. Not the right starting point.

---

### Problem 4: No Persistent Cross-Session Agent State

**The problem:** The EM delegates the same "role" across sessions (software-architect, typescript-engineer, etc.), but there is no persistent record of what a given role's current assignment is, what it found, or whether it is stuck. Each session starts with no knowledge of prior delegations.

**Beads solution:** `type=agent` beads model an agent's assignment and state across sessions. The EM creates an agent bead, assigns a task via the `hook` field, and updates the bead's status. Combined with the task's `notes` field, this gives a future session a rehydratable snapshot of "who was doing what."

`bd prime` surfaces agent states alongside task states in its summary, so the EM can see at a glance which roles have active assignments.

**Constraint:** Agent beads with heartbeats assume a persistent process. pit2 subagents are stateless — they cannot maintain a heartbeat loop across the span of a `delegate` call. The state machine is useful for cross-session role tracking; the heartbeat/witness system is not applicable.

**Fit:** Partial. Agent beads as role-assignment records: good. Heartbeat-based liveness monitoring: not applicable to pit2's model.

---

### Problem 5: No Decision Audit Trail

**The problem:** Architecture decisions, trade-off choices, and constraint rationale made by the EM or its subagents exist only in conversation output. They are not queryable, not persistent across sessions, and not discoverable by future agents without conversation replay.

**Beads solution:** `--type=decision` issues are first-class. The `design` field captures rationale and constraints; `notes` captures outcomes and reversals. A `decision` bead can be linked to the tasks it governs via `validates` or `related` dependency types (informational, no scheduling effect).

`bd list --type=decision --json` returns the full decision log at any time.

**Fit:** Excellent. Low-cost, high-value. A decision bead is one `bd create` call and survives indefinitely.

---

## 4. Limitations Relevant to pit2

### 4.1 Stateless Subagents vs Heartbeat Model

Beads' `type=agent` state machine assumes agents can update their own heartbeat periodically — i.e., they are long-running processes. pit2 subagents are spawned per-delegation and exit when done. They cannot loop on a heartbeat.

**Implication:** The witness system (automatic `stuck`/`dead` detection) does not work for pit2 subagents. The EM can still use agent beads as role-assignment records and update them manually at delegation boundaries, but automatic liveness detection requires a different model (e.g., timeout-based dead-reckoning in the EM).

This is a design mismatch, not a blocker. The useful parts of agent beads (assignment tracking, state snapshots) work fine without heartbeats.

### 4.2 Single-Writer Constraint in Embedded Mode

Embedded mode enforces a file lock: one writer at a time. Concurrent writes hang then fail. This is not a problem for a single EM, but it is a hard constraint for the multi-agent work-queue pattern (Integration B). The upgrade to Server mode requires a persistently running `dolt sql-server` process, which adds infrastructure overhead.

The constraint also means the EM must never issue concurrent `bd` calls. All writes must be sequentialised. In pit2's current architecture (EM as sole coordinator) this is natural, but it is worth noting explicitly for any future parallelisation of EM tool calls.

### 4.3 Granularity Discipline

Beads adds overhead: every tracked item requires a `bd create`, at least one `bd update`, and a `bd close`. For short one-shot tasks (research queries, config lookups, single-delegation investigations), this overhead costs more than it returns.

BOUNDARIES.md provides a two-part test: create a bead only if (1) a future session would need to know this happened, and (2) the task's completion gates other tracked work. If neither is true, skip it.

The risk is over-tracking — creating a bead for everything because it feels thorough. A cluttered bead store is harder to query and harder to interpret via `bd prime` than a disciplined one. The EM should establish a workstream-level (epic) norm and be selective about task-level beads.

### 4.4 Installation Dependency

`bd` must be present on the host system. There is no bundled or embeddable version. In pit2, this means the EM's beads integration must guard against the absence of `bd` and fail gracefully rather than error mid-session.

The guard pattern: attempt `bd --version` at session start; if it fails, log a warning and proceed without beads. Beads should enhance the EM's coordination, not be a hard dependency that breaks sessions on machines without it.

---

## 5. Integration Options A–D

Four integration options exist, ordered by complexity and scope.

### Option A — EM-Only State Persistence (Recommended Starting Point)

**What it is:** The EM uses beads to persist workstream state. Subagents have no `bd` access. The EM creates beads for epics and tasks, writes design rationale at creation, appends notes as delegations return, and closes with `bd close --reason` on completion. On session restart, `bd prime` reconstructs current state.

**What it solves:** Compaction survival (Problem 1), dependency graph (Problem 2), decision audit trail (Problem 5).

**What it does not solve:** Horizontal scaling, cross-session agent state beyond what the EM manually records.

**Tradeoffs:**
- Lowest implementation friction — one writer, embedded mode, no infrastructure
- Does not require any changes to subagent behaviour
- The beads store is the EM's private notebook; subagents are unaware of it
- No concurrent write risk — EM serialises all `bd` calls naturally

**Recommended entry point.** Delivers the highest-value capabilities (compaction survival, dependency graph, decision trail) with minimal complexity.

---

### Option B — Shared Work Queue (Multi-Agent Horizontal Scaling)

**What it is:** The EM seeds a pool of task beads. Subagents are given `bd` access and claim work with `bd update --claim`. The EM monitors the pool via `bd list` and `bd ready`; subagents close their tasks with findings when done.

**What it solves:** Horizontal scaling (Problem 3). Also inherits Option A's benefits.

**What it requires:**
- Server mode (`dolt sql-server` running persistently)
- Subagents need `bd` installed and `BEADS_DIR` in their environment
- EM-to-subagent handoff protocol: subagents must know how to claim, work, and close a bead
- Error handling for lock timeouts and stale claims

**Tradeoffs:**
- Significant infrastructure change — external Dolt server, new subagent conventions
- Enables true work-queue parallelism without manual fan-out in the EM
- Not appropriate until Option A is stable and the EM's bead discipline is established

**Recommended for phase 2**, only after Option A is proven in production.

---

### Option C — Agent Bead Tracking (Cross-Session Role State)

**What it is:** The EM creates `type=agent` beads for active roles (software-architect, typescript-engineer, etc.). When delegating, the EM updates the agent bead's `hook` to the current task ID and sets status to `working`. On return, it updates `hook` to null and status to `idle`. `bd prime` surfaces agent assignments alongside task state.

**What it solves:** Cross-session agent state visibility (Problem 4). Also inherits Option A's benefits.

**What it requires:**
- Agent bead creation and lifecycle management in the EM
- Convention for `hook` → task linkage
- Manual heartbeat discipline (EM updates agent bead status at delegation boundaries; no automatic liveness detection)

**Tradeoffs:**
- Adds EM overhead per delegation (agent bead updates in addition to task bead updates)
- Heartbeat/witness system does not apply to stateless subagents — liveness is EM-inferred, not automatic
- Value is higher in long multi-session projects where role assignment drift is a real problem

**Recommended as an add-on to Option A** in projects with many concurrent role assignments spanning multiple sessions.

---

### Option D — Async Gate Coordination

**What it is:** The EM creates `bd gate` issues to encode cross-session blocking conditions: human approval checkpoints, CI completion, PR merges. Gates appear in the dependency graph and block downstream tasks in `bd ready` until the external condition resolves. Gates can be auto-evaluated with `bd gate eval`.

**What it solves:** Structured async blocking outside the EM's context window. The EM does not need to remember "I'm waiting for CI on PR #42 before dispatching task B" — the gate encodes it.

**What it requires:**
- Identifying which of pit2's coordination points map to gate conditions
- Either manual gate evaluation (EM polls and calls `bd gate eval`) or an external trigger mechanism
- Some integrations (CI status, PR merge) require beads webhook/event support — verify against current beads docs before implementing

**Tradeoffs:**
- High value for long-running workflows with external dependencies
- Low value for pure code-generation workstreams with no external blocking conditions
- Can be introduced selectively on a per-workstream basis without changing the base integration

**Recommended as an add-on** when specific workstreams have well-defined external blocking conditions.

---

## Recommended Sequence

```
Option A  →  Option C (if multi-session role tracking needed)
          →  Option D (if external async blocking needed)
          →  Option B (if horizontal agent scaling needed)
```

Options C and D can be added atop A independently in either order. Option B is architecturally distinct (requires Server mode) and should only be attempted once the EM's beads discipline is mature and the scaling need is validated.

**Do not adopt all four options simultaneously.** Each adds observable overhead. The value of beads comes from disciplined, consistent use — a half-maintained bead store is worse than no bead store.

---

## Quick Reference: Capability-to-Problem Matrix

| Capability | Compaction Survival | Dep Graph | Horiz. Scaling | Agent State | Decision Trail |
|---|:---:|:---:|:---:|:---:|:---:|
| Task tracking + `design`/`notes` | ✅ | — | — | — | ✅ |
| `bd dep add` + `bd ready` | ✅ | ✅ | — | — | — |
| `bd update --claim` (Server mode) | — | — | ✅ | — | — |
| `bd prime` state reconstruction | ✅ | ✅ | ✅ | ✅ | ✅ |
| `type=agent` beads | — | — | — | ✅ | — |
| `bd gate` async gates | ✅ | ✅ | — | — | — |
| `type=decision` beads | — | — | — | — | ✅ |
| Wisps (ephemeral) | — | — | ✅ | — | — |

---

*Implementation-level command syntax, JSON shapes, flag names, and known gotchas are documented separately in [`beads-em-reference.md`](./beads-em-reference.md).*
