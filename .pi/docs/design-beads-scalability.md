# Design: Beads Scalability Analysis for pit2

**Status:** Active  
**Author:** Alex Rivera  
**Date:** 2026-05-01  
**Beads version referenced:** bd v1.0.3 / docs v0.60.0 (`gastownhall/beads` commit `8694c53589f1`)  
**Related docs:**
- `.pi/docs/spec-beads-integration-a.md` — Integration A implementation spec (done)
- `.pi/docs/beads-em-reference.md` — verified bd CLI reference (Mercer Lin)
- `.pi/docs/design-member-persistence.md` — ADR-004 (member persistence)

---

## Purpose

This document captures the full scalability analysis for pit2's use of beads, including the seven identified coordination bottlenecks, the four integration tiers (A through D), the recommended adoption sequence, and the known limitations and mismatches. Integration A is already implemented. This document exists so that a future session can pick up Integration B or beyond without reconstructing this analysis from scratch.

---

## 1. Current Scalability Bottlenecks in pit2

The following seven bottlenecks are structural properties of pit2's current coordination model. They are independent of beads — they exist today regardless of whether beads is in use.

### B1 — EM context as coordination bus

All coordination state lives in the Engineering Manager's conversation context: what work is in flight, what has been completed, what was decided, what each member found. When the context window compacts, this history is lost. The EM must reconstruct state from member memory files and its own fading context. Multi-session workstreams are fragile by design.

**Consequence:** The EM cannot reliably resume a complex workstream after compaction without external state storage.

### B2 — 8-task hard cap on parallelism

The `delegate` tool's parallel mode enforces a maximum of 8 concurrent tasks. This is a hard limit in the implementation, not a soft guideline. For workstreams that naturally decompose into more than 8 independent units (e.g., file-by-file migration, per-module test runs, large parallel research tasks), the EM must manually batch and sequence — adding overhead and re-introducing serialisation that could otherwise be avoided.

**Consequence:** True fan-out beyond 8 requires EM-side batching logic, which consumes context and re-serialises work.

### B3 — Linear chains only

The `chain` mode in `delegate` is strictly sequential: step N+1 receives step N's output via `{previous}`. There is no way to express a DAG of dependencies (step C depends on steps A and B both completing, but A and B can run in parallel). Complex dependency structures must be hand-coded as multiple `delegate` calls with the EM serving as the synchronisation point.

**Consequence:** Any non-linear dependency graph requires the EM to act as an explicit scheduler, consuming context and adding round-trips.

### B4 — Ephemeral coordination state

Related to B1, but distinct: there is no durable task store. The EM has no external record of what tasks exist, which are in flight, which are blocked, or which are complete. `delegate` calls are fire-and-forget from a persistence standpoint. If the session dies mid-task, in-flight work is unrecoverable — there is nothing to resume from.

**Consequence:** Long-running workstreams have no checkpoint. Recovery requires starting over or reconstructing state manually from conversation history and member memory files.

### B5 — Reactive `resolveOrScale`

The `resolveOrScale` function determines which member to delegate to. Its current behaviour is: find an idle member with the right role; if none is idle, clone a new one. This is purely reactive — the EM cannot express priority, affinity, or work-queue semantics. There is no concept of "this task should only go to a member who has already loaded context X" or "delay this task until a currently-busy member is free."

**Consequence:** As the team grows, scheduling becomes ad-hoc. The EM cannot make informed dispatch decisions without querying member state manually.

### B6 — Name pool ceiling

The name pool contains 30 names. Names are retired permanently on use. Firing a member does not return their name. The hard ceiling is 30 hires over the project lifetime. For projects that scale to large teams or hire-fire-rehire frequently, this becomes a constraint.

**Consequence:** Projects with high member churn or large teams will hit the name pool ceiling within a single project lifetime.

### B7 — Result synthesis always EM's job

Every `delegate` call (single, parallel, or chain) returns its output to the EM's context. The EM is always responsible for reading results, synthesising findings, deciding what to do next, and dispatching follow-on tasks. There is no mechanism for a subagent to trigger further work autonomously, or for one subagent's output to feed directly into another without passing through the EM.

**Consequence:** The EM is a mandatory bottleneck for all inter-agent coordination. As the number of in-flight tasks grows, so does the EM's context load. There is no delegation-of-delegation.

---

## 2. Integration A — EM-Only Workstream Persistence (Implemented)

**Status:** Implemented. See `spec-beads-integration-a.md` for full detail.

### What it does

The EM uses the `bd` CLI to maintain a durable coordination log in `.beads/` at the project root. Beads stores epics (workstreams), tasks (individual delegations), dependencies between tasks, and post-execution findings. This state survives context compaction and session restarts.

### Tools registered

Seven tools are registered on the `pi` object in `index.ts`, all calling a `runBd` helper via `execFile`:

| Tool | Maps to |
|---|---|
| `bd_workstream_start` | `bd create --type=epic` |
| `bd_task_create` | `bd create --type=task --parent=<epic_id>` |
| `bd_task_update` | `bd update <id>` (status, notes, design) |
| `bd_dep_add` | `bd dep add <blocked_id> <blocker_id>` |
| `bd_list` | `bd list --status=open,in_progress` |
| `bd_show` | `bd show <id>` |
| `bd_ready` | `bd ready --type=task` |

### Bottlenecks addressed

- **B1 (context as coordination bus):** Coordination state is now externalised. The EM can reconstruct workstream state after compaction via `bd_list` and `bd_show`.
- **B4 (ephemeral state):** Tasks are persisted to disk. Session recovery is possible by reading the beads store.

### Bottlenecks not addressed

B2 (parallelism cap), B3 (linear chains), B5 (reactive scheduling), B6 (name pool), and B7 (EM synthesis bottleneck) are all out of scope for Integration A and remain as-is.

### Constraints

- **Embedded mode only:** `.beads/` uses a file-locked Dolt DB. Only one process writes at a time. The EM is the sole writer. Subagents do not have `bd` access.
- **EM initiative only:** The EM decides when to create beads and when to update them. There is no automatic bead creation on `delegate` calls.
- **Granularity discipline required:** Not every delegation warrants a bead. The BOUNDARIES.md two-part test applies: create a bead when (a) a future session will need to know this happened, or (b) the task's completion gates another tracked task. Over-beading adds noise without value.

---

## 3. Integration B — Shared Work Queue with Server Mode

**Status:** Not implemented. Design proposed here.

### What it does

Integration B upgrades beads from a single-writer EM log to a **shared work queue** that multiple agents can read from and claim tasks off. The EM populates the queue; agents poll for available work via `bd ready`, claim a task atomically via `bd update --claim`, execute it, and close it. The EM monitors progress but is no longer the mandatory scheduling bottleneck.

### Prerequisites

- `dolt sql-server` running as an external process (not embedded in the EM subprocess)
- Beads re-initialised in server mode: `bd init --server --server-port=3307`
- All `bd` commands in `runBd` then use server mode automatically (no flag changes needed)
- Subagents must have `bd` CLI available in their environment

### How it works

**EM side:**
1. EM creates an epic for the workstream.
2. EM creates all task beads upfront (or as they become known), with `bd dep add` encoding dependencies.
3. EM dispatches a pool of worker agents (e.g., 4× typescript-engineer) with a standing instruction: "poll `bd ready --type=task`, claim a task, execute it, close it, repeat."
4. EM monitors via `bd_list` and `bd_show` without needing to be in the critical path of each task.

**Agent side (new capability):**
```
1. Call bd ready --type=task --json  → get list of unblocked tasks
2. Pick one; call bd update <id> --claim --json  → atomic claim (sets assignee + in_progress)
3. Read task detail: bd show <id> --json  → get design field for context
4. Execute the task
5. Call bd close <id> --reason="<findings>" --json  → close with findings
6. Repeat from step 1 (or exit if queue is empty)
```

The `--claim` flag is atomic: it sets `status=in_progress` and `assignee=<agent>` in a single write. Two agents racing to claim the same task will result in one getting a successful claim and the other receiving an error (task already claimed). The losing agent retries `bd ready` to get a different task.

### Bottlenecks addressed

- **B2 (8-task cap):** With a shared work queue, the EM can pre-populate 50 tasks and dispatch a pool of agents. Workers drain the queue independently. The 8-task parallelism cap still applies to a single `delegate` call, but can be worked around by dispatching long-running polling agents rather than individual task agents.
- **B5 (reactive scheduling):** The EM becomes a queue populator rather than a per-task dispatcher. `resolveOrScale` still handles member assignment, but the EM's decision burden per task is eliminated once the queue is set up.
- **B7 (EM synthesis bottleneck):** Workers write their findings directly to the task's `notes` field via `bd close --reason`. The EM reads findings via `bd_show` on demand rather than being the recipient of every result.

### New tools required

Three additional tools beyond Integration A:

| Tool | Maps to | Description |
|---|---|---|
| `bd_task_claim` | `bd update <id> --claim` | Atomic claim for a subagent; only needed if subagents call this tool via the EM |
| `bd_ready_poll` | `bd ready --type=task --json` | Already covered by `bd_ready`; may need `--parent` filter |
| (optional) `bd_close` | `bd close <id> --reason="..."` | Currently `bd_task_update` handles status; a dedicated close tool with `--reason` is cleaner |

Alternatively, subagents could be given direct `bd` shell access rather than going through the EM's tool layer. This is a design choice — see Limitations §7.3.

### Infrastructure change

```bash
# Start dolt server (keep running across all sessions)
dolt sql-server --port 3307 --host 0.0.0.0

# Migrate existing embedded beads to server mode (one-time)
bd init --server --server-port=3307
```

The `--stealth` flag is compatible with server mode. All other `bd` commands are identical.

### Open questions

1. **Who manages the dolt server process?** It must be external to the EM. Options: a separate terminal, a system service (`launchd`/`systemd`), or a pi extension that spawns it on `session_start`.
2. **Agent authentication:** In the current design, all agents write to the same `.beads/` DB with no role-based access control. If the EM needs to prevent agents from modifying each other's tasks (e.g., an agent closing a task it didn't claim), `bd update <id>` already supports this via the claim state — only the claimer can close.
3. **Subagent delivery mechanism:** Do subagents get `bd` tools via the EM's tool layer (registered in `index.ts`), or do they call `bd` directly via their `bash` tool? Direct `bash` access is simpler but bypasses the `beadsGuard` check and the `BEADS_DIR` env setting. See §7.3.

---

## 4. Integration C — Async Gates for Delegation Coordination

**Status:** Not implemented. Design proposed here.

### What it does

Integration C uses beads' `bd gate` mechanism to encode **cross-session or cross-agent wait conditions** as first-class state. A gate blocks a downstream task until an external condition is satisfied — a subagent calling `bd gate eval`, a CI check passing, a human approving, or a timer firing. Gates let the EM express "don't start task B until task A is confirmed complete by an external process" without holding the EM context open.

### Beads gate mechanics

From Mercer Lin's research (ASYNC_GATES.md):
- `bd gate create <task-id> --condition=agent --json` — creates a gate blocking the task
- `bd gate eval <gate-id> --approve --json` — approves/closes the gate
- `bd gate eval <gate-id> --reject --reason="..." --json` — rejects; task moves to `blocked`
- `bd ready` respects gate state — a gated task does not appear as ready until its gate is approved

### Mapping to pit2's async delegation

The pit2 `async: true` delegation mode already supports fire-and-forget dispatch. Integration C would let the EM express the *dependency* that follows from async work without holding state in its context:

```
EM:   delegate async → agent A runs task X
      bd gate create task-Y --condition=agent  (task-Y blocked until agent A approves)
      ...context compacts, session restarts...
      
Agent A: (on completion) bd gate eval <gate-id> --approve
      
EM:   bd ready → now shows task-Y as ready
      delegate → agent B runs task-Y
```

The gate survives compaction. The EM does not need to remember "I was waiting for A to finish before starting B" — that relationship is encoded in the beads store.

### Bottlenecks addressed

- **B3 (linear chains only):** Gates encode arbitrary wait conditions between tasks. A task can be gated on multiple upstream conditions simultaneously. This is a DAG expressed as state, not code.
- **B4 (ephemeral state):** Gate state is durable. A session restart does not lose the knowledge that task-Y is waiting on gate-G.
- **B7 (EM synthesis bottleneck):** The EM does not need to be the synchronisation point. Agents can approve gates directly, allowing downstream work to become available in `bd ready` without EM involvement.

### New tools required

| Tool | Maps to | Description |
|---|---|---|
| `bd_gate_create` | `bd gate create <task-id> --condition=agent` | EM creates a gate on a task |
| `bd_gate_eval` | `bd gate eval <gate-id> --approve/--reject` | Subagent (or EM) evaluates a gate |
| `bd_gate_list` | `bd gate list --json` | EM inspects pending gates |

Subagents would need access to `bd_gate_eval` — either via the EM's tool layer or direct `bd` shell access.

### Dependency on Integration B

Integration C is maximally useful when combined with Integration B. In B, agents drain a shared work queue; in C, gates control when queue entries become available. Together they express arbitrary pipeline topologies. C can be adopted without B (the EM still does all dispatching), but the combination eliminates both the scheduling bottleneck and the synchronisation bottleneck simultaneously.

---

## 5. Integration D — Molecule Templates for Repeatable Workflows

**Status:** Not implemented. Design proposed here.

### What it does

Integration D uses beads' molecule system to encode **reusable workflow templates** — pre-defined patterns of tasks with pre-wired dependencies that the EM can instantiate for a new workstream with a single command. A "molecule" is a named template (stored in `.beads/`) that, when instantiated, creates a set of task beads with the correct dependency graph pre-built.

### Beads molecule mechanics

From Mercer Lin's research (MOLECULES.md):
- `bd mol define <name>` — define a molecule template
- `bd mol wisp <name>` — instantiate an ephemeral molecule (wisps, stored in `.beads-wisp/`, not in the main Dolt DB)
- Wisps are designed for ephemeral orchestration state that shouldn't pollute the audit trail — appropriate for per-invocation scaffolding

### pit2 use case: implement → QA → docs

A canonical pit2 workstream has a repeated structure:

```
[epic]
  ├── task: implement <feature>
  ├── task: QA <feature>   [blocked by: implement]
  └── task: document <feature>   [blocked by: QA]
```

Today, the EM creates these beads manually for every workstream. Integration D would define this as a molecule:

```bash
bd mol define pit2-feature-workflow \
  --steps="implement,qa,docs" \
  --deps="qa:implement,docs:qa"
```

Instantiation:
```bash
bd mol wisp pit2-feature-workflow --param title="auth-module" --json
# → creates 3 task beads with deps pre-wired, returns IDs
```

The EM then populates `design` fields and dispatches. The dependency graph is already correct.

### Bottlenecks addressed

- **B1 and B4 (context burden):** The EM does not need to manually construct multi-step dependency graphs; the template encodes the structure. Less EM context consumed per workstream setup.
- **Operational consistency:** All feature workstreams have the same bead structure. `bd_list` and `bd_ready` queries produce predictable results.

### Mapping to pit2 extension

A `bd_molecule_instantiate` tool could wrap `bd mol wisp`, returning task IDs pre-wired. The EM calls it at workstream start instead of three separate `bd_task_create` + two `bd_dep_add` calls.

### Dependency

Integration D is additive and can be adopted independently of B and C, though it is most powerful in combination: D creates the structure, B dispatches workers to drain it, C handles async gate conditions within it.

---

## 6. Recommended Adoption Sequence

```
A (done) → B → C/D
```

### A: Already complete

EM-only persistence. Zero subagent changes. Lowest risk, highest immediate value for context compaction resilience.

### B: Next priority

Integration B is the highest-value next step. It addresses the scheduling bottleneck (B5) and begins to relieve the EM synthesis bottleneck (B7) by letting agents write findings directly to beads. The infrastructure cost (running a dolt server) is real but one-time. The subagent behavioural change (poll → claim → execute → close) is well-defined.

**Recommended trigger:** When the team is regularly running 4+ parallel tasks per workstream, or when EM context overhead from synthesis is noticeable. Also warranted if any workstream requires more than 8 concurrent tasks.

### C and D: Parallel, opportunistic

Integrations C and D can be adopted independently of each other after B is in place. C (gates) is higher value if the team is doing complex async pipelines. D (molecules) is higher value if the team is doing many structurally similar workstreams.

**Do not skip B to implement C.** Gates require Server mode (concurrent writes) to be useful in a multi-agent context. Implementing C on top of embedded-mode A would give gates, but only in EM-only scenarios where the EM explicitly evaluates its own gates — limited value.

---

## 7. Limitations and Mismatches

### 7.1 Stateless subagents vs agent beads heartbeats

Beads has a first-class `--type=agent` issue type with a state machine (idle / spawning / running / working / stuck / done / dead) and a heartbeat witness system that detects stalled agents. This is designed for long-running, persistent agents that maintain their own process state.

pit2 subagents are the opposite: **stateless and ephemeral**. Each `delegate` call spawns a fresh subprocess with no prior context. The subprocess exits when the task completes. There is no persistent agent process to send heartbeats.

**Consequence:** The `type=agent` bead type is not applicable to pit2's current architecture. Do not use agent beads to represent pit2 members. Use `type=task` beads to represent delegations, not the agents performing them. If beads heartbeat monitoring is ever desired, it would require a structural change to how pi subagents are managed (persistent RpcClient with a heartbeat loop rather than per-task spawning).

### 7.2 Single-writer constraint in embedded mode

Beads embedded mode uses a file-locked Dolt database. Only one process can write at a time. In Integration A this is not a problem — the EM is the sole writer. In Integration B, concurrent agent writes require Server mode.

**Operational risk:** If two EM sessions are ever running against the same project directory (currently prevented by design, but possible in edge cases), or if a subagent is ever accidentally given write access while embedded mode is active, writes will block or fail with "database locked." The `runBd` helper's 15-second timeout would surface this as a tool error. Detection is straightforward; prevention requires discipline.

### 7.3 Subagent `bd` access delivery

Integrations B and C require subagents to call `bd` commands. There are two delivery options:

**Option 1: Via EM tool layer.** New tools (`bd_task_claim`, `bd_gate_eval`) are registered in the EM's extension and appear in the EM's tool namespace. Subagents that need them would have to be given these tools via a mechanism not currently supported in pit2 — subagents inherit the standard pi tool set, not the EM's registered tools.

**Option 2: Via subagent `bash` tool.** Subagents can call `bd` directly if the CLI is on their PATH. The `BEADS_DIR` env var must be set; this can be injected into the subagent's task description ("export BEADS_DIR=<cwd>/.beads before running bd commands"). This bypasses `beadsGuard` but that check is only needed at the EM level.

**Recommendation for Integration B:** Option 2 (direct `bash` access) is simpler and does not require changes to pi's tool injection model. Include explicit `BEADS_DIR` and `bd` usage instructions in the subagent's task description. Add `BEADS_DIR` to the task template generated by whatever molecule or workstream scaffolding is in use.

### 7.4 Granularity discipline

beads adds value proportional to the complexity and multi-session scope of the work being tracked. Creating a bead for every trivial delegation (a one-liner read, a quick question) produces a noisy, low-signal store that degrades `bd_list` and `bd_ready` utility. The BOUNDARIES.md two-part test (multi-session relevance + dependency value) must be applied consistently.

**Operational risk:** As the EM gets comfortable with beads, there is a natural tendency toward over-beading. A bead-count review should be part of any workstream retrospective. If `bd list` returns 40 tasks and 30 of them are trivially closed with no findings, the granularity is too fine.

### 7.5 Installation dependency

beads is a separate CLI tool (`bd` via Homebrew), not part of pi's npm package. Its availability is not guaranteed. Integration A handles this gracefully via `beadsGuard` (tools fail with a clear error if `bd` is unavailable). Integrations B–D inherit this assumption: if `bd` is not installed, all beads tools fail gracefully and the team falls back to EM-context-only coordination.

This is acceptable for a team-internal tool, but creates a setup requirement for new contributors. The `bd init --stealth --non-interactive` call in `ensureBeadsInit` will fail with a useful error if the binary is missing.

### 7.6 No native pi integration

beads is not a pi-native concept. It is an external tool called via `execFile`. There is no pi event integration (e.g., automatic bead creation on `delegate` call), no widget for bead state, and no cross-reference between pi's member roster and beads' task assignees. All integration is explicit and EM-initiated.

This is a deliberate Integration A constraint and reasonable for B and C as well. A tighter integration (e.g., auto-creating a task bead on every `delegate` call) would require modifying the `delegate` tool itself and would introduce the granularity problem (§7.4) unless carefully gated. **Recommendation:** Keep beads integration explicit and EM-controlled through Integration C. Only consider automatic bead creation if the EM is generating a high volume of delegations and manual bead management becomes a cognitive burden.

---

## Appendix A: Bottleneck × Integration Coverage Matrix

| Bottleneck | A | B | C | D |
|---|---|---|---|---|
| B1: EM context as coordination bus | ✅ addressed | — | — | partial |
| B2: 8-task parallelism cap | — | ✅ workaround | — | — |
| B3: Linear chains only | — | — | ✅ addressed | partial |
| B4: Ephemeral coordination state | ✅ addressed | — | ✅ gates durable | — |
| B5: Reactive resolveOrScale | — | ✅ addressed | — | — |
| B6: Name pool ceiling | — | — | — | — |
| B7: EM synthesis bottleneck | partial | ✅ addressed | ✅ addressed | — |

**Note:** B6 (name pool) is not addressed by any beads integration. It is a pit2 architectural constraint independent of the coordination layer. Resolution requires either increasing the pool size in `roster.json` or adding a name-recycling mechanism.

---

## Appendix B: Key `bd` Commands for Integration B Implementation

This section is a quick-reference for the implementer of Integration B. Full detail in `beads-em-reference.md`.

```bash
# Server mode setup (one-time, run before any bd commands in B)
dolt sql-server --port 3307 &
bd init --server --server-port=3307 --stealth --non-interactive

# Agent work loop (called from subagent bash tool)
export BEADS_DIR=<project_cwd>/.beads
bd ready --type=task --json                          # get unblocked tasks
bd update <id> --claim --json                        # atomic claim
bd show <id> --json                                  # read task detail (design field)
# ... execute task ...
bd close <id> --reason="<findings>" --json           # close with findings

# EM monitoring
bd list --status=open,in_progress --limit=0 --json  # full queue state
bd ready --type=task --json                          # what's unblocked
bd show <id> --json                                  # findings on a specific task
```

**Critical reminders:**
- `bd update --json` returns **array** `[{...}]` — parse with `[0]`
- `bd show --json` returns **array** `[{...}]` — parse with `[0]`
- `bd close --json` returns **array** `[{...}]` — parse with `[0]`
- `bd dep add <blocked-id> <blocker-id>` — first arg IS blocked (counterintuitive)
- `--status=open,in_progress` comma-separated; do NOT repeat the flag
- `bd ready` includes epics — always use `--type=task`
