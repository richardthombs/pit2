# Implementation Spec: Broker-Only Dispatch (delegate retirement + full result delivery)

**Status:** Proposed  
**Author:** Alex Rivera  
**Date:** 2026-05-01  
**Decisions incorporated:**
- Decision 1 — Broker delivers full task results to the EM via follow-up message
- Decision 2 — `delegate` tool retired; all dispatch goes through beads + broker

**ADR produced:** ADR-008 (§9)  
**Supersedes:** ADR-007 (delegate–broker unification via bead wrapping — archived)

---

## 1. Overview

Two stakeholder decisions collapse the two-path dispatch model into a single path:

- **Before:** `delegate` (imperative, inline or async) + broker (declarative, opt-in). Two parallel paths with different tracking semantics.
- **After:** broker only. All task delegation goes through `bd_task_create` + `bd_broker_start`. The EM expresses dependencies with `bd_dep_add`; the broker handles dispatch sequencing. Results arrive as follow-up messages with full verbatim output, exactly as async `delegate` did before.

The broker is no longer opt-in for tracked work — it becomes the default dispatch mechanism.

Key properties that are preserved from the old `delegate` experience:
- Results arrive in-conversation as follow-up messages
- The EM receives the **full** agent output, not a summary
- The EM can read results and direct follow-up work naturally
- Member status widget updates as tasks start and complete

---

## 2. Decision 1: Broker Result Delivery to EM

### 2.1 What changes

Currently, `_runAndClose` in `broker.ts` calls `captureResult()` (which writes to beads) and calls `notifyEM` only on failures. Successful task completions are silent — beads records are updated but the EM receives nothing.

**New behaviour:** After every successful `captureResult()`, the broker immediately sends a follow-up message to the EM with the complete verbatim agent output, headed with bead ID, title, and role so the EM can correlate it to the workstream.

### 2.2 Message format

```
**Task completed: [title]**
Bead `[taskId]` · Role: [role] · Member: [memberName]

[full verbatim agent output]
```

The bead ID is the primary correlation key: the EM has it in their beads state. The title and role are human-oriented quick identifiers. The full output follows, unsummarised, so the EM can reason about it directly.

Example:
```
**Task completed: Implement OAuth2 token refresh**
Bead `task-0042` · Role: typescript-engineer · Member: Sam Chen

I've implemented the OAuth2 token refresh flow in `src/auth/token.ts`. The changes include:

1. Added `refreshAccessToken()` with exponential backoff...
[... full output ...]
```

### 2.3 New callback in `Broker.configure()`

Add a `deliverResult` callback alongside the existing `notifyEM`:

```typescript
// broker.ts — updated configure() signature
configure(
    runBd: RunBdFn,
    resolveOrScale: ResolveOrScaleFn,
    runTask: RunTaskFn,
    memberState: Map<string, MemberState>,
    notifyEM: (msg: string) => void,
    deliverResult: (taskId: string, taskTitle: string, role: string, memberName: string, output: string) => void,
    scheduleDoneReset: (memberName: string) => void,
): void {
    this.runBd = runBd;
    this.resolveOrScale = resolveOrScale;
    this.runTask = runTask;
    this.memberState = memberState;
    this.notifyEM = notifyEM;
    this.deliverResult = deliverResult;
    this.scheduleDoneReset = scheduleDoneReset;
}
```

And the corresponding private fields:
```typescript
private notifyEM!: (msg: string) => void;
private deliverResult!: (taskId: string, taskTitle: string, role: string, memberName: string, output: string) => void;
private scheduleDoneReset!: (memberName: string) => void;
```

**Why a separate callback rather than reusing `notifyEM`?**  
`notifyEM` is used for operational noise (failures, stuck tasks, broker warnings). Full result delivery is a different register — it is the primary EM data channel. Keeping them separate makes it easy to differentiate them in a future UI and keeps `notifyEM` messages clearly diagnostic.

**Why include `scheduleDoneReset`?**  
Without delegate, `scheduleDoneReset` (the 5-minute done→idle reset timer) is no longer called for broker-dispatched members. Members would stay in `done` state indefinitely until the reaper fires. Passing the callback into the broker lets it be called after successful task completion, restoring the correct widget behaviour.

### 2.4 Updated `_runAndClose` — section 4 (capture and delivery)

Replace the existing section 4 in `_runAndClose`:

```typescript
// ── 4. Capture result + deliver to EM, or requeue (serialised through write queue) ─────
if (result.exitCode === 0) {
    this._enqueueWrite(cwd, async () => {
        await this.captureResult(cwd, task.id, result.output, commitBefore);
        // Decision 1: deliver full output to EM after beads record is committed.
        this.deliverResult(
            task.id,
            task.title,
            role,
            r.member.name,
            result.output,
        );
        // Reset member status to idle after 5 minutes
        this.scheduleDoneReset(r.member.name);
    });
} else {
    const reason = `exitCode ${result.exitCode}: ${(result.stderr || result.output).slice(0, 200)}`;
    this._enqueueWrite(cwd, () => this._requeueTask(cwd, task.id, reason));
}
```

**Key design choices:**
- `deliverResult` is called **inside** `_enqueueWrite`, after `captureResult()`. This ensures the EM receives the result only after the beads record is committed — no gap where the EM has the result but beads hasn't recorded it yet.
- `deliverResult` is called with the original `result.output` from `runTask`, not from beads. This avoids an extra `bd show` round-trip and guarantees verbatim content (beads notes may be truncated for large outputs; the in-memory output is always complete).
- On failure paths, no result is delivered — only `notifyEM` with the failure reason (existing behaviour unchanged).

### 2.5 `broker.configure()` wiring in `index.ts`

Replace the current `broker.configure(...)` call:

```typescript
// index.ts — updated broker.configure() call
broker.configure(
    runBd,
    (cwd, ms, role) => resolveOrScale(cwd, ms, undefined, role),
    runTaskWithStreaming,
    memberState,
    // notifyEM — operational messages (failures, warnings)
    (msg) => pi.sendUserMessage(msg, { deliverAs: "followUp" }),
    // deliverResult — completed task output
    (taskId, taskTitle, role, memberName, output) => {
        const header = `**Task completed: ${taskTitle}**\nBead \`${taskId}\` · Role: ${role} · Member: ${memberName}\n\n`;
        pi.sendUserMessage(header + output, { deliverAs: "followUp" });
    },
    // scheduleDoneReset — resets member status to idle after 5 min
    (memberName) => scheduleDoneReset(memberName),
);
```

### 2.6 Notes length safety in `captureResult`

`--append-notes` has no application-level pre-flight length check. The 64KB ceiling is enforced silently at the Dolt layer via a raw SQL error — the `bd` CLI will not warn before the write fails.

The broker's `captureResult` implementation must therefore check cumulative notes length before calling `--append-notes`. The check:

```typescript
// In captureResult, before calling --append-notes:
const existingBead = await this.runBd(cwd, ['show', taskId, '--json']);
const existingNotes = existingBead[0]?.notes ?? '';
const NOTES_SAFE_THRESHOLD = 50 * 1024; // 50KB — leaves 14KB headroom below 64KB Dolt ceiling

if ((existingNotes.length + newOutput.length) > NOTES_SAFE_THRESHOLD) {
    // Switch to file-reference branch
    const resultPath = `.pi/task-results/${taskId}.md`;
    await fs.writeFile(path.join(cwd, resultPath), newOutput, 'utf8');
    await this.runBd(cwd, ['update', taskId, '--set-metadata', `result_file=${resultPath}`]);
} else {
    await this.runBd(cwd, ['update', taskId, '--append-notes', newOutput]);
}
```

**Why 50KB?** The `existingNotes` snapshot may be slightly stale (a concurrent write could land between `bd show` and `bd update`), so a 14KB buffer handles reasonable concurrent write scenarios. 50KB is also a clean per-task threshold the EM can reason about.

**This check is required**, not optional. Omitting it risks silent data loss: the notes write fails with a Dolt SQL error, `captureResult` throws, `_enqueueWrite` fails, and the task result is neither committed to beads nor delivered to the EM.

This check applies regardless of whether prior notes exist (even an empty notes field + a 60KB output would exceed the ceiling).

---

## 3. Decision 2: `delegate` Tool Retirement

### 3.1 What is removed from `index.ts`

| Item | Reason |
|---|---|
| `pi.registerTool({ name: "delegate", ... })` block (~500 lines) | The tool itself |
| `DelegateParams` type definition | Used only by `delegate` parameters |
| `AssigneeFields` object | Used only by `DelegateParams` |
| `asyncMode` variable (`let asyncMode = true`) | Only controls delegate dispatch mode |
| `/async` command (`pi.registerCommand("async", ...)`) | Only toggles `asyncMode` |
| `deliverResult` function | Delegate-only result delivery; replaced by broker callback |

**`setMemberStatus` and `scheduleDoneReset`:** Both are defined in the outer closure and used by `delegate`. They must be **retained** — `setMemberStatus` is a convenient memberState patcher and `scheduleDoneReset` is wired into the broker as a callback (§2.3). Do not remove these.

**`accumulateUsage`:** Also retained. Used by delegate currently; should also be wired to the broker via a callback (see §3.3 below).

### 3.2 What stays

All of the following is unaffected and must be preserved:

| Item | Reason |
|---|---|
| `resolveOrScale` (module-scope) | Used by broker via configure callback |
| `runTask` | Core execution engine, used by `runTaskWithStreaming` |
| `runTaskWithStreaming` | Used by broker via configure callback |
| All `RpcClient` management (`getOrCreateClient`, `stopLiveClient`, `reapIdleClients`, `liveMembers`, etc.) | Backing infrastructure for `runTaskWithStreaming` |
| All beads tools (`bd_workstream_start`, `bd_task_create`, `bd_task_update`, `bd_dep_add`, `bd_list`, `bd_show`, `bd_ready`, `bd_broker_start`, `bd_broker_stop`) | Primary EM interface |
| Team management tools and commands (`hire`, `fire`, `/hire`, `/fire`, `/team`, `/roles`) | Unrelated to dispatch |
| Widget (`buildWidgetLines`, `updateWidget`, `scheduleWidgetRefresh`) | Still used |
| `memberState`, `memberUsage` maps | Still used |
| `reaperInterval` | Still used |
| `session_start`, `session_shutdown` event handlers | Still used |
| `setMemberStatus`, `scheduleDoneReset`, `accumulateUsage` helpers | Used by broker callbacks |

### 3.3 Secondary wiring: usage accumulation

The broker currently ignores `RunResult.usage`. The broker's `RunTaskFn` type in `broker.ts` is:
```typescript
type RunTaskFn = (config: AgentConfig, memberName: string, task: string, cwd: string) => Promise<RunResult>;
```

And `RunResult` in `broker.ts` is:
```typescript
interface RunResult {
    exitCode: number;
    output: string;
    stderr: string;
}
```

`RunResult` in `index.ts` additionally carries `usage: UsageStats`. The broker currently strips this.

**Fix:** Add `accumulateMemberUsage: (memberName: string, usage: UsageStats) => void` as another callback in `configure()`, and update the broker's `RunResult` interface to include `usage`. Call the callback after a successful task completes:

```typescript
// broker.ts — add to configure() and private fields
private accumulateMemberUsage!: (memberName: string, usage: UsageStats) => void;

// broker.ts — in section 4 of _runAndClose, after deliverResult:
if (result.usage) {
    this.accumulateMemberUsage(r.member.name, result.usage);
}
```

```typescript
// index.ts — in broker.configure():
(memberName, usage) => accumulateUsage(memberName, usage),
```

This is a secondary improvement — usage stats for broker tasks are already broken. Include in the same implementation pass.

### 3.4 Widget: `asyncMode` display line

The widget header currently reads: `Engineering Manager  (async: on)`. With `asyncMode` removed, update `buildWidgetLines` to drop this suffix:

```typescript
// Before:
const lines: string[] = [`  Engineering Manager  (async: ${asyncMode ? "on" : "off"})`];

// After:
const lines: string[] = [`  Engineering Manager`];
```

---

## 4. Chain Pattern: A → B → C Without `delegate`

### 4.1 How the EM expresses sequencing

Without `delegate chain`, the EM uses beads dependencies:

```
bd_workstream_start(title: "auth-refactor")         → epic-001
bd_task_create(title: "Design auth architecture",
               epic_id: "epic-001",
               role: "software-architect")           → task-001
bd_task_create(title: "Implement OAuth2 flow",
               epic_id: "epic-001",
               role: "typescript-engineer")          → task-002
bd_task_create(title: "QA auth implementation",
               epic_id: "epic-001",
               role: "qa-engineer")                  → task-003
bd_dep_add(blocker_id: "task-001", blocked_id: "task-002")  // design blocks impl
bd_dep_add(blocker_id: "task-002", blocked_id: "task-003")  // impl blocks QA
bd_broker_start()
```

The broker now runs the chain without further EM involvement:
1. Dispatches task-001 (no blockers)
2. task-001 closes → broker delivers A's full output to EM → dispatches task-002 (task-001 is now closed)
3. task-002 closes → broker delivers B's full output to EM → dispatches task-003
4. task-003 closes → broker delivers QA result to EM

### 4.2 How B gets A's output

Two mechanisms work together:

**Mechanism 1: Upstream context injection (existing §17.4)**  
When the broker dispatches task-002, it calls `bd show task-002 --json` and finds `task-001` in the dependencies. It extracts A's result from the embedded blocker object (priority: `metadata.git_commit` > `metadata.result_file` > `notes[:300]`) and prepends it to task-002's brief as a 2000-char context block.

**Mechanism 2: EM intermediation (new)**  
Before task-002 is dispatched, the EM receives task-001's **full** output as a follow-up message (§2.4). The EM can update task-002's bead before the broker picks it up. If B's design or acceptance criteria need to be informed by A's detailed findings, the EM calls `bd_task_update(id: "task-002", design: "...")` to enrich the brief. The broker's next dispatch cycle picks up the updated bead content.

**Timing window:** The `onTaskCreated` event from `bd_task_update` triggers a new dispatch cycle. Because `captureResult` (and thus `deliverResult`) runs inside `_enqueueWrite`, the sequence is:
1. task-001 `runTask` completes
2. `captureResult` writes to beads (serialised) → `bd close task-001`
3. `deliverResult` calls `pi.sendUserMessage` → follow-up arrives in EM's context
4. Next `_dispatchCycle` call finds task-002 now unblocked
5. Broker dispatches task-002

Steps 3 and 4 happen in the same write queue flush, so the EM's window to intervene is: from when the follow-up arrives until task-002's status is set to `in_progress` by the broker. In practice this is sub-second. If the EM needs to update task-002 before dispatch, they should **pre-populate the design field** when creating the bead, using whatever context is known at planning time. Post-completion enrichment via `bd_task_update` is a best-effort escape hatch.

### 4.3 Contrast with old `delegate chain`

| Capability | `delegate chain` | Beads + broker |
|---|---|---|
| EM receives full results | Yes (chain summary at end) | Yes (per-step follow-ups) |
| Intermediate results visible to EM | Only as chain progresses in one session | Yes — each step delivers independently |
| `{previous}` substitution | Yes (inline string injection) | No — replaced by upstream context injection + `bd show` |
| Works across sessions | No — chain is abandoned if session ends | Yes — broker picks up from where beads left off |
| EM can update brief mid-chain | No | Yes — via `bd_task_update` before dispatch |
| Dependency tracking | Implied by sequence | Explicit `bd_dep_add`; queryable with `bd_ready` |
| Fan-in (N upstream → 1 downstream) | Not supported | Supported — N `bd_dep_add` calls; broker injects all N contexts |

The tradeoff: `{previous}` full-text injection is replaced by a 2000-char upstream context block. For tasks that genuinely need the full upstream text injected inline, the EM can read A's result from the follow-up message and update B's design field with the relevant excerpts before the broker dispatches B.

---

## 5. Fan-in Pattern

Fan-in is when task D depends on tasks B and C both completing:

```
bd_dep_add(blocker_id: "task-B", blocked_id: "task-D")
bd_dep_add(blocker_id: "task-C", blocked_id: "task-D")
```

Behaviour:
1. Broker dispatches B and C concurrently (both have no outstanding blockers)
2. B completes → full result delivered to EM; broker checks D — still blocked by C; no dispatch
3. C completes → full result delivered to EM; broker checks D — both blockers closed; broker dispatches D
4. D dispatched with both B's and C's results injected into its brief (§17.4 handles N upstream tasks)
5. D completes → full result delivered to EM

The EM knows when to act after D because the broker delivers D's result as a follow-up message. The EM does not need to poll `bd_ready` — the broker handles the gate.

**No special handling needed.** The existing `buildUpstreamContext` in `broker.ts` maps over `blockers` and produces N bullet points. `bd show` on D returns both B and C in its `dependencies` array, filtered by `dependency_type === 'blocks'`, each carrying their full result metadata. The 2000-char cap distributes across all N blockers.

---

## 6. `delegate` Removal: Exact Changes to `index.ts`

### 6.1 Lines to delete (approximate — verify against current file before implementing)

| Block | Description |
|---|---|
| `let asyncMode = true;` | State variable for delegate |
| `function deliverResult(...)` | Delegate-specific result delivery (replaced by broker callback) |
| `pi.registerCommand("async", ...)` | Toggle command for asyncMode |
| `const AssigneeFields = { ... }` | Schema object used only by DelegateParams |
| `const DelegateParams = Type.Object({ ... })` | Schema type used only by delegate |
| `pi.registerTool({ name: "delegate", ... })` | The tool itself (~500 lines, last tool registration in the file) |
| Widget header `async: on/off` display | See §3.4 |

### 6.2 Lines to add/modify

| Location | Change |
|---|---|
| `broker.configure(...)` call | Add `deliverResult`, `scheduleDoneReset`, `accumulateMemberUsage` callbacks (§2.5, §3.3) |
| `Broker` private fields | Add `deliverResult`, `scheduleDoneReset`, `accumulateMemberUsage` |
| `Broker.configure()` signature | Add corresponding parameters |
| `Broker._runAndClose` section 4 | Replace with §2.4 block |
| `buildWidgetLines` | Drop `asyncMode` from header |

### 6.3 Lines that do NOT change

Everything else in `index.ts`. `resolveOrScale`, `runTask`, `runTaskWithStreaming`, all beads tools, all team management, all widget code, all event handlers — untouched.

---

## 7. Granularity: Trivial Queries Without `delegate`

### 7.1 The concern

`delegate` handled one-off, in-session tasks with no tracking overhead:
```
delegate({ role: "typescript-engineer", task: "What does `withFileMutationQueue` do?" })
```
With `delegate` gone, every dispatch requires `bd_task_create` + broker. Is this too heavy for trivial queries?

### 7.2 Recommendation: no new tool needed

The overhead of `bd_task_create` is one CLI call (~50ms). For any task that actually needs a specialist agent — even a quick research question — this overhead is negligible compared to the agent's response time. The EM's concern about ceremony is real but the concrete cost is tiny.

**Pattern for trivial tasks (no epic needed):**
```
bd_task_create(
    title: "What does withFileMutationQueue do?",
    role: "typescript-engineer"
    // No epic_id — standalone task
)
// broker is already running
// Result arrives as follow-up in ~30s
```

The broker is idempotent: calling `bd_broker_start` when already active is a no-op (already handled in `bd_broker_start.execute`). The EM starts the broker once at session start for any workstream and leaves it running. Trivial tasks get automatically dispatched.

**For questions the EM can answer themselves:** The SYSTEM.md guidance already carves out cases where the EM does not need to delegate. A question about framework internals → delegate. A question about what tools are registered → the EM reads the extension code itself. That boundary is unchanged.

### 7.3 Session startup pattern

The new recommended EM startup for any session with delegation:
```
// One-time session setup:
bd_broker_start()
// Then create tasks as needed throughout the session.
// No further broker management needed unless stopping.
```

SYSTEM.md should encode this as a default practice.

---

## 8. SYSTEM.md Changes

### 8.1 Sections to remove or substantially rewrite

| Section | Change |
|---|---|
| "Your Team" paragraph mentioning `delegate` | Remove the `delegate` tool reference |
| "How to Work" — entire section | Rewrite (§8.2) |
| "Workstream State (Beads)" — `bd_broker_start` missing | Add broker startup to required actions |
| "Working Practices" — patterns referencing `delegate` | Update to use beads-first patterns |

### 8.2 Rewritten "How to Work" section

The following replaces the current content:

---

**Break it down first.** Before creating tasks, think through what the work requires and which roles need to be involved. Write your plan in your response so the stakeholder can see your thinking.

**Start the broker.** Call `bd_broker_start` at the start of any session where you will be delegating work. The broker monitors the ready queue and dispatches tasks automatically. You do not manage individual dispatches — you manage the queue.

**Use beads for all delegation.** Every piece of work you assign to a team member is a bead. Create tasks with `bd_task_create`, specifying the `role` so the broker knows who to dispatch to. There is no `delegate` tool. All dispatch goes through beads.

**Include all context in the bead.** The `title` is a brief label. Put the full specification — relevant file paths, acceptance criteria, constraints, links to prior decisions — in the `design` field. Each agent fetches its own task context via `bd show`; the design field is what it reads. Never assume an agent recalls a previous conversation.

**Express sequencing with `bd_dep_add`.** Any time step A must complete before step B, call `bd_dep_add` after creating both tasks. The broker enforces the sequence: B will not be dispatched until A is closed. Use this for: design → implement, implement → QA, any multi-phase chain.

**Fan-in is automatic.** If task D requires B and C to both complete first, add two `bd_dep_add` calls (B blocks D; C blocks D). The broker dispatches D only when both are closed. D's brief is automatically enriched with a summary of B and C's results.

**Results arrive as follow-up messages.** When a task completes, the broker delivers the full agent output as a message — exactly as async `delegate` did before. You will see: the task title, bead ID, role, member name, and the complete verbatim output. Correlate results to workstreams by bead ID.

**QA is still mandatory.** After any implementation task completes, create a `qa-engineer` task and add the implementation task as its blocker. The broker will dispatch QA automatically after implementation closes.

**Always follow implementation with a QA pass.** After any implementation task completes — extension code, configuration, role definitions, or any change that affects runtime behaviour — you must create a QA task (blocked by the implementation task) before considering the work done. The QA engineer decides the scope and depth of their review. What is not optional is creating the task.

**Synthesise and report.** When the final task in a workstream delivers its result, synthesise the chain of results into a coherent summary for the stakeholder. Do not relay raw task outputs verbatim.

**Keep threads separate.** Assign each distinct stakeholder request a short workstream label. Use this label in your epic title and in your synthesis responses. Correlate arriving results by bead ID, not by proximity.

---

### 8.3 Updated "Workstream State (Beads)" — required actions addition

Add broker startup to the **Required actions** list, before "Before the first delegation":

> **Start the broker** (`bd_broker_start`): call this at the beginning of any session where you will be delegating work. The broker runs until session end. You only need to call this once per session. If you restart the session, call it again.

Amend the **When NOT to use beads** section to clarify that there is no lightweight alternative dispatch path:

> Note: there is no `delegate` tool. There is no shorter path than `bd_task_create` + broker. The overhead of creating a bead is negligible; use beads for all delegation, including simple one-off tasks.

### 8.4 Updated "Working Practices" patterns

All pattern descriptions that say "Delegate implementation" or "use `delegate`" should read "Create a task bead (`bd_task_create`) assigned to the appropriate role" instead. The sequencing mechanism changes from `chain` mode to `bd_dep_add`. All other advice (QA mandatory, synthesise results, etc.) is unchanged.

---

### 8.5 Bead title convention: describe the output, not the activity

The title of a bead is the primary navigation signal for downstream agents. When the broker dispatches a task that has upstream blockers, it scans closed bead titles to decide which results are relevant to fetch and surface. A vague activity-oriented title forces agents to fetch every bead speculatively; a descriptive output-oriented title lets them filter precisely.

**Convention:** the title must answer *"what would a downstream agent want to know this bead contains?"*

| ❌ Activity-oriented (vague) | ✅ Output-oriented (good) |
|---|---|
| `Implement auth module` | `Implementation: auth middleware and token endpoints` |
| `QA review` | `QA: auth module — approved, one finding on token expiry` |
| `Research` | `Research: pi framework session lifecycle and shutdown behaviour` |

**Pattern:** `<Type>: <specific thing produced or concluded>`

Where `<Type>` is a short category label appropriate to the role's output — `Implementation`, `Design`, `QA`, `Research`, `Analysis`, `Report`, etc.

This convention must be encoded in the "Include all context in the bead" paragraph in the rewritten "How to Work" section (§8.2). Add the following sentence:

> **Titles must describe the output, not the activity.** Use the pattern `<Type>: <specific thing produced or concluded>` — for example, `"QA: auth module — approved, one finding on token expiry"` rather than `"QA review"`. Downstream agents use titles to scan for relevant completed work; a vague title forces them to fetch everything.

---

### 8.6 Field convention: `description` vs `design`

**`description` is the primary field for the task brief** — what the EM writes at creation time to specify what the agent must do, including relevant file paths, acceptance criteria, and constraints. Agents self-serve context by reading `bd show --json` and consuming the `description` field first.

**`design` is reserved for architectural rationale** when the EM has additional context about *why* the approach was chosen — not required for every task. Agents may reference it for background, but it is not the task specification.

All guidance in this spec (and in SYSTEM.md) that refers to the default field for task briefs should use `description`, not `design`. Concretely:
- `bd_task_create` calls that pass task specifications use the `description` param
- The "Include all context in the bead" paragraph in §8.2 should read: put the full specification in the `description` field
- The broker brief (`bd show` self-serve pattern) reads `description` as the primary input

---

## 9. ADR-008: Retire `delegate`, Make Broker the Sole Dispatch Path

**Status:** Proposed

**Context:**

The pit2 org extension has two dispatch paths:

1. **`delegate` tool** — imperative, synchronous or async. EM calls it directly with a task string. Supports single, parallel, and chain modes. Results are inline (sync) or delivered as follow-ups (async). No persistent state.

2. **Broker** (Integration B) — declarative, queue-based. EM creates beads, broker dispatches automatically. Results delivered as follow-up messages. Persistent state in beads.

The design analysis (ADR-007, 2026-05-01) initially proposed keeping both paths, routing by use-case. The stakeholder has decided to collapse to a single path.

The proximate trigger for this decision is Decision 1 (broker delivers full results): once the broker delivers results in the same form as async `delegate` (full output as follow-up messages), the experience gap between the two paths closes. The EM's interaction model — tasks arrive as follow-ups, EM reasons about them and directs follow-up work — is fully preserved in broker-only mode.

The remaining differentiator for `delegate` was chain mode's `{previous}` substitution (live injection of the full upstream text into the downstream task prompt). This capability is replaced by: (a) upstream context injection in the broker brief (2000-char cap), plus (b) the EM receiving the full upstream result as a follow-up and being able to enrich the downstream bead before dispatch. The cap is a regression for tasks that genuinely need the full upstream text, but it is acceptable because those cases are rare and the EM can compensate manually.

**Decision:**

Remove the `delegate` tool from `index.ts`. All task dispatch goes through beads + broker. The EM's workflow becomes: `bd_workstream_start` → `bd_task_create` (with `role`) × N → `bd_dep_add` × M → `bd_broker_start` → results arrive as follow-ups.

The broker is updated to deliver full result text to the EM via a new `deliverResult` callback (Decision 1).

SYSTEM.md is updated to remove all `delegate` guidance and replace with beads-first workflow.

**Consequences:**

*Positive:*
- Single dispatch path: simpler mental model, no "which path should I use?" decision for the EM
- All delegated work is automatically tracked in beads; the EM cannot bypass tracking even for trivial tasks
- Multi-session workstream continuity is now universal — the broker picks up from beads state across restarts
- `{previous}` was silently dangerous: a very long upstream output injected inline could consume the downstream agent's entire context window. Broker's 2000-char cap is safer
- Code reduction: ~500 lines of `delegate` tool code removed

*Negative:*
- `{previous}` full-text injection is lost. Downstream tasks that genuinely need the complete upstream output inline must use the manual enrichment pattern (EM reads follow-up, updates downstream bead design)
- Every dispatch requires `bd_task_create` — ~50ms CLI call overhead. Negligible in practice
- Chain A→B→C has a dispatch gap: the broker dispatches B immediately after A closes, but the EM may not have had time to read A's result and enrich B before B starts. The design field must be pre-populated at planning time for critical downstream context
- The EM can no longer dispatch a task synchronously (blocking until result returns). All broker results are async follow-ups. This changes how the EM handles result-dependent reasoning within a single EM turn — it must wait for the follow-up, which means writing out a plan first

*Neutral:*
- Broker is already opt-in and stable (Integration B implemented). This ADR makes it the only path, not a new dependency
- `resolveOrScale`, `runTask`, `runTaskWithStreaming` all remain; only the `delegate` tool wrapper around them is removed

---

## 10. File Change Summary

| File | Change | Description |
|---|---|---|
| `.pi/extensions/org/broker.ts` | Modify | Add `deliverResult`, `scheduleDoneReset`, `accumulateMemberUsage` callbacks to `configure()` and private fields; update `_runAndClose` section 4 to call `deliverResult` and `scheduleDoneReset` after successful capture; update `RunResult` local type to include `usage` |
| `.pi/extensions/org/index.ts` | Modify | Remove `delegate` tool, `DelegateParams`, `AssigneeFields`, `asyncMode`, `/async` command, `deliverResult` function; update `broker.configure()` call with new callbacks; update `buildWidgetLines` header |
| `.pi/SYSTEM.md` | Modify | Rewrite "How to Work" section; add broker startup to required beads actions; remove all `delegate` references; update working practices patterns |

**Not changing:**
- `broker.ts` dispatch loop (`_dispatchCycle`, `captureResult`, `buildUpstreamContext`, failure recovery) — all unchanged
- Any agent `.md` files — unchanged by this spec (§15 bash-access requirement from design-beads-integration-b.md is a separate prerequisite)
- Integration A tools (all beads tools) — unchanged
- Team management tools and commands — unchanged

---

## 11. Implementation Order

The changes have no hard sequencing requirements, but this order minimises intermediate broken states:

1. **`broker.ts`** — add callbacks to `configure()` and private fields first; update `_runAndClose` section 4. Broker is currently not wired with the new callbacks; the type error will prevent compilation until step 2 is also done, so these should be done in the same commit.
2. **`index.ts`** — update `broker.configure()` call to pass new callbacks; remove `delegate` tool and dead code; update widget header. Same commit as step 1.
3. **`SYSTEM.md`** — update independently; no code dependencies. Can be a separate commit.

The whole change is small enough to land in two commits: (1) code + broker wiring, (2) SYSTEM.md.

## Appendix: Additional Design Decisions

### Bead title convention
Titles must describe the **output**, not the activity. Downstream agents scan completed epic tasks by title to decide which beads to fetch — a vague title forces unnecessary `bd show` calls.

- Bad: `"Implement auth module"`, `"QA review"`, `"Research"`
- Good: `"Implementation: auth middleware and token endpoints"`, `"QA: auth module — approved, one finding on token expiry"`, `"Research: pi framework session shutdown behaviour"`

The title should answer: *what would a downstream agent want to know this bead contains?*

### Primary task brief field: `description`
`description` is the default field for task briefs — what the EM writes at creation time for the agent to read. `design` is reserved for architectural rationale when explicitly needed. All broker dispatch and SYSTEM.md guidance should reference `description` as the primary field.

### Notes length safety in broker
`--append-notes` has no application-level pre-flight length check — the 64KB ceiling is enforced silently by Dolt with a raw SQL error. `captureResult` must fetch current notes length via `bd show` before appending and switch to the file-reference branch if `existingNotes.length + output.length > 50_000`. Capture errors must be surfaced via `notifyEM` rather than silently swallowed.
