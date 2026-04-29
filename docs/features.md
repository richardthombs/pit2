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

## Name pool

The system maintains a fixed pool of 30 gender-neutral names used for automatic assignment when hiring. Key properties:

- Names are assigned randomly from the available (unused) pool.
- A name is retired after assignment, even if the member is later fired.
- Once all 30 names are used, `/hire` will fail with "Name pool exhausted — maximum team size reached."
- The `usedNames` array in `.pi/roster.json` tracks retired names across the project lifetime.
- There is no way to reset or extend the pool without editing `roster.json` directly.
