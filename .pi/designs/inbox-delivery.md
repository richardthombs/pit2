# Design: Inbox-Based Task Completion Delivery

**Status:** Proposed  
**Parent epic:** pit2-xcg.5.9  
**Author:** Emery Vidal  
**Date:** 2026-05-03

---

## Overview

Replace the current push-based `deliverResult` (direct `pi.sendUserMessage` from broker) with an inbox-based pull mechanism. Task completions are written as ephemeral beads; an `agent_end` handler drains one message per turn. This eliminates timing hazards caused by concurrent completions firing into the EM's turn pipeline, and makes delivery persistent across session restarts.

---

## 1. Message Schema

### Bead fields

| Field | Value |
|---|---|
| `issue_type` | `task` (bd create --type=task) |
| `title` | `Task completed: <taskTitle>` |
| `description` | Full formatted content — the `header + output` string ready for delivery (see below) |
| `assignee` | `em/` — fixed EM inbox address; never resolves to a real roster member |
| `labels` | `["pit2:message", "msg-type:task-complete", "from:<memberName>"]` |
| `status` | `open` on creation; `closed` after delivery |
| `notes` | Not used for message beads |

### Metadata fields

Set via `--metadata=<json>` at create time (e.g. `--metadata='{"task_id":"...","role":"...","member_name":"..."}'`):

| Key | Value | Purpose |
|---|---|---|
| `task_id` | e.g. `pit2-xcg.5.9.2` | Allows recovery — EM can look up the source task |
| `role` | e.g. `typescript-engineer` | Displayed in the delivery header |
| `member_name` | e.g. `Casey Kim` | Displayed in the delivery header |

### Description (delivery content)

The `description` field holds the pre-formatted delivery string exactly as the EM will see it:

```
**Task completed: <taskTitle>**
Bead `<taskId>` · Role: <role> · Member: <memberName>

<output>
```

This is the same string currently assembled inline in the `deliverResult` closure in `index.ts`. Pre-formatting at write time keeps the receive path simple — it reads and sends, no reconstruction needed.

### Why description, not notes?

`notes` is append-only and intended for human summaries. `description` is a first-class field and is not accumulated — it holds exactly what we write. Using `description` also means a future `bd show` retrieval of an undelivered message immediately shows the full content without extra fields.

### Inbox address

`em/` is chosen as a symbolic address that will never collide with a team member name (all names are `First Last` format from the name pool). It requires no special support from bd — `--assignee=em/` is stored verbatim as a string.

---

## 2. Send Path

### Does `deliverResult` still exist?

No. The `deliverResult` dependency is removed from the broker entirely. In its place, the broker gains a private method `_writeMessageToInbox(...)` that creates the message bead.

### `_writeMessageToInbox` (new, in `broker.ts`)

```typescript
private async _writeMessageToInbox(
  cwd: string,
  taskId: string,
  taskTitle: string,
  role: string,
  memberName: string,
  output: string,
): Promise<void>
```

Called from `_runAndClose` inside the write queue, immediately after `captureResult` completes successfully (replacing the current `this.deliverResult(...)` call).

Implementation:

```typescript
const header = `**Task completed: ${taskTitle}**\nBead \`${taskId}\` · Role: ${role} · Member: ${memberName}\n\n`;
const content = header + output;
const title = `Task completed: ${taskTitle}`;

const metadata = JSON.stringify({ task_id: taskId, role, member_name: memberName });

await this.runBd(cwd, [
  "create", title,
  "--type=task",
  "--assignee=em/",
  "--label=pit2:message",
  "--label=msg-type:task-complete",
  `--label=from:${memberName.toLowerCase().replace(/\s+/g, "-")}`,
  `--description=${content}`,
  `--metadata=${metadata}`,
  "--json",
]);
```

If `_writeMessageToInbox` throws (bd create fails), fall back to direct `notifyEM` with a warning:

```typescript
await this.notifyEM(
  `Broker: inbox write failed for task ${taskId} ("${taskTitle}") — ` +
  `falling back to direct delivery. Error: ${err?.message ?? err}\n\n` +
  header + output
);
```

This fallback preserves the current behaviour in degraded conditions and ensures no output is silently lost.

### `notifyEM` — unchanged

`notifyEM` (operational errors, warnings, re-queue notices) continues to call `pi.sendUserMessage` directly. These are urgent, small, actionable messages that do not benefit from queuing and should reach the EM immediately regardless of inbox state.

### `deliverResult` removal from `broker.configure()`

The `deliverResult` parameter is removed from the `configure()` method signature entirely. The `Broker` class no longer holds a `deliverResult` field. Callers in `index.ts` update accordingly (see §7).

---

## 3. Receive Path

### `agent_end` handler (new, in `index.ts`)

Registered once in the extension `default` function:

```typescript
pi.on("agent_end", async (_event, ctx) => {
  await drainInbox(ctx.cwd);
});
```

### `drainInbox(cwd)` (new helper, in `index.ts`)

```typescript
async function drainInbox(cwd: string): Promise<void> {
  if (beadsReady.get(cwd) !== true) return;

  let messages: InboxMessage[];
  try {
    const { stdout } = await runBd(cwd, [
      "list",
      "--label=pit2:message",
      "--assignee=em/",
      "--status=open",
      "--limit=1",
      "--json",
    ]);
    messages = JSON.parse(stdout) as InboxMessage[];
  } catch (err: any) {
    // Inbox query failed — log to console, do not block the turn
    console.error(`[org] drainInbox: bd list failed — ${err?.message ?? err}`);
    return;
  }

  if (messages.length === 0) return;

  const msg = messages[0];

  // ACK (close) BEFORE sending — gives at-most-once delivery semantics.
  // If close succeeds but sendUserMessage fails, the content is preserved
  // in the bead's description and recoverable via bd show <id>.
  try {
    await runBd(cwd, ["close", msg.id, "--reason=delivered", "--json"]);
  } catch (err: any) {
    console.error(`[org] drainInbox: failed to close message bead ${msg.id} — ${err?.message ?? err}`);
    // Do NOT send — bead remains open and will be retried next turn.
    return;
  }

  try {
    await pi.sendUserMessage(msg.description ?? `(message bead ${msg.id} had no content)`, {
      deliverAs: "followUp",
    });
  } catch (err: any) {
    // Delivery failed after close — message is lost from the inbox.
    // Log to console; bead is closed with content in description for manual recovery.
    console.error(
      `[org] drainInbox: sendUserMessage failed for bead ${msg.id} — ` +
      `content preserved in bead description. Error: ${err?.message ?? err}`
    );
  }
}
```

### Type used internally

```typescript
interface InboxMessage {
  id: string;
  description?: string;
  title: string;
  labels?: string[];
  metadata?: Record<string, string>;
}
```

### One per turn, not all at once

`drainInbox` deliberately delivers exactly one message per `agent_end` event. This is intentional:

- Each `sendUserMessage({ deliverAs: "followUp" })` triggers a new EM turn.
- That turn ends, `agent_end` fires again, delivering the next message.
- This gives the EM a full turn to process each completion before the next arrives — no context pile-up.

If the inbox is empty, `drainInbox` returns immediately and no followUp is triggered. The drain naturally terminates.

### ACK-then-send vs send-then-ACK

**ACK-before-send** is chosen (close bead, then call sendUserMessage). Rationale:

- The alternative (send then ACK) risks double-delivery if the process crashes after send but before close. Double-delivery of a task completion is confusing to the EM.
- If close succeeds but send fails, the bead is closed with `description` intact. Manual recovery: `bd show <id>` or `bd list --label=pit2:message --status=closed` (by convention, failed deliveries will have `close_reason=delivered` but description not yet seen).
- A failed `sendUserMessage` is already an exceptional condition; surfacing it via console.error is appropriate.

---

## 4. Session Start Recovery

In `session_start`, after `broker.start(ctx.cwd)`:

```typescript
// Drain any messages that arrived while the session was down
await drainInbox(ctx.cwd);
```

This handles the case where:
- Tasks completed between the last session shutdown and this startup.
- The bead write succeeded but `sendUserMessage` never fired (process died after ACK).

The `session_start` handler already runs after `ensureBeadsInit`, so `beadsReady` is set correctly before `drainInbox` is called.

`drainInbox` delivers one message and triggers a followUp turn. `agent_end` handles the rest of the queue from there. No loop needed in `session_start`.

---

## 5. Transition Plan

### What changes

| Location | Before | After |
|---|---|---|
| `broker.ts` `configure()` signature | Takes `deliverResult` parameter | `deliverResult` parameter removed |
| `broker.ts` | Calls `this.deliverResult(...)` after captureResult | Calls `this._writeMessageToInbox(...)` |
| `broker.ts` | `deliverResult` field declared | Removed |
| `index.ts` broker.configure() call | Passes `deliverResult` closure | Closure removed from call |
| `index.ts` | No `agent_end` handler | `agent_end` handler registered; calls `drainInbox` |
| `index.ts` | No `session_start` inbox drain | `drainInbox` call added after `broker.start()` |

### What stays the same

- `notifyEM` — direct `sendUserMessage`, unchanged.
- `captureResult` — unchanged; still appends notes and closes the task bead.
- `scheduleDoneReset` / `accumulateMemberUsage` — unchanged; still called after write queue entry completes.
- The broker write queue — `_writeMessageToInbox` runs inside the same write queue entry as `captureResult`, maintaining serialisation.

### Does operational noise (notifyEM) move to inbox?

**No.** `notifyEM` stays as direct `sendUserMessage`. Rationale:
- Operational messages (bd failures, re-queue notices, memory phase errors) are urgent and need immediate visibility.
- They are small — no risk of context flooding.
- Mixing them into the inbox alongside task outputs would make it harder for the EM to prioritise.
- If inbox delivery itself fails, `notifyEM` is the fallback — it must remain unconditionally reliable.

If the distinction ever changes (e.g. the team wants all async messages queued), that is a separate decision with a separate ADR.

---

## 6. Edge Cases

### 6.1 Inbox query fails in `agent_end`

If `bd list` throws in `drainInbox`, log to console.error and return. The turn ends cleanly. Next `agent_end` will retry. No EM disruption.

### 6.2 Message bead partially written

`bd create` is atomic at the SQLite level — if it fails, no bead is written. The fallback in `_writeMessageToInbox` catches this and calls `notifyEM` directly with the full output. No partial state.

### 6.3 EM is already in a followUp turn when `agent_end` fires

`agent_end` fires after a turn completes. A new followUp starts a new turn. When that turn ends, `agent_end` fires again. There is no concurrent `agent_end` — the event fires once per completed turn, and turns are serial. The drain terminates naturally when the inbox empties.

### 6.4 Very large output (60 KB limit already enforced)

`captureResult` already throws if `output.length > 60 * 1024`. The throw is caught in `_runAndClose`'s write queue entry, which calls `notifyEM` with a user-facing error. `_writeMessageToInbox` is never reached. No change needed.

### 6.5 `bd close` fails on the message bead during drain

`drainInbox` returns without calling `sendUserMessage`. Bead remains `open`. Next `agent_end` retries the same bead. This gives at-least-once delivery in the error path only (close failure is a degraded-state scenario; in normal operation close succeeds and we get at-most-once).

### 6.6 Two concurrent `agent_end` firings

The pi framework does not fire `agent_end` concurrently — events are delivered serially after each turn. However, if for any reason two handlers raced:
- Both would call `bd list --limit=1`; both could see the same message.
- Both would attempt `bd close`; only one would succeed (SQLite serialisation via the write queue, or bd's own locking).
- The loser would get an error from `bd close` and return without sending.
- Result: at-most-once delivery. Acceptable.

### 6.7 Session shutdown mid-drain

If the session shuts down after ACK (close) but before `sendUserMessage` fires, the message bead is closed with its content intact. On next session start, `drainInbox` is called but finds no `open` messages (the bead is closed). Recovery path: the EM can inspect recent closed message beads with `bd list --label=pit2:message --status=closed` and re-read any that were closed-but-not-seen. This is a rare edge case and manual recovery is acceptable.

---

## 7. Impact on `broker.ts` and `index.ts`

### `broker.ts` changes

1. **Remove** `deliverResult` field declaration and its assignment in `configure()`.
2. **Remove** `deliverResult` parameter from `configure()` method signature.
3. **Remove** the `this.deliverResult(...)` call in `_runAndClose`'s write queue entry.
4. **Add** private method `_writeMessageToInbox(cwd, taskId, taskTitle, role, memberName, output)`.
5. **Call** `_writeMessageToInbox` in its place, with the `notifyEM` fallback on failure.
6. The `scheduleDoneReset` and `accumulateMemberUsage` calls that follow `deliverResult` are unaffected — they remain in the same write queue entry.

Net change to `broker.ts`: ~+25 lines (new method), ~−5 lines (removed field, call, parameter).

### `index.ts` changes

1. **Remove** the `deliverResult` closure from the `broker.configure(...)` call.
2. **Add** `drainInbox(cwd: string): Promise<void>` helper function (scoped outside the extension function, takes `runBd` and `pi` as closure or parameters — see note below).
3. **Register** `pi.on("agent_end", async (_event, ctx) => { await drainInbox(ctx.cwd); })` in the extension function body.
4. **Add** `await drainInbox(ctx.cwd)` in the `session_start` handler, after `broker.start(ctx.cwd)`.

**Note on `drainInbox` scope:** `drainInbox` needs access to `runBd` (module-level function, already accessible) and `pi.sendUserMessage` (available only inside the extension closure). It should be defined inside the extension `default` function as a closure, or accept `pi` as a parameter. Defining it inside the closure is the simpler choice — consistent with how the `notifyEM` closure is handled today.

Net change to `index.ts`: ~+35 lines (drainInbox helper, event registration, session_start drain), ~−8 lines (deliverResult closure removed from configure call).

---

## Open Questions / Risks

> **QA review (pit2-xcg.5.9.2) — approved with notes.** Critical finding: `--set-metadata` flag does not exist on `bd create` (see item 1). All other design claims verified against live bd binary.


1. **`bd create` metadata syntax** — ~~verify `--set-metadata=key=value`~~ **Resolved by QA (pit2-xcg.5.9.2):** `--set-metadata` does not exist on `bd create` and throws `unknown flag`. Use `--metadata=<json>` with a JSON object string. The metadata fields (taskId, role, memberName) are nice-to-have for debugging; the description is the critical field.

2. **`bd list` label filtering with multiple labels** — confirm that `bd list --label=pit2:message` alone is sufficient for inbox isolation, or whether AND-semantics on multiple `--label` flags are needed/available. Since `assignee=em/` is also filtered, a single label check may suffice.

3. **Message bead visibility in the workstream widget** — message beads are `open` tasks with no parent epic and will appear in the `orphans` section of `buildBeadsLines`. This is noise. Options: (a) filter orphans by absence of `pit2:message` label; (b) give message beads a parent epic; (c) accept the noise until the widget is updated. Recommend (a) as a minor follow-up.

4. **`bd list --assignee=em/` support** — confirm that bd's list command accepts `--assignee` as a filter. If not, filter client-side from all `--label=pit2:message` results.

5. **Ordering of delivery** — `bd list` default ordering (presumably by created_at asc) means oldest completion is delivered first. This is correct FIFO semantics. Confirm bd list returns items in creation order.
