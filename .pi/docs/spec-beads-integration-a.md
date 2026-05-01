# Spec: Beads Integration A — EM-Only Workstream Persistence

**Status:** Ready for implementation  
**Authors:** Alex Rivera (architect)  
**Implementors:** TypeScript engineer (extension changes), Prompt engineer (SYSTEM.md changes)  
**Depends on:** beads CLI (`bd`) v0.60.0 globally installed; `gastownhall/beads` repo  

---

## 1. Scope

Integration A adds workstream state persistence to the Engineering Manager (EM) only. Subagents are not involved and receive no new capabilities. The EM uses `bd` (beads CLI) as a durable coordination log: it records epics, tasks, dependencies, and findings. This state survives context compaction and allows the EM to reconstruct where it was after a long session.

**In scope:**
- Beads initialisation at session start
- Seven thin bd wrapper tools registered in the org extension
- EM system prompt guidance on when and how to use beads
- Dependency encoding for chain and parallel-merge patterns

**Out of scope for this integration:**
- Server mode / multi-writer (`bd init --server`)
- Subagent bd access
- `bd gate` (async approval gates)
- Agent-type beads (`--type=agent`)
- Wisps (`bd mol wisp`) — ephemeral orchestration not needed at this tier
- Beads triggering delegation (the EM still drives all delegation via the `delegate` tool)

---

## 2. Beads Initialisation

### 2.1 Location

The `.beads/` directory lives at `<project-root>/.beads`, where `<project-root>` is `ctx.cwd` (the same directory that contains `.pi/`). This co-locates all project coordination metadata.

Beads is initialised in **stealth mode** (no git hooks, no external server):

```bash
BEADS_DIR=<ctx.cwd>/.beads bd init --stealth
```

In TypeScript this means passing `BEADS_DIR` via the `env` option of the child process; see §3.2.

### 2.2 When initialisation runs

Initialisation is a **one-time check per working directory**, triggered from the `session_start` handler in `index.ts`. The check is:

1. If `<ctx.cwd>/.beads` directory already exists → beads is assumed initialised; skip `bd init`.
2. If it does not exist → run `bd init --stealth`.
3. If the `bd` binary is not found or init fails → log a warning to the UI and mark beads as unavailable for this session. All bd tools then return an error message rather than throwing. Do **not** block the session; beads is additive.

### 2.3 Persistence across sessions

The `.beads/` directory is a file-backed store that persists indefinitely. No cleanup is required. `ensureBeadsInit` (see §3.3) tracks per-session whether init was attempted, using a module-level `Map<string, boolean>` keyed by `cwd`.

### 2.4 `.gitignore` treatment

Add `.beads/` to the project root's `.gitignore`. This is local coordination state only and must not be committed to git. See §9.1 (resolved).

---

## 3. Extension Changes (`index.ts`)

All changes are in `.pi/extensions/org/index.ts`. No other extension files are modified.

### 3.1 New imports

Add to the existing `node:child_process` import and add `promisify`:

```typescript
// Change:
import { type ChildProcess } from "node:child_process";
// To:
import { type ChildProcess, execFile as execFileCb } from "node:child_process";

// Add alongside existing imports:
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
```

### 3.2 `runBd` helper

Add this function in the module scope, after the existing `// ─── Subagent persistent clients ───` block and before `export default function`:

```typescript
// ─── Beads helpers ───────────────────────────────────────────────────────────

/**
 * Run a bd command with BEADS_DIR set to <cwd>/.beads.
 * Returns { stdout, stderr } on success.
 * Throws on non-zero exit code (the error object carries .stdout and .stderr).
 */
async function runBd(
    cwd: string,
    args: string[],
): Promise<{ stdout: string; stderr: string }> {
    const beadsDir = path.join(cwd, ".beads");
    return execFile("bd", args, {
        cwd,
        env: { ...process.env, BEADS_DIR: beadsDir },
        timeout: 15_000, // 15 s — bd commands are always fast; treat timeout as an error
    });
}
```

### 3.3 `ensureBeadsInit` helper

Add immediately after `runBd`, still in the module scope:

```typescript
/**
 * Module-level beads readiness registry.
 * true  = bd is available and .beads/ has been initialised for this cwd.
 * false = bd is unavailable or init failed; tools will surface a friendly error.
 */
const beadsReady = new Map<string, boolean>();

/**
 * Idempotent initialisation. Safe to call on every session_start.
 * On success sets beadsReady(cwd) = true.
 * On failure sets beadsReady(cwd) = false and calls notifyFn with a warning.
 */
async function ensureBeadsInit(
    cwd: string,
    notifyFn: (msg: string, level: "info" | "warn" | "error") => void,
): Promise<void> {
    if (beadsReady.has(cwd)) return; // already attempted this session

    const beadsDir = path.join(cwd, ".beads");

    // .beads/ already exists → assume initialised, no need to re-init
    if (fs.existsSync(beadsDir)) {
        beadsReady.set(cwd, true);
        return;
    }

    try {
        await runBd(cwd, ["init", "--stealth"]);
        beadsReady.set(cwd, true);
    } catch (err: any) {
        const msg =
            `Beads init failed (is bd installed and on PATH?): ${err?.message ?? err}. ` +
            `Workstream tracking will be unavailable this session.`;
        notifyFn(msg, "warn");
        beadsReady.set(cwd, false);
    }
}
```

### 3.4 `session_start` handler change

In the existing `pi.on("session_start", ...)` handler, add a call to `ensureBeadsInit` **after** the roster notification and widget update:

```typescript
// Existing at end of session_start handler:
//   updateWidget(ctx);
//   // Watch roster.json ...
//   // Start idle reaper ...

// ADD after updateWidget(ctx):
await ensureBeadsInit(ctx.cwd, (msg, level) => ctx.ui.notify(msg, level));
```

The placement matters: beads init runs only once, after the team roster is displayed, so any beads warning doesn't interrupt the welcome output.

### 3.5 `beadsGuard` utility (inline helper)

Add this tiny inline factory function inside the `export default function(pi: ExtensionAPI)` body, before the tool registrations, so all tool `execute` functions can share it:

```typescript
/** Returns an error result if beads is not available for ctx.cwd. */
function beadsGuard(cwd: string): { content: [{ type: "text"; text: string }]; details: {}; isError: true } | null {
    if (beadsReady.get(cwd) !== true) {
        return {
            content: [{ type: "text", text: "Beads is not available (bd not installed or init failed). Workstream tracking is disabled." }],
            details: {},
            isError: true,
        };
    }
    return null;
}
```

### 3.6 Tool registrations

Register the following seven tools inside `export default function(pi: ExtensionAPI)`, after the existing `fire` tool registration and before the `delegate` tool registration. All seven follow the same shape as existing tools in the file.

---

#### Tool 1: `bd_workstream_start`

Creates an epic to represent a new workstream.

```typescript
pi.registerTool({
    name: "bd_workstream_start",
    label: "Workstream Start",
    description:
        "Create a beads epic to represent a new workstream. Call this when initiating any multi-step or multi-session effort. Returns the epic ID, which you must record for attaching tasks.",
    promptSnippet: "Start a tracked workstream",
    parameters: Type.Object({
        title: Type.String({
            description: "Short, unique workstream title. Should match the workstream label you use in your delegation notes (e.g. 'auth-refactor', 'onboarding-docs').",
        }),
        design: Type.Optional(Type.String({
            description: "Rationale for why this workstream is being started; the decision or requirement that prompted it.",
        })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const guard = beadsGuard(ctx.cwd);
        if (guard) return guard;

        const args = ["create", params.title, "--type=epic", "--json"];
        if (params.design) args.push(`--design=${params.design}`);

        try {
            const { stdout } = await runBd(ctx.cwd, args);
            const result = JSON.parse(stdout) as { id: string; title: string; [k: string]: unknown };
            if (!result?.id) throw new Error(`bd create returned unexpected shape: ${stdout}`);
            return {
                content: [{ type: "text", text: `Epic created. ID: ${result.id} — "${result.title}"` }],
                details: { id: result.id, title: result.title },
            };
        } catch (err: any) {
            throw new Error(`bd_workstream_start failed: ${err?.stderr ?? err?.message ?? err}`);
        }
    },
});
```

---

#### Tool 2: `bd_task_create`

Creates a task bead, optionally attached to an epic.

```typescript
pi.registerTool({
    name: "bd_task_create",
    label: "Task Create",
    description:
        "Create a beads task to represent a unit of delegated work. Attach it to an epic with epic_id if this task is part of a tracked workstream. Returns the task ID.",
    promptSnippet: "Create a tracked task bead",
    parameters: Type.Object({
        title: Type.String({
            description: "Brief description of the task being delegated.",
        }),
        epic_id: Type.Optional(Type.String({
            description: "ID of the parent epic (from bd_workstream_start). Omit only if this is a standalone task with no workstream.",
        })),
        design: Type.Optional(Type.String({
            description: "Rationale for this task — why it is needed, what decision it implements.",
        })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const guard = beadsGuard(ctx.cwd);
        if (guard) return guard;

        const args = ["create", params.title, "--type=task", "--json"];
        if (params.epic_id) args.push(`--parent=${params.epic_id}`);
        if (params.design) args.push(`--design=${params.design}`);

        try {
            const { stdout } = await runBd(ctx.cwd, args);
            const result = JSON.parse(stdout) as { id: string; title: string; [k: string]: unknown };
            if (!result?.id) throw new Error(`bd create returned unexpected shape: ${stdout}`);
            return {
                content: [{ type: "text", text: `Task created. ID: ${result.id} — "${result.title}"` }],
                details: { id: result.id, title: result.title },
            };
        } catch (err: any) {
            throw new Error(`bd_task_create failed: ${err?.stderr ?? err?.message ?? err}`);
        }
    },
});
```

---

#### Tool 3: `bd_task_update`

Updates a task's status and/or records findings. Used to close tasks and record findings on completion.

```typescript
pi.registerTool({
    name: "bd_task_update",
    label: "Task Update",
    description:
        "Update a beads task. Typically called after a delegation completes to close it (status: 'closed') and record key findings. Also use to mark a task in_progress when delegation starts. When status is 'closed', internally uses bd close which sets closed_at correctly.",
    promptSnippet: "Update a beads task status or notes",
    parameters: Type.Object({
        id: Type.String({
            description: "The beads task or epic ID to update.",
        }),
        status: Type.Optional(Type.Union(
            [
                Type.Literal("open"),
                Type.Literal("in_progress"),
                Type.Literal("blocked"),
                Type.Literal("deferred"),
                Type.Literal("closed"),
            ],
            { description: "New status for the issue. Use 'closed' to mark completion (routes to bd close internally)." },
        )),
        notes: Type.Optional(Type.String({
            description: "Key findings or output summary from the completed task. Concise — this is the persistent record.",
        })),
        design: Type.Optional(Type.String({
            description: "Update the design/rationale field (use if the approach changed during execution).",
        })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const guard = beadsGuard(ctx.cwd);
        if (guard) return guard;

        try {
            let result: { id: string; status: string; [k: string]: unknown };
            if (params.status === "closed") {
                // Use bd close to set closed_at correctly; notes passed as --reason
                const closeArgs = ["close", params.id, "--json"];
                if (params.notes) closeArgs.push(`--reason=${params.notes}`);
                const { stdout } = await runBd(ctx.cwd, closeArgs);
                result = (JSON.parse(stdout) as Array<{ id: string; status: string; [k: string]: unknown }>)[0];
            } else {
                const args = ["update", params.id, "--json"];
                if (params.status) args.push(`--status=${params.status}`);
                if (params.notes) args.push(`--append-notes=${params.notes}`);
                if (params.design) args.push(`--design=${params.design}`);
                const { stdout } = await runBd(ctx.cwd, args);
                result = (JSON.parse(stdout) as Array<{ id: string; status: string; [k: string]: unknown }>)[0];
            }
            return {
                content: [{ type: "text", text: `Updated ${result.id}: status=${result.status}` }],
                details: result,
            };
        } catch (err: any) {
            throw new Error(`bd_task_update failed: ${err?.stderr ?? err?.message ?? err}`);
        }
    },
});
```

---

#### Tool 4: `bd_dep_add`

Adds a `blocks` dependency between two tasks. This is the only dependency type that affects `bd_ready` output.

```typescript
pi.registerTool({
    name: "bd_dep_add",
    label: "Dep Add",
    description:
        "Record that one task blocks another (i.e. blocked_id cannot start until blocker_id is done). Use this to encode chain step ordering and parallel-merge gates.",
    promptSnippet: "Add a blocks dependency between tasks",
    parameters: Type.Object({
        blocker_id: Type.String({
            description: "ID of the task that must complete first.",
        }),
        blocked_id: Type.String({
            description: "ID of the task that cannot start until blocker_id is done.",
        }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const guard = beadsGuard(ctx.cwd);
        if (guard) return guard;

        try {
            await runBd(ctx.cwd, ["dep", "add", params.blocked_id, params.blocker_id, "--type=blocks"]);
            return {
                content: [{ type: "text", text: `Dependency added: ${params.blocker_id} blocks ${params.blocked_id}` }],
                details: { blocker: params.blocker_id, blocked: params.blocked_id },
            };
        } catch (err: any) {
            throw new Error(`bd_dep_add failed: ${err?.stderr ?? err?.message ?? err}`);
        }
    },
});
```

---

#### Tool 5: `bd_list`

Lists tracked issues. Primary use case: state reconstruction after compaction.

```typescript
pi.registerTool({
    name: "bd_list",
    label: "List",
    description:
        "List beads issues. Use to reconstruct workstream state after context compaction. By default returns only open/in_progress issues to reduce noise.",
    promptSnippet: "List beads workstream state",
    parameters: Type.Object({
        type: Type.Optional(Type.Union(
            [Type.Literal("epic"), Type.Literal("task")],
            { description: "Filter by issue type. Omit to return all." },
        )),
        status: Type.Optional(Type.String({
            description: "Filter by status (e.g. 'open', 'in_progress', 'closed'). Valid values: open, in_progress, blocked, deferred, closed. Defaults to 'open,in_progress' if not specified.",
        })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const guard = beadsGuard(ctx.cwd);
        if (guard) return guard;

        const args = ["list", "--json"];
        if (params.type) args.push(`--type=${params.type}`);
        // Default to open issues to prevent returning large completed history
        args.push(`--status=${params.status ?? "open,in_progress"}`);

        try {
            const { stdout } = await runBd(ctx.cwd, args);
            const items = JSON.parse(stdout) as unknown[];
            return {
                content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
                details: { count: items.length, items },
            };
        } catch (err: any) {
            throw new Error(`bd_list failed: ${err?.stderr ?? err?.message ?? err}`);
        }
    },
});
```

---

#### Tool 6: `bd_show`

Shows a single issue in full detail.

```typescript
pi.registerTool({
    name: "bd_show",
    label: "Show",
    description:
        "Show full details of a single beads issue, including its design rationale, notes, dependencies, and status. Use when you need to recall the specifics of one workstream or task.",
    promptSnippet: "Show a single beads issue",
    parameters: Type.Object({
        id: Type.String({
            description: "The beads issue ID to retrieve.",
        }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const guard = beadsGuard(ctx.cwd);
        if (guard) return guard;

        try {
            const { stdout } = await runBd(ctx.cwd, ["show", params.id, "--json"]);
            const item = (JSON.parse(stdout) as Array<Record<string, unknown>>)[0];
            return {
                content: [{ type: "text", text: JSON.stringify(item, null, 2) }],
                details: item,
            };
        } catch (err: any) {
            throw new Error(`bd_show failed: ${err?.stderr ?? err?.message ?? err}`);
        }
    },
});
```

---

#### Tool 7: `bd_ready`

Returns the ready front — tasks with no unresolved `blocks` dependencies.

```typescript
pi.registerTool({
    name: "bd_ready",
    label: "Ready",
    description:
        "Return the set of tasks that have no unresolved blocking dependencies — i.e. tasks whose prerequisite work is done and that are safe to start. Use to identify what to delegate next in a multi-step workstream.",
    promptSnippet: "Get the beads ready front",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const guard = beadsGuard(ctx.cwd);
        if (guard) return guard;

        try {
            const { stdout } = await runBd(ctx.cwd, ["ready", "--json"]);
            const items = JSON.parse(stdout) as unknown[];
            return {
                content: [{ type: "text", text: items.length === 0 ? "No tasks in ready state." : JSON.stringify(items, null, 2) }],
                details: { count: items.length, items },
            };
        } catch (err: any) {
            throw new Error(`bd_ready failed: ${err?.stderr ?? err?.message ?? err}`);
        }
    },
});
```

---

### 3.7 Tool registration placement in `index.ts`

Insert all seven tool registrations (§3.6) as a block between the existing `fire` tool (`pi.registerTool({ name: "fire", ...})`) and the `delegate` tool (`pi.registerTool({ name: "delegate", ...})`). A section comment should precede them:

```typescript
// ── beads workstream tools ──────────────────────────────────────────────────
```

---

## 4. Workstream Lifecycle

### 4.1 When to create an epic

Create an epic (`bd_workstream_start`) when **all three** of the following are true:

1. You are initiating a new workstream (you would otherwise assign it a `[label]` for async correlation).
2. The workstream involves **two or more delegations**, or is expected to run across multiple rounds of conversation.
3. The outcome matters beyond this session (something another session might need to query).

Single-delegation tasks — a quick research question, a one-liner config change — do not warrant an epic.

**Timing**: Create the epic **before** any delegation for that workstream. The epic ID is needed to attach task beads; it must exist first.

**Title**: The epic title should match (or closely match) the workstream label you use in delegation notes. E.g., if the label is `[auth-refactor]`, the epic title should be `auth-refactor`.

### 4.2 When to create a task bead

Create a task bead (`bd_task_create`) for each discrete delegation within a tracked workstream (one with an epic). The task bead represents the unit of work delegated to one team member.

**Do not** create a task bead for:
- Delegations that are not part of any epic
- Informational or clarifying sub-prompts that don't produce a tracked artefact
- Auto-scaled parallel tasks that are homogeneous repetitions of each other (tracking one representative task is enough)

### 4.3 Full lifecycle sequence

For a typical three-step workstream (implement → QA → docs):

```
1. bd_workstream_start("auth-refactor", design="Required for OAuth2 compliance")
   → epic_id = "epic-001"

2. bd_task_create("Implement OAuth2 flow", epic_id="epic-001", design="...")
   → task_id_1 = "task-001"

3. bd_task_create("QA: OAuth2 flow", epic_id="epic-001")
   → task_id_2 = "task-002"

4. bd_task_create("Docs: update auth guide", epic_id="epic-001")
   → task_id_3 = "task-003"

5. bd_dep_add(blocker_id="task-001", blocked_id="task-002")   // impl blocks QA
6. bd_dep_add(blocker_id="task-002", blocked_id="task-003")   // QA blocks docs

7. delegate({ chain: [
     { role: "typescript-engineer", task: "Implement OAuth2 flow..." },
     { role: "qa-engineer",         task: "QA: OAuth2 flow..." },
     { role: "documentation-steward", task: "Update auth guide..." },
   ]})

8. [impl completes]
   bd_task_update("task-001", status="closed", notes="<key findings from impl>")

9. [QA completes]
   bd_task_update("task-002", status="closed", notes="<QA sign-off summary>")

10. [docs completes]
    bd_task_update("task-003", status="closed", notes="<doc changes made>")

11. bd_task_update("epic-001", status="closed", notes="Auth refactor complete. PRs: ...")
```

Notes for the TypeScript engineer: steps 2–6 (task creation and dep wiring) happen synchronously before the `delegate` call; steps 8–11 happen as each chain step's result arrives.

### 4.4 Updating on completion

After each chain step returns (and after async results arrive), call `bd_task_update` with:
- `status: "closed"` (via `bd close`, see §3.6 Tool 3) or `"blocked"` / `"deferred"` if appropriate
- `notes`: a concise synthesis of key findings — **not** verbatim output from the subagent. One to five sentences. This is the persistent record.

### 4.5 The `design` field

Use `design` at creation time for the **rationale** — why this work is being done, what decision prompted it, any key constraints. This is future reference for yourself or a successor EM session, not a task brief.

---

## 5. Dependency Encoding

### 5.1 Chain (sequential) steps

A `chain` delegation of N steps maps to N−1 `blocks` relationships wired left-to-right:

| Step | Task ID | Blocks |
|------|---------|--------|
| 1: implement | task-001 | task-002 |
| 2: QA | task-002 | task-003 |
| 3: docs | task-003 | — |

Create all task beads first, then add the dependencies. This is cleaner than interleaving creates and dep_adds.

```
bd_task_create("implement X")   → task-001
bd_task_create("QA: X")         → task-002
bd_task_create("docs: X")       → task-003
bd_dep_add(task-001, task-002)
bd_dep_add(task-002, task-003)
```

### 5.2 Parallel-then-merge

Two parallel tasks (A, B) feeding a merge task (C):

```
bd_task_create("Task A")   → task-A
bd_task_create("Task B")   → task-B
bd_task_create("Merge C")  → task-C
bd_dep_add(task-A, task-C)
bd_dep_add(task-B, task-C)
```

`bd_ready` will show C only after both A and B are marked `done`.

No dependency is needed between A and B themselves; they can run in parallel via `delegate({ tasks: [...] })` as normal.

### 5.3 Fan-out (parallel with no merge)

Three parallel independent tasks with no merge step: create each task, attach to the epic, add **no** inter-task dependencies. They all appear on `bd_ready` immediately.

### 5.4 Dependency type

Always use `--type=blocks` for the `bd dep add` command. This is the only dep type that affects `bd_ready` output. Other types (`related`, `parent-child`, `discovered-from`) are informational only and do not affect scheduling.

---

## 6. SYSTEM.md Updates

**File:** `/Users/richardthombs/dev/pit2/.pi/SYSTEM.md`

### 6.1 New section to add

Insert the following section into `SYSTEM.md` **after** the "How to Work" section (ending with the paragraph beginning "Keep threads separate...") and **before** the "Working Practices" section. This is a top-level section at the same heading level as "How to Work".

---

```markdown
## Workstream State (Beads)

You have access to a persistent workstream tracker — beads — through seven tools: `bd_workstream_start`, `bd_task_create`, `bd_task_update`, `bd_dep_add`, `bd_list`, `bd_show`, and `bd_ready`. Use these to externalise coordination state that would otherwise live only in your conversation context.

### When to use beads

**Create an epic** (`bd_workstream_start`) when you assign a workstream label to a multi-step effort. The epic title should match the label. Do this before the first delegation in that workstream.

**Create a task bead** (`bd_task_create`) for each tracked delegation within an epic. Attach it to the epic using `epic_id`. Create all task beads for a workstream at the same time you plan the delegations — not one by one as each step completes.

**Record dependencies** (`bd_dep_add`) to encode ordering: if step A must complete before step B, add `A blocks B`. This is the beads equivalent of a `chain` — and it makes the dependency explicit in a form that survives compaction. Wire dependencies immediately after creating the task beads.

**Update on completion** (`bd_task_update`): after each delegation returns, close the task (`status: "closed"`) and record concise findings in `notes`. Do not paste raw subagent output; synthesise it. Two to five sentences is enough.

**Reconstruct state after compaction** (`bd_list`, `bd_show`, `bd_ready`): if you lose thread of a workstream, start with `bd_list` to find open epics and tasks, then `bd_show` on the relevant epic for full context. Use `bd_ready` to find which tasks have no unresolved blockers — i.e., what you should delegate next.

### When not to use beads

Do not create beads for:
- Single-delegation tasks with no follow-on (one-shot research, one file fix)
- Work that obviously completes in this session and will not be queried in a future one
- Sub-steps internal to a subagent's own work (beads is for EM coordination state, not subagent implementation steps)

### Design vs Notes

- `design` field: captured at creation time. Records **why** — the rationale, the decision, the constraint. Useful for a future EM session that needs to understand what was attempted.
- `notes` field: captured on update. Records **what happened** — key findings, artefacts produced, test results, caveats. Write this for future-you after compaction.
```

---

### 6.2 Where exactly to insert

Find the paragraph in SYSTEM.md that begins:

> **Keep threads separate.** Each distinct stakeholder request...

The new section should be inserted on the blank line **after** the paragraph beginning:

> **Correlate async results by label, not by proximity or identity.** When a background task delivers its result...

(i.e., after the last "How to Work" paragraph and before the `## Working Practices` heading).

### 6.3 No other SYSTEM.md changes required

The workstream label convention (`[auth-refactor]`), async result correlation, and delegation instructions are all unchanged. Beads is additive; the existing guidance remains intact.

---

## 7. What Does NOT Change

The following are explicitly untouched by Integration A:

| Artefact | Status |
|----------|--------|
| `delegate` tool schema and behaviour | **Unchanged** |
| All role definitions (`.pi/agents/*.md`) | **Unchanged** |
| Subagent spawning, RpcClient lifecycle, `runTask` | **Unchanged** |
| Member memory files (`.pi/memory/<id>.md`) | **Unchanged** |
| Roster (`roster.json`) | **Unchanged** |
| The `hire`, `fire` tools and commands | **Unchanged** |
| The `async`, `chain`, `tasks` delegation modes | **Unchanged** |
| `/team`, `/roles`, `/hire`, `/fire`, `/async` commands | **Unchanged** |
| Subagent context window contents | **Unchanged** — subagents never see bd tools or beads data |
| Widget rendering | **Unchanged** |

Subagents do not receive `bd` tool access. They remain stateless relative to beads. The EM is the sole writer.

---

## 8. Granularity Guidance

This section expands on when a delegation warrants a bead. Apply the following two-part test (adapted from the beads BOUNDARIES.md):

**Part 1 — Multi-session relevance**: Will future-you (in a new or compacted session) need to know that this task happened, what it found, or that it's complete? If yes → bead it.

**Part 2 — Dependency tracking**: Does this task's completion gate another task you're tracking? If yes → bead it.

If neither condition applies → skip the bead.

### Concrete examples

| Scenario | Bead? | Reason |
|----------|-------|--------|
| Implement + QA + docs for a feature | ✅ Epic + 3 tasks | Multi-step, dependencies, multi-session |
| "Can you check if the auth module has tests?" (research) | ❌ No bead | Single delegation, result used immediately |
| Architecture review for ADR-005 | ✅ Task under epic | Outcome (ADR) is a durable artefact; future sessions will reference it |
| Re-running a QA pass after a quick fix | ❌ No bead | One-shot, completes this session |
| A five-sprint roadmap implementation | ✅ Epic per sprint, tasks per delegation | Long-running, compaction certain |
| Auto-scaled parallel tasks (10× typescript-engineer) | ✅ One task bead per delegation, or one representative | Each has a distinct outcome to track |
| Asking a member to "take a quick look at X" | ❌ No bead | Informal, single-round |

### Epic vs task granularity

- **Epic** = a workstream (the `[label]` level). One per stakeholder request that spans multiple delegations.
- **Task** = a single delegation. One per `delegate` call (or per step in a `chain`).
- Do not create epics for individual delegations, or tasks for sub-steps within a single subagent's work.

---

## 9. Decision Points

The following items require a decision before or during implementation. Each has a recommended choice; implementors should confirm with the EM or architect before deviating.

### 9.1 `.gitignore` treatment of `.beads/`

**Issue:** Should `.beads/` be committed to git? Integration A is local coordination state; it is not shared across machines or team members.

**Recommendation:** Add `.beads/` to the project's `.gitignore` (or `.pi/.gitignore` if the project uses a nested ignore). This keeps the git history clean. If cross-session sharing ever becomes a requirement, that is a Server mode decision (Integration B or C).

**Implementation note:** The TypeScript engineer should add `.beads/` to `.gitignore` as part of this PR. Verify whether `.gitignore` already exists at `<project-root>/.gitignore`.

**Resolution (2026-05-01):** Confirmed by Mercer Lin. Add `.beads/` to `.gitignore`. Verified that this is local coordination state only.

---

### 9.2 Exact bd CLI flag syntax

**Issue:** This spec documents the bd command flags as understood from Mercer Lin's research and the task description. The exact flag names — particularly for `bd create` (`--type`, `--parent`, `--design`, `--notes`) and `bd update` — must be verified against the installed version of bd before implementation.

**Recommendation:** Before writing the tool `execute` functions, run:
```bash
bd create --help
bd update --help
bd dep add --help
```
and reconcile any flag name differences with the spec. The canonical reference is the beads SKILL.md at `claude-plugin/skills/beads/SKILL.md` in the `gastownhall/beads` repo (commit `8694c53589f1`).

If `--design` or `--notes` are not valid flags for `bd create`, they may need to be set via `bd update` after creation, or the tool schemas will need adjustment. **Do not guess — check the help output first.**

**Resolution (2026-05-01):** All flags verified against live bd binary by Mercer Lin. `--type`, `--parent`, `--design`, `--notes`, and `--append-notes` are all valid flags. No changes to tool schemas required.

---

### 9.3 `bd create` JSON response shape

**Issue:** The tool implementations in §3.6 assume `bd create --json` returns an object with an `id` field. If the actual JSON schema differs (e.g., the field is named `issue_id` or nested under a `data` key), the parsing code will silently return `undefined`.

**Recommendation:** Verify the shape of `bd create --json` output before writing the parse code. Add a defensive check:
```typescript
if (!result?.id) throw new Error(`bd create returned unexpected JSON: ${stdout}`);
```

**Resolution (2026-05-01):** Confirmed by Mercer Lin — `bd create --json` returns a single bare object with `id` at top level (not an array, not nested). Defensive check added to both `bd_workstream_start` and `bd_task_create` in §3.6.

---

### 9.4 `bd` binary availability at session start

**Issue:** `ensureBeadsInit` calls `bd init --stealth` which requires `bd` to be on PATH. If it is not installed, the session emits a warning and beads is disabled for that session. The EM then has beads tools registered but they all return an error message.

**Recommendation:** This is acceptable. The warning is surfaced at session start, and the EM can proceed without beads. However, consider whether the tools should be conditionally registered (only if beads is available) or always registered with a guard. **Recommendation: always register with guard** (as specified in §3.5) — this keeps the tool list stable and the guard error is informative.

**No action required** unless the team wants to suppress the tools entirely when bd is unavailable. That would require a more complex conditional registration pattern and is out of scope for Integration A.

**Resolution (2026-05-01):** Confirmed by Mercer Lin. Always register with guard. No implementation change required.

---

### 9.5 `bd list --status=open` default filter

**Issue:** The `bd_list` tool defaults to `--status=open` to avoid returning the full history. This may exclude `in_progress` tasks from the default view, which would be unhelpful during state reconstruction.

**Recommendation:** Change the default to either `--status=open,in_progress` (if bd supports comma-separated status filters) or emit two calls in sequence. Verify what `bd list --help` says about status filtering. If a combined filter is not supported, the simplest fix is to remove the default filter entirely and let `bd list` return all non-archived issues (whatever the bd default is). Add an explicit `status` param in the tool for the EM to use when it wants to filter.

**Resolution (2026-05-01):** Confirmed by Mercer Lin. Comma-separated syntax `--status=open,in_progress` works correctly. Repeating the flag (`--status open --status in_progress`) returns an empty array — do not use. Default in `bd_list` tool updated to `"open,in_progress"`.

---

### 9.6 `bd update` flag for `--notes` vs `--append-notes`

**Issue:** If `bd update` offers an `--append-notes` flag (appending to existing notes rather than replacing them), the `bd_task_update` tool should prefer `--append-notes` for iterative updates (e.g., adding findings mid-chain without losing earlier notes).

**Recommendation:** Check `bd update --help`. If `--append-notes` exists, use it in `bd_task_update` as the default note-writing behaviour. If not, `--notes` (replace) is fine for Integration A since notes are typically written once on completion.

**Resolution (2026-05-01):** Confirmed by Mercer Lin. `--append-notes` exists and appends with a newline separator. Updated `bd_task_update` in §3.6 to use `--append-notes` as default. `bd close --reason` is used instead when status is `"closed"`.

---

## 10. File Change Summary

| File | Change type | Description |
|------|-------------|-------------|
| `.pi/extensions/org/index.ts` | Modify | Add import (`execFileCb`, `promisify`); add `runBd`, `ensureBeadsInit`, `beadsReady` in module scope; call `ensureBeadsInit` in `session_start`; add `beadsGuard` inside export fn; register 7 bd tools |
| `.pi/SYSTEM.md` | Modify | Insert new "Workstream State (Beads)" section after "How to Work", before "Working Practices" |
| `.gitignore` (project root) | Modify (or create) | Add `.beads/` entry |

No other files change. Role definitions, roster.json, member memory files, and all other extension files are untouched.

---

## Appendix A: Indicative `index.ts` diff shape

For the TypeScript engineer's orientation — the rough shape of changes to `index.ts`:

```
// ─── Imports (top of file) ────────────────────────────────────────────────
+ import { type ChildProcess, execFile as execFileCb } from "node:child_process";
+ import { promisify } from "node:util";
+ const execFile = promisify(execFileCb);

// ─── Module scope (after existing helpers, before export default) ─────────
+ // ─── Beads helpers ────────────────────────────────────────────────────────
+ const beadsReady = new Map<string, boolean>();
+ async function runBd(cwd, args): Promise<{ stdout, stderr }>  { ... }
+ async function ensureBeadsInit(cwd, notifyFn): Promise<void>  { ... }

// ─── export default function (pi) ─────────────────────────────────────────
  // [existing code]
  // [hire tool]
  // [fire tool]

+ // ── beads workstream tools ──────────────────────────────────────────────
+ pi.registerTool({ name: "bd_workstream_start", ... });
+ pi.registerTool({ name: "bd_task_create",      ... });
+ pi.registerTool({ name: "bd_task_update",      ... });
+ pi.registerTool({ name: "bd_dep_add",          ... });
+ pi.registerTool({ name: "bd_list",             ... });
+ pi.registerTool({ name: "bd_show",             ... });
+ pi.registerTool({ name: "bd_ready",            ... });

  // [delegate tool — unchanged]

  // ─── session_start handler ─────────────────────────────────────────────
  pi.on("session_start", async (event, ctx) => {
    // [existing code — roster notify, updateWidget, rosterWatcher, reaper]
+   await ensureBeadsInit(ctx.cwd, (msg, level) => ctx.ui.notify(msg, level));
  });
```

---

## Appendix B: SYSTEM.md insertion point (exact anchor)

The new section should be inserted between these two existing paragraphs:

**End of "How to Work" (last paragraph):**
> `**Correlate async results by label, not by proximity or identity.** When a background task delivers...`

**Start of "Working Practices":**
> `## Working Practices`

Insert the full "## Workstream State (Beads)" block (§6.1) between these two, with a blank line on each side.
