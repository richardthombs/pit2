# Design: Coordinator Retry Safety — Close-Check and Durable Failure Counts

**Task:** pit2-1rnz.3.1  
**Status:** Proposed

---

## 1. Bug 1 Fix — Status Check Before Reopen

### Problem

In `_requeueTask`, the first branch (attempt < 3) unconditionally calls:

```typescript
await this.runBd(cwd, ["update", taskId, "--status=open", "--json"]);
```

If the EM closed the task externally between dispatch and failure, this reopens it — creating an infinite retry loop until the 3-strike limit is hit (and by that point the task may be deferred erroneously).

### Fix

At the **top** of `_requeueTask`, before incrementing `failureCounts`, add a status check:

```typescript
// Bug 1 fix: do not reopen tasks the EM has already closed
let currentStatus: string | undefined;
try {
    const { stdout } = await this._runBdRetry(cwd, ["show", taskId, "--json"]);
    const current = (JSON.parse(stdout) as any[])[0];
    currentStatus = current?.status as string | undefined;
} catch {
    // If we can't read the status, default to not reopening — safer than
    // risking an infinite retry loop.
    await this.notifyEM(
        `Coordinator: could not read status for task ${taskId} before requeue — skipping reopen to avoid unsafe retry.`
    );
    return;
}

if (currentStatus === "closed" || currentStatus === "deferred") {
    await this.notifyEM(
        `Coordinator: task ${taskId} was already ${currentStatus} (closed externally) — skipping reopen.`
    );
    return;   // Do NOT increment failureCounts — this was not a coordinator failure
}
```

**Exact placement:** this block goes at line 1 of `_requeueTask`, before `const count = ...`.

**Why before failureCounts increment:** if the EM closed the task, that is not a coordinator retry failure — it means the task was resolved via another path. Incrementing the count would pollute the persisted failure store with phantom strikes.

**The bd command:** `bd show <taskId> --json`, using `_runBdRetry` (same retry wrapper used elsewhere in the coordinator). No new tool introduced.

**Safe default on read failure:** return early and notify EM rather than reopening. Reopening a task whose status is unknown is the higher-risk action.

---

## 2. Bug 2 Fix — Durable Failure Counts

### Options Evaluated

| Option | Simplicity | Atomicity | Coordinator Coupling |
|---|---|---|---|
| **A: JSON file under `.pi/`** | High — standard JSON read/write | Atomic with write-then-rename | None — independent of bd schema |
| **B: Task metadata (`bd update --metadata`)** | Medium — depends on bd metadata API | Good — stored in SQLite alongside task | Medium — bd schema dependency |
| **C: Task labels (`failure-count:2`)** | Low — awkward string encoding, parse/update overhead | Same as B | High — pollutes label namespace |

### Recommendation: Option A — JSON file at `.pi/coordinator-failure-counts.json`

**Rationale:**

- No dependency on `bd update --metadata` flag existence or semantics — Option B requires confirming this flag is supported.
- File I/O in `_requeueTask` is already inside the write queue, so the increment write is serialised with no extra locking needed.
- Atomic writes (write to `.pi/coordinator-failure-counts.json.tmp`, then `fs.renameSync`) eliminate partial-write corruption.
- Load on `start()` is a single cheap synchronous JSON parse with a safe fallback to `new Map()` on any error.
- The file is co-located with `.pi/` extension code — appropriate home for coordinator internal state.

### Implementation contract

```typescript
// Path constant (top of coordinator.ts)
private static readonly FAILURE_COUNTS_PATH = ".pi/coordinator-failure-counts.json";

// Load on start()
start(cwd: string): void {
    if (this.active) return;
    this.active = true;
    this.activeCwd = cwd;
    this._loadFailureCounts(cwd);   // <-- add this line
    this._schedulePoll();
    this.onTaskCreated(cwd);
}

// _loadFailureCounts — synchronous, called once at start()
private _loadFailureCounts(cwd: string): void {
    try {
        const raw = fs.readFileSync(
            path.join(cwd, Coordinator.FAILURE_COUNTS_PATH), "utf8"
        );
        const obj = JSON.parse(raw) as Record<string, number>;
        this.failureCounts = new Map(Object.entries(obj));
    } catch {
        this.failureCounts = new Map(); // missing file or malformed — start clean
    }
}

// _persistFailureCounts — called after every set() in _requeueTask
private _persistFailureCounts(cwd: string): void {
    const obj = Object.fromEntries(this.failureCounts.entries());
    const json = JSON.stringify(obj, null, 2);
    const target = path.join(cwd, Coordinator.FAILURE_COUNTS_PATH);
    const tmp = target + ".tmp";
    try {
        fs.writeFileSync(tmp, json, "utf8");
        fs.renameSync(tmp, target);
    } catch (err: any) {
        // Non-fatal — counts survive in memory for this session; log and continue.
        this.notifyEM(
            `Coordinator: could not persist failure counts — ${err?.message ?? err}`
        ).catch(() => {});
    }
}
```

In `_requeueTask`, after `this.failureCounts.set(taskId, count)`:

```typescript
this._persistFailureCounts(cwd);
```

`_persistFailureCounts` must receive `cwd`. Since `_requeueTask` already has `cwd` as a parameter, this is a trivial pass-through.

---

## 3. Interaction Between Fixes

The two fixes are **independent in design** but have one **ordering dependency** in `_requeueTask`:

```
[Bug 1] status check & early-return
    ↓ (only if coordinator-owned)
[Bug 2] increment failureCounts, persist to file
    ↓
reopen or defer
```

The status check (Bug 1) must come **before** the failure count increment (Bug 2). If the task was closed externally, we must not record a phantom failure strike — doing so would cause the task to be prematurely deferred on a future honest run if it's ever re-opened.

No other interactions. Bug 2's load path (`start()`) and persist path (`_requeueTask`) are orthogonal to Bug 1's check.

---

## 4. Risk and Edge Cases

### Bug 1 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Race: EM closes task after status check but before `bd update --status=open` | Very low — write queue serialises all bd writes; EM close is a separate process | Acceptable — result is EM closes again; no loop |
| `bd show` fails (SQLite lock, process timeout) | Low — `_runBdRetry` provides 3 attempts | Safe default: return without reopening, notify EM |
| Status field missing from `bd show` response | Theoretical — schema would need to change | `currentStatus === undefined` is neither `closed` nor `deferred` — falls through to normal requeue path. Consider treating `undefined` same as "read failure" for maximum safety |

**Edge case to flag for the implementer:** the `bd show` call adds one round-trip latency to every failure path. This is inside the write queue, so it delays subsequent dispatches by the `bd show` duration (typically < 50 ms). Acceptable.

### Bug 2 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| File corruption (process killed mid-write) | Low — atomic rename makes this a non-issue | write-then-rename |
| Malformed JSON on load (manual edit, disk error) | Very low | Catch in `_loadFailureCounts`, start with empty map, log nothing (transparent restart) |
| Stale entries for deleted tasks | Low and harmless | Map grows but entries for deleted tasks are never matched; no cleanup needed |
| `_persistFailureCounts` fails silently | Low | Counts survive in memory for current session; only a restart before next failure loses the count (one extra retry at worst) |
| `cwd` changes between restart and load | Not applicable — `cwd` is fixed at `start(cwd)` | N/A |

**Edge case to flag for the implementer:** `_persistFailureCounts` calls `this.notifyEM(...)` but does **not** `await` it (because `_persistFailureCounts` is synchronous). Use `.catch(() => {})` on the returned promise to avoid unhandled rejection. See implementation contract above — this is already shown.

**Path resolution:** `FAILURE_COUNTS_PATH` is resolved relative to `cwd` (the project directory), not `__dirname`. This is consistent with how `beadsDir` is constructed elsewhere in the coordinator.
