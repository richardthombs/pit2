# pit2 — Feature Specifications

Formal specification of all user-visible features in the pit2 engineering organisation system.

---

## `/team` — Show roster

**What it does:** Displays the current team roster: every hired member, their role, and whether their role definition file is present.

**Invocation:** `/team`

**Expected output:**
```
Team roster (N member[s]):
✓  Alex Rivera — software-architect
✓  Casey Kim — typescript-engineer
⚠  Jordan Blake — missing-role   ← role definition file not found
```

**Edge cases:**
- Empty roster: shows a prompt to use `/hire` instead of a list.
- Member whose role definition file has been deleted: shown with a `⚠` warning rather than `✓`. The member remains on the roster; only the display flag changes.

**Out of scope:** Does not show task history, current status, or hire dates. See the team widget for live status.

---

## `/roles` — List available roles

**What it does:** Lists every role definition file found in `.pi/agents/`, with its description and current staffing.

**Invocation:** `/roles`

**Expected output:**
```
Available roles:
  software-architect [Alex Rivera]
    Designs system architecture, evaluates technical approaches...

  typescript-engineer [Casey Kim]
    Implements TypeScript code for pi extensions...

  qa-engineer [unstaffed]
    Tests pi extensions and tools...
```

**Edge cases:**
- A role with no hired members shows `[unstaffed]`.
- A role with multiple members shows all names: `[Alex Rivera, Sam Chen]`.
- No role files found in `.pi/agents/`: shows a message indicating the directory is empty.

---

## `/hire <role>` — Hire a team member

**What it does:** Creates a new team member entry for the given role. Assigns a name automatically from the name pool.

**Invocation:** `/hire <role-name>` (e.g. `/hire typescript-engineer`)

**Expected output on success:**
```
Welcome aboard, Casey Kim!
Role: typescript-engineer
Implements TypeScript code for pi extensions...
```

**Flow:**
1. Validates that a role definition file exists at `.pi/agents/<role-name>.md`.
2. Picks an unused name at random from the name pool.
3. Adds the member to `.pi/roster.json` with the current timestamp.
4. Updates the team widget.

**`/hire` with no argument:** Shows usage plus the list of available roles.

**Error cases:**
- Role not found: error notification listing available roles.
- Name pool exhausted (all 30 names used): error notification. No member is created.

**Constraints:**
- Names are assigned automatically; they cannot be chosen manually.
- The name pool contains 30 names. Once a name is used — even if that member is later fired — it is retired permanently for the project. Effective lifetime maximum: 30 hires.
- Multiple members can share the same role (horizontal scaling).

---

## `/fire <name>` — Remove a team member

**What it does:** Removes a team member from the roster after confirmation.

**Invocation:** `/fire <name>` (e.g. `/fire Casey Kim`, case-insensitive)

**Flow:**
1. Looks up the member by name (case-insensitive match).
2. Shows a confirmation dialog: "Let go of \<name\> (\<role\>)?"
3. On confirmation: removes the member from `.pi/roster.json` and updates the widget.
4. On cancellation: no change, shows "Cancelled."

**Name retention:** The fired member's name is kept in `usedNames` and will not be reassigned to a future hire. This is permanent.

**Error cases:**
- Name not found: error notification listing current team members.
- No argument given: error notification showing usage.

**Out of scope:** Firing a member does not affect any tasks already in progress — in-flight delegate calls are not cancelled.

---

## `delegate` tool — Dispatch tasks to team members

**What it does:** Sends a task to one or more team members and returns their output. Supports three modes: single, parallel, and chain.

### Single mode

Sends one task to one team member.

**Parameters:**
- `member` — full name of the team member (e.g. `"Casey Kim"`). Use `/team` to see names.
- `role` — role name (e.g. `"typescript-engineer"`). Resolves to the first team member with that role. Use `/roles` to see available roles.
- `task` — the task description. Must be self-contained — include all context needed.
- `cwd` — optional working directory override for the subprocess.

Exactly one of `member` or `role` must be provided.

**Returns:** The team member's final output text.

**Example:**
```json
{ "member": "Casey Kim", "task": "Read .pi/extensions/org/index.ts and summarise the error handling patterns." }
```

### Parallel mode

Runs up to 8 tasks concurrently.

**Parameters:**
- `tasks` — array of task objects, each with `member` or `role`, `task`, and optional `cwd`.

**Constraint:** Maximum 8 tasks. Exceeding this returns an error immediately without running any tasks.

**Returns:** Combined output from all tasks, with per-member success/failure markers. Reports `N/M tasks succeeded`.

**Behaviour:** All tasks start simultaneously. Tasks that fail (non-zero exit code) are reported individually; others are not affected.

**Example:**
```json
{
  "tasks": [
    { "role": "software-architect", "task": "Design the caching layer." },
    { "role": "qa-engineer", "task": "List edge cases for the caching layer." }
  ]
}
```

### Chain mode

Runs tasks sequentially. Each step can reference the previous step's output via the `{previous}` placeholder.

**Parameters:**
- `chain` — array of step objects, each with `member` or `role`, `task`, and optional `cwd`.

**`{previous}` substitution:** Before each step executes, all occurrences of `{previous}` in the `task` string are replaced with the previous step's output. In the first step, `{previous}` expands to an empty string.

**Failure behaviour:** If any step exits with a non-zero code, the chain halts immediately. Subsequent steps do not run. The error output from the failing step is returned.

**Returns:** Combined output from all completed steps, separated by step headers.

**Example:**
```json
{
  "chain": [
    { "role": "software-architect", "task": "Design the auth module interface." },
    { "role": "typescript-engineer", "task": "Implement this design: {previous}" }
  ]
}
```

### Async mode

By default `delegate` runs synchronously — it blocks until all work is complete and then returns the results. Setting `async: true` changes this: the tool returns immediately and results are injected as a follow-up message into the Engineering Manager's conversation when the work finishes.

**Parameter:**
- `async` — `true` to return immediately; `false` (default) to block until complete.

**When to use it:** Fire off a long-running task while continuing to do other things in the current turn — for example, kicking off a background research task while drafting a plan. Because results arrive as a follow-up message, the EM can respond to them naturally when they land.

**Result delivery per mode:**

| Mode | When the follow-up arrives |
|---|---|
| Single | One message when the task finishes |
| Parallel | One message per task, delivered independently as each completes |
| Chain | One combined message when all steps finish (or when the chain halts on failure) |

**Sync behaviour is unchanged:** When `async: false` (the default), `delegate` behaves exactly as before — it blocks and returns results directly. No migration is needed for existing usage.

**Widget updates:** The team widget reflects live status in real-time in both modes. Members transition through `working` → `done`/`error` as tasks progress, regardless of whether `async` is set.

---

### Error cases (all modes)

- Member name not found on roster → error with current roster listed.
- Role name not found on roster → error prompting to hire with `/hire <role>`.
- Role definition file missing for a rostered member → error naming the missing file.
- No `task`, `tasks`, or `chain` provided → usage error.

---

## `/async` — Toggle async delegation mode

**What it does:** Sets a session-level flag that controls whether `delegate` calls run synchronously (blocking until results are ready) or asynchronously (returning immediately, with results delivered as a follow-up message). This lets you fire off work and continue acting in the same turn while tasks run in the background.

**Invocation:**

| Form | Effect |
|---|---|
| `/async` | Toggles the current state (off → on, on → off) |
| `/async on` | Explicitly enables async mode |
| `/async off` | Explicitly disables async mode |

**Current state display:** The Engineering Manager line in the team widget shows the current mode: `async: on` or `async: off` alongside other session indicators. The state reflects the flag immediately after any `/async` command.

**Session scope:** The flag resets to **on** whenever the session starts or `/reload` is invoked. There is no persistence across sessions.

**Interaction with the `async` parameter on `delegate`:** An explicit `async: true` or `async: false` argument passed directly to a `delegate` call always takes precedence over the session toggle. The session flag only applies when no explicit `async` parameter is given.

**Example flow:**
```
/async on          # enable async for this session
delegate { role: "qa-engineer", task: "..." }   # returns immediately
# ... continue planning while QA runs ...
# follow-up message arrives with QA results
/async off         # back to synchronous delegation
```

**Out of scope:** The toggle does not affect tasks already in flight — changing the flag mid-turn only influences subsequent `delegate` calls.

---

## Team widget

**What it does:** Displays a live status panel showing the roster and each member's current state. Appears automatically below the editor when a session starts.

**States:**

| Symbol | State | Meaning |
|---|---|---|
| `○` | idle | No current task |
| `●` | working | Task in progress |
| `✓` | done | Last task completed successfully |
| `✗` | error | Last task failed |

**Task preview:** While working, done, or errored, a snippet is shown next to the status symbol.

- **Working:** Shows a live activity snippet — the last meaningful line of output from the subprocess, or `⚙ <tool-name>` when the member is invoking a tool. This updates in real time, throttled to approximately 6–7 fps (150 ms refresh interval).
- **Done / error:** Shows a snippet of the task description.

The snippet auto-sizes to fill all remaining terminal width after the fixed columns (prefix, name, role, status, usage), truncating with `…` if it overflows. The snippet is omitted entirely if there is not enough room.

**When it updates:**
- On session start or resume (all members reset to `idle`)
- When a task starts, completes, or errors
- When a member is hired or fired
- When `roster.json` is modified externally (watched via `fs.watch`)

**Done→idle auto-reset:** Members in the `done` state automatically return to `idle` after 5 minutes of inactivity. Members in `working` or `error` state are not affected.

**Reset timer lifecycle:** The 5-minute timer is per-member. If a member completes a second task while their timer is still running, the timer resets from that point. Timers are cleared on session reload or restart.

**Behaviour on restart:** All members are reset to `idle` on session start, regardless of prior state. Any pending done→idle timers are also cleared.

---

## Token usage tracking

**What it does:** The team widget displays accumulated token usage for each member once they have completed at least one delegation in the current session.

**Display format:**

```
  ├─ Casey Kim            typescript-engineer    ✓ done: Implement…  ↑24.7k ↓5.1k $0.0134
```

**Fields:**

| Symbol | Meaning |
|---|---|
| `↑` | Input tokens sent to the model |
| `↓` | Output tokens returned by the model |
| `$` | Estimated cost in USD (4 decimal places) |

Token counts are formatted with `k`/`M` suffixes (e.g. `12.3k`, `1.2M`). Fields with a zero value are omitted entirely.

**Accumulation:** Usage is summed across all delegations to that member within the session. Each time a member completes a task, their running totals are updated. The `contextTokens` value (context window size) reflects the most recent delegation rather than being summed.

**Session scope:** Totals are per-session only. They reset when the manager session restarts or `/reload` is invoked. There is no persistent history of token usage across sessions.

**When it appears:** The usage suffix is shown only after a member has completed at least one delegation. Members in `idle` state show no usage data.

---

## Role memory

**What it does:** Gives every role a persistent memory file that carries forward across delegations. Members self-maintain their role's file — recording conventions, decisions, pitfalls, and codebase landmarks they discover — and that file is automatically included in their context on each subsequent delegation.

**Memory file location:** `.pi/memory/<role>.md` — one file per role (e.g. `typescript-engineer.md`, `qa-engineer.md`). All members hired into the same role share a single memory file. Files are created by the member on their first write; no setup is required.

**Always on:** Memory injection is unconditional — there is no opt-in flag. Every member receives their memory context on every delegation, regardless of role.

**How memory is injected:** When `runTask()` spawns a subagent, it looks for a memory template at `.pi/prompts/memory.md`. The template contains `[name]` and `[path]` placeholders, which are replaced with the member's name and memory file path. If the template file is missing, a built-in fallback is used. The resulting block is appended to the agent's system prompt. If a memory file already exists for the member, its current contents are appended immediately after.

**How agents write memory:** Agents use their `write` and `edit` tools to update their memory file directly — no structured comment block or dispatcher involvement is needed. Agents decide what to record, how to organise it, and when to prune it. The memory file is plain markdown and can also be read or edited by hand.

**Lifecycle:**
- Memory files are created by the member when they first have something to record.
- Memory persists across sessions — it is the only persistent per-role state.
- Firing a member does **not** delete the role memory file. The file persists as long as any member with that role exists (or beyond). Role memory is only lost if the file is manually deleted.

**Out of scope:** There is no automatic summarisation, section structure, or entry limit imposed by the system; members manage their own files freely.

---

## Subagent context isolation

**What it does:** Ensures that each delegated subagent receives only its own role prompt and personal memory — not the Engineering Manager's system prompt or shared project context files.

**How it works:** When `runTask()` spawns a subagent subprocess, it passes two additional flags:

- `--system-prompt ""` — overrides the default system prompt with an empty string, preventing `.pi/SYSTEM.md` (the Engineering Manager prompt) from being loaded.
- `--no-context-files` — prevents automatic injection of context files such as `AGENTS.md`.

The agent's effective context is therefore: its role definition prompt (from `.pi/agents/<role>.md`) plus its role memory block (from `.pi/memory/<role>.md` if it exists).

**Why it matters:** Without isolation, subagents would inherit the Engineering Manager's instructions and shared project context. This produces role confusion and inflated context windows. Isolation keeps each subagent focused on its own role.

**Out of scope:** Subagents can still read any file they are given access to via their tools. Isolation prevents automatic injection at spawn time; it does not restrict what the agent can read or write during a task.

---

## Workstream persistence (Beads)

**What it does:** Gives the Engineering Manager a persistent workstream tracker for multi-step efforts that span multiple delegations or sessions. State is stored in a `.beads/` directory at the project root and survives context compaction and session restarts.

**Initialisation:** Beads is initialised automatically at session start via `bd init --stealth`. If `.beads/` already exists it is left untouched. If the `bd` CLI is unavailable, the tools fail gracefully with a clear error rather than crashing the session.

### Tools

| Tool | What it does |
|---|---|
| `bd_workstream_start` | Creates a beads *epic* to represent a workstream. Returns the epic ID for use when attaching tasks. |
| `bd_task_create` | Creates a task bead, optionally attached to an epic via `epic_id`. Returns the task ID. |
| `bd_task_update` | Updates a task's `status`, `notes`, or `design`. Use `status: "closed"` to close a completed task. |
| `bd_dep_add` | Records a `blocks` dependency between two tasks — equivalent to chain ordering, but explicit and persistent. |
| `bd_list` | Lists tasks, optionally filtered by status or assignee. Defaults to open/in-progress to reduce noise. |
| `bd_show` | Shows full detail for a single task or epic: design rationale, notes, dependencies, and status. |
| `bd_ready` | Lists tasks with no open blockers — i.e., work that is safe to delegate next. |

### When to use

Beads is for **EM coordination state** — tracking delegations within multi-step workstreams, recording what was found, and reconstructing context after compaction. Create an epic when you assign a workstream label; create task beads for each tracked delegation; update on completion; use `bd_list`, `bd_show`, and `bd_ready` to reconstruct state.

**Do not create beads for:**
- Single-delegation tasks with no follow-on work
- Work that obviously completes in the current session and will not be queried later
- Sub-steps internal to a subagent's own work

### Design vs Notes fields

- **`design`** — set at creation. Records *why*: rationale, decisions, constraints. For future sessions that need to understand intent.
- **`notes`** — set on update. Records *what happened*: findings, artefacts produced, caveats. Write for future-you after compaction; two to five sentences is enough.

**Out of scope:** Beads tracks EM-level coordination only. Subagents do not interact with beads directly. There is no built-in visualisation — use `bd_list` and `bd_show` to inspect state.

---

## Broker (Integration B)

**What it does:** Provides autonomous task dispatch from the beads ready queue to team members — without EM involvement. Once activated, the broker watches for tasks that have a `role` label and dispatches each one to an available team member with the matching role as soon as all of its blockers are resolved.

**Activation:**

| Tool | What it does |
|---|---|
| `bd_broker_start` | Activates the broker for the current session. Triggers an immediate dispatch cycle, then polls every 30 seconds. |
| `bd_broker_stop` | Deactivates the broker. In-flight tasks complete normally; no new dispatches are triggered. |

Both tools take no parameters.

### Creating broker-owned tasks

Pass a `role` parameter to `bd_task_create` to mark a task for broker dispatch:

```json
{ "title": "Implement auth middleware", "epic_id": "EP-1", "role": "typescript-engineer" }
```

The `role` value must match an agent slug in `.pi/agents/`. Unlabelled tasks are ignored by the broker — they remain EM-owned and should be dispatched manually via `delegate`.

### Dispatch behaviour

- **Readiness-triggered:** A task is dispatched only when all tasks that block it are closed. The broker checks readiness via `bd_ready`.
- **Member resolution:** The broker calls the same resolution logic as `delegate` — it finds an available member with the requested role, or hires one if the roster allows.
- **Upstream context injection:** Before dispatching, the broker reads the resolved blocker tasks and prepends a context summary (titles + notes/commit/file references from each blocker, capped at 2 000 characters) into the task brief. The subagent doesn't need to query its own dependencies.
- **Task brief:** The agent is instructed to fetch full task detail from beads using `bd show <id>` at the start of the task.

### Result capture

On successful completion, the broker records results back into beads before closing the task:

| Output type | How it's recorded |
|---|---|
| File changes (new git commit) | Commit SHA recorded in `metadata.git_commit` |
| Text output ≤ 40 KB | Full output appended to `notes` |
| Text output > 40 KB | Written to `.pi/task-results/<id>.md`; path recorded in `metadata.result_file` |

### Failure handling

- A failed task is re-opened (status reset to `open`) and re-queued for the next dispatch cycle.
- After **3 consecutive failures**, the task is set to `deferred` and the EM is notified to intervene.
- The EM should use `bd_show` to inspect the task, fix the brief or unblock the issue, then manually reset the status to `open` to re-enable dispatch.
- Failure counts are in-memory and persist for the lifetime of the broker process. They are **not** reset when the broker is stopped and restarted via `bd_broker_stop` / `bd_broker_start`.

### Coexistence with `delegate`

The broker and the `delegate` tool are complementary:

- Tasks **with** a `role` label → broker-owned; dispatched automatically.
- Tasks **without** a `role` label → EM-owned; dispatched manually via `delegate`.

Both can be used in the same session and the same workstream.

**Out of scope:** The broker does not support parallel dispatch to multiple roles for a single task, custom retry delays, or priority ordering. All ready labelled tasks are dispatched in the order returned by `bd_ready`.

---

## Name pool

The system maintains a fixed pool of 30 gender-neutral names used for automatic assignment when hiring. Key properties:

- Names are assigned randomly from the available (unused) pool.
- A name is retired after assignment, even if the member is later fired.
- Once all 30 names are used, `/hire` will fail with "Name pool exhausted — maximum team size reached."
- The `usedNames` array in `.pi/roster.json` tracks retired names across the project lifetime.
- There is no way to reset or extend the pool without editing `roster.json` directly.
