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

### Error cases (all modes)

- Member name not found on roster → error with current roster listed.
- Role name not found on roster → error prompting to hire with `/hire <role>`.
- Role definition file missing for a rostered member → error naming the missing file.
- No `task`, `tasks`, or `chain` provided → usage error.

---

## Handoff files — Structured plans for multi-phase delegation

**What it does:** Handoff files let a specialist produce a structured plan intended for human review before execution begins. When a task spans multiple phases with a review gate in between, the planner writes a handoff file to `.pi/handoffs/`; a later executor reads that file instead of reconstructing all context from scratch.

**When to use:** Multi-phase tasks where the Engineering Manager or stakeholder needs to review and approve a plan before execution starts. Single-phase tasks and chain-mode sequences do not require handoffs.

### File location and naming

```
.pi/handoffs/<member-id>-<task-slug>.md
```

Example: `.pi/handoffs/casey-kim-auth-module-design.md`

### Format

Files use YAML frontmatter followed by a Markdown body.

**Required frontmatter fields:**

| Field | Values | Description |
|---|---|---|
| `status` | `planning` \| `ready` \| `consumed` | Current lifecycle state |
| `author` | string | Full name of the specialist who wrote the file |
| `author-id` | string | Kebab-case member ID (e.g. `casey-kim`) |
| `role` | string | Role of the author (e.g. `software-architect`) |
| `task-slug` | string | Short identifier matching the filename slug |
| `created` | ISO 8601 date | When the file was written |

**Optional frontmatter fields:**

| Field | Description |
|---|---|
| `consumed` | Timestamp set when an executor picks up the file |
| `target-member` | Name or ID of the intended executor |
| `depends-on` | Slug(s) of prerequisite handoffs |
| `files-read` | List of source files consulted when writing the plan |

**Required body sections:**

- `## Objective` — What the task is trying to achieve
- `## Background and Context` — Relevant prior decisions, current state, why this matters
- `## Constraints and Non-Goals` — What is out of scope or must not change
- `## Detailed Plan` — Step-by-step plan for the executor
- `## Files to Read` — Files the executor should read before starting
- `## Acceptance Criteria` — How to know the task is done
- `## Open Questions` — Unresolved questions for the reviewer to address before approving

### Status lifecycle

```
planning  →  ready  →  consumed
```

- **`planning`** — Written by the specialist. Awaiting Engineering Manager or stakeholder review.
- **`ready`** — Approved via `/approve-handoff`. Safe to delegate for execution.
- **`consumed`** — The executor has picked it up and the task is in progress.

Do not delegate execution of a handoff until its status is `ready`.

### Cleanup

Delete the handoff file once the task is complete and accepted. Git history serves as the archive.

---

## `/approve-handoff` — Approve a handoff for execution

**What it does:** Advances a handoff file's status from `planning` to `ready`, unblocking delegation to an executor.

**Invocation:** `/approve-handoff <task-slug>`

**Matching:** The slug is matched against filenames in `.pi/handoffs/`. A file matches if its name is exactly `<slug>.md` or ends with `-<slug>.md`. This means you can use just the task-slug portion without the member-id prefix.

**Expected output on success:**
```
Approved handoff "casey-kim-auth-module-design".

Objective:
Design the public interface for the authentication module before implementation begins.
```

**Flow:**
1. Reads all `.md` files from `.pi/handoffs/`.
2. Finds files whose name matches `<slug>.md` or ends with `-<slug>.md`.
3. If exactly one match: reads the file, sets `status: ready` in the frontmatter, and writes it back.
4. Displays the `## Objective` section as confirmation.

**Edge cases:**
- No slug given: shows usage and lists all available handoffs.
- Slug not found: shows an error and lists available handoffs.
- Multiple files match the slug: shows all matching names and asks for a more specific slug (use the full filename stem).
- Already `ready`: reports "already approved" without modifying the file (idempotent).

**Out of scope:** Does not validate that required body sections are present. Does not set `consumed` — that is the executor's responsibility.

---

## Team widget

**What it does:** Displays a live status panel showing the roster and each member's current state. Appears automatically below the editor when a session starts.

**States:**

| Symbol | State | Meaning |
|---|---|---|
| `●` | idle | No current task |
| `◎` | working | Task in progress |
| `✓` | done | Last task completed successfully |
| `✗` | error | Last task failed |

**Task preview:** While working, done, or errored, a truncated snippet of the task description (up to 40 characters) is shown next to the status.

**When it updates:**
- On session start or resume (all members reset to `idle`)
- When a task starts, completes, or errors
- When a member is hired or fired
- When `roster.json` is modified externally (watched via `fs.watch`)

**Behaviour on restart:** All members are reset to `idle` on session start, regardless of prior state.

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

## Name pool

The system maintains a fixed pool of 30 gender-neutral names used for automatic assignment when hiring. Key properties:

- Names are assigned randomly from the available (unused) pool.
- A name is retired after assignment, even if the member is later fired.
- Once all 30 names are used, `/hire` will fail with "Name pool exhausted — maximum team size reached."
- The `usedNames` array in `.pi/roster.json` tracks retired names across the project lifetime.
- There is no way to reset or extend the pool without editing `roster.json` directly.
