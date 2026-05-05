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

**Tool equivalent:** `hire` is also available as an LLM-callable tool: `hire { role: "typescript-engineer" }`. This lets the Engineering Manager hire without using the slash command.

---

## `/fire <name>` — Remove a team member

**What it does:** Removes a team member from the roster after confirmation.

**Invocation:** `/fire <name>` (e.g. `/fire Casey Kim`, case-insensitive)

**Flow:**
1. Looks up the member by name (case-insensitive match).
2. Shows a confirmation dialog: "Let go of \<name\> (\<role\>)?"
3. On confirmation: removes the member from `.pi/roster.json`, deletes their memory file (`.pi/memory/<name>.md`) if it exists, and updates the widget.
4. On cancellation: no change, shows "Cancelled."

**Name retention:** The fired member's name is kept in `usedNames` and will not be reassigned to a future hire. This is permanent.

**Error cases:**
- Name not found: error notification listing current team members.
- No argument given: error notification showing usage.

**Out of scope:** Firing a member does not affect any tasks already in progress — in-flight delegate calls are not cancelled.

**Tool equivalent:** `fire` is also available as an LLM-callable tool: `fire { member: "Casey Kim" }`. Unlike the slash command, the tool version does **not** prompt for confirmation before removing the member.

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

Async mode is **on by default**. When active, `delegate` returns immediately and results are injected as a follow-up message into the Engineering Manager's conversation when the work finishes. Setting `async: false` (or running `/async off`) switches to synchronous mode, where `delegate` blocks until all work is complete and returns results directly.

**Parameter:**
- `async` — override the session async flag for this call: `true` to return immediately; `false` to block until complete. If omitted, the session flag (on by default) applies.

**When to use it:** Fire off a long-running task while continuing to do other things in the current turn — for example, kicking off a background research task while drafting a plan. Because results arrive as a follow-up message, the EM can respond to them naturally when they land.

**Result delivery per mode:**

| Mode | When the follow-up arrives |
|---|---|
| Single | One message when the task finishes |
| Parallel | One message per task, delivered independently as each completes |
| Chain | One combined message when all steps finish (or when the chain halts on failure) |

**Switching to sync:** Pass `async: false` explicitly or run `/async off` to make `delegate` block and return results directly.

**Widget updates:** The team widget reflects live status in real-time in both modes. Members transition through `working` → `done`/`error` as tasks progress, regardless of whether `async` is set.

---

### Error cases (all modes)

- Member name not found on roster → error with current roster listed.
- Role name not found on roster → error prompting to hire with `/hire <role>`.
- Role definition file missing for a rostered member → error naming the missing file.
- No `task`, `tasks`, or `chain` provided → usage error.

### Auto-scaling

When you delegate by role and all current members of that role are busy, the system automatically hires a new team member for that role to handle the task. The output will include a note such as "Auto-hired Riley Torres (typescript-engineer) — task started."

**How it applies:**
- **By role** (`role: "typescript-engineer"`): if all members of that role are busy, a new one is auto-hired.
- **By name** (`member: "Casey Kim"`): if that specific member is busy, the system falls back to role-based resolution — including auto-scaling — using their role.

**Limits:** Auto-scaling is bounded by the name pool. If all 30 names have been used and every current member of the role is busy, delegation fails with a "Name pool exhausted" error.

**Roster impact:** Auto-hired members remain on the roster after the task completes. They are available for future delegations and maintain their own memory.

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
delegate { role: "qa-engineer", task: "..." }   # returns immediately — async is on by default
# ... continue planning while QA runs ...
# follow-up message arrives with QA results
/async off         # switch to synchronous delegation
delegate { role: "typescript-engineer", task: "..." }   # blocks until complete
/async on          # restore async mode
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

**Task preview:** While working, done, or errored, a snippet of the task description is shown next to the status. The snippet auto-sizes to fill all remaining terminal width after the fixed columns (prefix, name, role, status, usage), truncating with `…` if it overflows. The snippet is omitted entirely if there is not enough room.

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

## Per-member memory

**What it does:** Gives each team member a persistent memory that carries forward across delegations. On every delegation, the member's memory file (if it exists) is automatically injected into their context along with their name and memory file path. The member is instructed to read it at task start and update it at task end. Memory accumulates over time, so members become progressively better-informed about the project.

**Always on:** Memory is enabled for all members automatically — no configuration or opt-in required.

**Memory file location:** `.pi/memory/<member-name>.md` — one file per team member (e.g. `.pi/memory/casey-kim.md`). Files are created by agents on their first write; no setup is needed.

**How memory is injected:** On every delegation, the agent's system prompt is extended with a `## Your Identity & Memory` block that tells them their name, the path to their memory file, and instructs them to read it at the start of the task and update it at the end. If a memory file already exists and has content, its full contents are appended to this block so prior context is immediately visible.

**How agents write memory:** Agents use their standard file tools (`write`, `edit`) to update their memory file directly. The content and format are up to the agent. Common content includes project conventions, architectural decisions, pitfalls encountered, and key file locations.

**Lifecycle:**
- Memory files are created by agents on their first write; no bootstrapping is required.
- Firing a team member **deletes** their memory file.
- Memory persists across sessions — it is the only team-level state that does.

**Out of scope:** Memory is per-member, not shared across members of the same role. Two members holding the same role maintain independent memories. There is no automatic summarisation or pruning — agents manage their own files directly.

---

## Name pool

The system maintains a fixed pool of 30 gender-neutral names used for automatic assignment when hiring. Key properties:

- Names are assigned randomly from the available (unused) pool.
- A name is retired after assignment, even if the member is later fired.
- Once all 30 names are used, `/hire` will fail with "Name pool exhausted — maximum team size reached."
- The `usedNames` array in `.pi/roster.json` tracks retired names across the project lifetime.
- There is no way to reset or extend the pool without editing `roster.json` directly.
