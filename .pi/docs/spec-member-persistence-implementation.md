# Implementation Spec: Persistent RPC Clients per Team Member

**Author:** Alex Rivera (Architect)
**Date:** 2026-05-01
**Status:** Approved for implementation
**Target file:** `.pi/extensions/org/index.ts`
**Prerequisite reading:** `.pi/docs/design-member-persistence.md` (ADR-004)

---

## Overview

This spec replaces the per-task `child_process.spawn` in `runTask()` with a persistent `RpcClient`
per named team member. Clients are created on first use, reused across all subsequent tasks, and
reaped after 10 minutes of inactivity.

All ten implementation areas are covered below. Each section gives exact code structure, field
names, and behaviour. Ambiguities are called out explicitly with a recommended resolution.

---

## 1. New Data Structure — `liveMembers` Map

### Location in file

Declare `liveMembers` in **module scope** (alongside the existing module-level helpers, before the
`export default function(pi: ExtensionAPI)` call). It must not be inside the extension function
because it must survive across extension function calls and be accessible from all helpers.

### Type definition

Add the following interface and map declaration near the top of the file, after the existing
`interface RunResult` block:

```typescript
interface LiveMemberEntry {
  client: RpcClient;
  lastUsed: number;      // Date.now() timestamp; updated at the start of every runTask() call
  initialized: boolean;  // true after the one-time memory-injection prompt has been sent
}

// Key format: `${cwd}::${memberName}` — includes cwd so that two projects opened in the same
// pi instance do not share clients.
const liveMembers = new Map<string, LiveMemberEntry>();
```

### Import

`RpcClient` is exported from the package root. Add to the existing import from
`@mariozechner/pi-coding-agent`:

```typescript
import { parseFrontmatter, withFileMutationQueue, RpcClient } from "@mariozechner/pi-coding-agent";
import type { RpcClientOptions } from "@mariozechner/pi-coding-agent";
```

### Key format

```typescript
function liveMemberKey(cwd: string, memberName: string): string {
  return `${cwd}::${memberName}`;
}
```

Place this helper immediately after the `liveMembers` declaration.

---

## 2. `getOrCreateClient()` — Full Specification

### Signature

```typescript
async function getOrCreateClient(
  config: AgentConfig,
  memberName: string,
  cwd: string,
): Promise<RpcClient>
```

This is a **module-level async function** (not inside the extension function). It must be declared
after `liveMembers` and `liveMemberKey`.

### System prompt file

**Do not use a temp file.** Write a stable per-member file at:

```
<cwd>/.pi/prompts/members/<slug>.md
```

where `<slug>` is the same as `nameToId(memberName)` (already defined in the file).

Full path computation:

```typescript
function memberSystemPromptPath(cwd: string, memberName: string): string {
  return path.join(cwd, ".pi", "prompts", "members", `${nameToId(memberName)}.md`);
}
```

**Contents of the system prompt file:**

The file contains two sections, concatenated with `\n\n---\n`:

1. `config.systemPrompt` — the raw body of the `.pi/agents/<role>.md` file (no frontmatter).
2. The memory instructions block — **identical to what is built in the current `runTask()`**
   except the current memory file *contents* are **not included here**. The instructions tell the
   member who they are, where their memory file lives, and to write it at the end of each task.
   Content file injection is handled separately at client initialization (see §6).

Concretely:

```typescript
async function buildMemberSystemPromptFile(
  config: AgentConfig,
  memberName: string,
  cwd: string,
): Promise<string> {
  const filePath = memberSystemPromptPath(cwd, memberName);

  // Build the memory instructions block (no file contents)
  const memPath = memberMemoryPath(cwd, memberName);
  let memInstructions: string;
  try {
    const memTemplatePath = path.join(cwd, ".pi", "prompts", "memory.md");
    const template = fs.readFileSync(memTemplatePath, "utf-8");
    memInstructions = `\n\n---\n${template
      .replace(/\[name\]/g, memberName)
      .replace(/\[path\]/g, memPath)}`;
  } catch {
    memInstructions =
      `\n\n---\n## Your Identity & Memory\n\n` +
      `Your name is ${memberName}. Your memory file is at ${memPath}.\n\n` +
      `At the start of each task, read your memory file if it exists to recall relevant context. ` +
      `At the end of each task, update your memory file directly using your write/edit tools to ` +
      `record anything useful — decisions made, pitfalls encountered, codebase landmarks discovered. ` +
      `You own this file; maintain it however works best for you.`;
  }

  const content = config.systemPrompt + memInstructions;

  // Ensure directory exists
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await withFileMutationQueue(filePath, () =>
    fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 }),
  );
  return filePath;
}
```

**This file is written every time `getOrCreateClient()` creates a new client.** This ensures the
system prompt is current if the role definition changes between client restarts.

The file is **never deleted** by the extension. It is a stable artefact. (The `/fire` command
cleans up `.pi/memory/<slug>.md`; it does not need to clean up this file, though it may.)

### `RpcClientOptions` construction

```typescript
const rpcArgs: string[] = [
  "--no-session",
  "--no-context-files",
  "--system-prompt", "",           // clear any default system prompt
  "--append-system-prompt", systemPromptFile,
];
if (config.tools?.length) {
  rpcArgs.push("--tools", config.tools.join(","));
}

const clientOptions: RpcClientOptions = {
  cliPath: process.argv[1],        // path to the pi CLI script
  cwd,
  model: config.model,             // undefined is fine — RpcClient skips it
  args: rpcArgs,
};
```

**`cliPath` note:** `RpcClient.start()` spawns `node [cliPath] --mode rpc ...`. Passing
`process.argv[1]` (the pi script path) works correctly when pi is running as a Node.js script,
which is the standard deployment. If pi is running as a bun-compiled binary (`/$bunfs/root/...`
path), `RpcClient` cannot be used as-is because it hardcodes `node` as the executor. In that
environment the engineer must either: (a) fall back to the existing spawn path, or (b) patch
`RpcClient` to accept an `execPath` option.

> **Decision point for engineer:** Check whether the deployment uses bun-compiled binaries. If yes,
> raise with the team before implementing. Recommendation: detect with
> `process.argv[1]?.startsWith("/$bunfs/root/")` and throw a clear error at startup if that path
> is hit until a fix is in place.

### Process crash detection

Immediately after `client.start()`, attach an exit handler:

```typescript
// (client.process is private — access via the process exit event trick below)
// RpcClient does not expose the process directly. Instead, register a one-time
// onEvent listener for an event that will never arrive naturally — the process
// crash is detected via the client becoming unusable. See §9 for crash handling.
```

**Decision point for engineer:** `RpcClient` does not expose a public `onExit` hook. The engineer
must handle crashes by wrapping `client.prompt()` and `client.waitForIdle()` in try/catch and
treating any error as a potential crash (see §9). There is no reliable way to pre-emptively detect
a crash without accessing the private `process` field or patching `RpcClient`.

> **Recommendation:** Access `(client as any).process` to attach a one-time `exit` listener that
> removes the entry from `liveMembers`. This is a private field access but is low-risk given the
> framework is in the same repo and unlikely to change the field name. Full details in §9.

### Full `getOrCreateClient()` body

```typescript
async function getOrCreateClient(
  config: AgentConfig,
  memberName: string,
  cwd: string,
): Promise<RpcClient> {
  const key = liveMemberKey(cwd, memberName);
  const existing = liveMembers.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  // Build stable system prompt file
  const systemPromptFile = await buildMemberSystemPromptFile(config, memberName, cwd);

  const rpcArgs: string[] = [
    "--no-session",
    "--no-context-files",
    "--system-prompt", "",
    "--append-system-prompt", systemPromptFile,
  ];
  if (config.tools?.length) {
    rpcArgs.push("--tools", config.tools.join(","));
  }

  const client = new RpcClient({
    cliPath: process.argv[1],
    cwd,
    model: config.model,
    args: rpcArgs,
  });

  await client.start();

  // Enable auto-compaction so long-running members don't exceed their context window
  await client.setAutoCompaction(true);

  const entry: LiveMemberEntry = {
    client,
    lastUsed: Date.now(),
    initialized: false,
  };
  liveMembers.set(key, entry);

  // Attach crash recovery listener (private field access — see §9)
  const proc = (client as any).process as import("node:child_process").ChildProcess | null;
  proc?.once("exit", () => {
    // Only remove if this is still the current entry for this key
    if (liveMembers.get(key)?.client === client) {
      liveMembers.delete(key);
    }
  });

  return client;
}
```

---

## 3. `runTask()` Refactor — Full Specification

### New signature (unchanged from current)

```typescript
async function runTask(
  config: AgentConfig,
  memberName: string,
  task: string,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (text: string) => void,
  onStream?: (event: StreamEvent) => void,
): Promise<RunResult>
```

The signature is **identical to today**. All call sites are unaffected.

### Body — step by step

```typescript
async function runTask(
  config: AgentConfig,
  memberName: string,
  task: string,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (text: string) => void,
  onStream?: (event: StreamEvent) => void,
): Promise<RunResult> {
  // ── 1. Abort early if already cancelled ──────────────────────────────────
  if (signal?.aborted) throw new Error("Task aborted");

  // ── 2. Get or create persistent client ───────────────────────────────────
  const client = await getOrCreateClient(config, memberName, cwd);
  const key = liveMemberKey(cwd, memberName);
  const entry = liveMembers.get(key)!;
  entry.lastUsed = Date.now();

  // ── 3. Memory initialization (first task on a fresh client only) ─────────
  // See §6 for full details. Do this BEFORE attaching the per-task event listener.
  if (!entry.initialized) {
    await initializeClientMemory(client, memberName, cwd);
    entry.initialized = true;
  }

  // ── 4. Per-task usage accumulator (reset to zero for this task) ──────────
  const taskUsage: UsageStats = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    cost: 0, contextTokens: 0,
  };

  // ── 5. Register event listener for this task ─────────────────────────────
  const unsubscribe = client.onEvent((ev) => {
    // Usage: accumulate from each message_end
    if (ev.type === "message_end" && ev.message.role === "assistant") {
      const msg = ev.message as import("@mariozechner/pi-ai").AssistantMessage;
      const u = msg.usage;
      if (u) {
        taskUsage.input      += u.input;
        taskUsage.output     += u.output;
        taskUsage.cacheRead  += u.cacheRead;
        taskUsage.cacheWrite += u.cacheWrite;
        taskUsage.cost       += u.cost?.total ?? 0;
        taskUsage.contextTokens = u.totalTokens;  // overwrite — take latest
      }
    }

    // Streaming text: emit on each message_update so the widget animates
    if (ev.type === "message_update" && ev.message.role === "assistant") {
      const msg = ev.message as import("@mariozechner/pi-ai").AssistantMessage;
      const text = msg.content
        .filter((c): c is import("@mariozechner/pi-ai").TextContent => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text) {
        onProgress?.(text);
        onStream?.({ kind: "text", text });
      }
    }

    // Streaming tool call indicator
    if (ev.type === "tool_execution_start") {
      onStream?.({ kind: "tool", name: ev.toolName, summary: "" });
    }
  });

  // ── 6. Cancellation wiring ────────────────────────────────────────────────
  let aborted = false;
  let abortHandler: (() => void) | null = null;
  if (signal) {
    abortHandler = () => {
      aborted = true;
      client.abort().catch(() => {});
    };
    if (signal.aborted) {
      abortHandler();
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  try {
    // ── 7. Send the task prompt ─────────────────────────────────────────────
    await client.prompt(`Task for ${memberName}: ${task}`);

    // ── 8. Wait for completion ──────────────────────────────────────────────
    // 10-minute timeout. If the agent hasn't finished in 10 minutes, reject.
    await client.waitForIdle(600_000);

    if (aborted) throw new Error("Task aborted");

    // ── 9. Collect output ───────────────────────────────────────────────────
    const output = (await client.getLastAssistantText()) ?? "";

    return {
      exitCode: 0,
      output,
      stderr: "",
      usage: taskUsage,
    };
  } catch (err: any) {
    if (aborted || signal?.aborted) throw new Error("Task aborted");

    // Client crash or timeout — remove from map so next call recreates
    if (liveMembers.get(key)?.client === client) {
      liveMembers.delete(key);
      // Attempt graceful stop; ignore errors — process may already be dead
      client.stop().catch(() => {});
    }

    throw err;   // re-throw; callers (delegate tool) catch and report error
  } finally {
    unsubscribe();
    if (abortHandler && signal && !signal.aborted) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
```

### `RunResult` shape — **unchanged**

```typescript
interface RunResult {
  exitCode: number;
  output: string;
  stderr: string;
  usage: UsageStats;
}
```

`stderr` is always `""` in the RPC path. The field stays for call-site compatibility.

### What changes vs. today

| Today | After refactor |
|---|---|
| Builds a full message list from JSON lines | Calls `client.getLastAssistantText()` |
| `message_end` parsed from stdout JSON | `message_end` from `client.onEvent()` |
| Usage accumulated per `message_end` JSON | Same, but via `onEvent` handler |
| Tool streaming from `tool_use_start` JSON | `tool_execution_start` event |
| Text streaming from `message_end` JSON | `message_update` event (live, mid-stream) |
| Temp file written and deleted per task | System prompt file written once at client creation |
| Process spawned and exits per task | Client reused; `getLastAssistantText()` for output |

**Note on output collection:** The current implementation collects the last assistant text by
scanning the full `messages[]` array via `getFinalOutput()`. In the RPC path, `getLastAssistantText()`
does the same thing server-side. The helper `getFinalOutput()` and `JsonMessage` type are no longer
needed by `runTask()` but **keep them in the file** — they may be used elsewhere or useful for
debugging. Do not delete them.

---

## 4. Idle Reaping — How and When

### Reap interval: 60 seconds  
### Idle timeout: 10 minutes (600,000 ms)

### Where to start the reaper

Start in `session_start` handler (already registered). Add after the existing setup:

```typescript
pi.on("session_start", async (event, ctx) => {
  // ... existing code ...

  // Start idle reaper
  if (reaperInterval) clearInterval(reaperInterval);
  reaperInterval = setInterval(() => {
    reapIdleClients();
  }, 60_000);
});
```

Add `reaperInterval` to the closure variables at the top of `export default function(pi)`:

```typescript
let reaperInterval: ReturnType<typeof setInterval> | null = null;
```

### Reaper function

Module-level function (no closure needed):

```typescript
function reapIdleClients(): void {
  const now = Date.now();
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  for (const [key, entry] of liveMembers) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      liveMembers.delete(key);
      entry.client.stop().catch(() => {});
    }
  }
}
```

### Shutdown

In the existing `session_shutdown` handler, add:

```typescript
pi.on("session_shutdown", async () => {
  // ... existing cleanup ...

  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }

  // Stop all live clients
  for (const [, entry] of liveMembers) {
    entry.client.stop().catch(() => {});
  }
  liveMembers.clear();
});
```

### Reaper and working members

The reaper checks `lastUsed`, not member status. Since `lastUsed` is updated at the **start** of
`runTask()`, a member currently running a task will not be reaped. A member that finishes a task
and is then idle for 10 minutes will be reaped. The next task to that member will recreate the
client (cold start), which is the expected behaviour.

---

## 5. `/fire` Command and `fire` Tool Updates

Both the `/fire` command handler and the `fire` tool `execute` function must stop and remove any
live client for the fired member before removing them from the roster.

### Helper function (module-level)

```typescript
async function stopLiveClient(cwd: string, memberName: string): Promise<void> {
  const key = liveMemberKey(cwd, memberName);
  const entry = liveMembers.get(key);
  if (entry) {
    liveMembers.delete(key);
    await entry.client.stop().catch(() => {});
  }
}
```

### `/fire` command handler change

In the `/fire` handler, immediately before `roster.members.splice(idx, 1)`:

```typescript
await stopLiveClient(ctx.cwd, member.name);
// ... existing: roster.members.splice(idx, 1); saveRoster; memberState.delete; ...
```

### `fire` tool `execute` change

In the `fire` tool `execute`, immediately before `roster.members.splice(idx, 1)`:

```typescript
await stopLiveClient(ctx.cwd, member.name);
// ... existing: roster.members.splice(idx, 1); saveRoster; memberState.delete; ...
```

No other changes are needed in these handlers.

---

## 6. Memory Injection Timing

### Current approach (being replaced)

Today, `runTask()` reads the memory file on every call and injects the contents into the system
prompt (`--append-system-prompt`). The member sees their memory file as part of their system
prompt context on every task.

### New approach with persistent clients

The system prompt file (§2) includes the memory **instructions** (identity, path, read/write
directive) but NOT the file contents. File contents are injected once, as a message, immediately
after the client first starts. Subsequent tasks do not re-inject — the member already has the
content in their context window. The member's system prompt still instructs them to write the
memory file at task end, so file updates happen naturally.

### `initializeClientMemory()` function

```typescript
async function initializeClientMemory(
  client: RpcClient,
  memberName: string,
  cwd: string,
): Promise<void> {
  const memPath = memberMemoryPath(cwd, memberName);
  let memContent: string | null = null;
  try {
    const raw = fs.readFileSync(memPath, "utf-8");
    if (raw.trim()) memContent = raw.trim();
  } catch {
    // No memory file yet — that's fine
  }

  if (!memContent) {
    // Nothing to inject — member starts fresh
    return;
  }

  // Send the memory file contents as the first message in the session.
  // The member will read this and have it available for the upcoming task.
  await client.prompt(
    `Before your first task, here are your current memory file contents:\n\n${memContent}\n\n` +
    `Please acknowledge this context briefly.`
  );
  await client.waitForIdle(30_000);  // 30-second timeout for ack
}
```

**This is called once per client lifetime**, guarded by `entry.initialized`. If the client crashes
and is recreated, the new client will call `initializeClientMemory()` again, reading whatever the
member last wrote to the memory file.

### What the member does after tasks

The system prompt instructs: *"At the end of each task, update your memory file directly using
your write/edit tools."* This remains the mechanism. No post-task `followUp()` call is needed from
the extension. The member writes the file as a tool call within the task itself.

---

## 7. Streaming and the `onStream` Callback

### Current approach

`runTask()` calls `onStream?.({ kind: "text", text })` from within `message_end` events parsed
from the subprocess stdout JSON. This gives one "batch" text update per assistant turn.

### New approach

With `RpcClient.onEvent()`, we can stream at `message_update` granularity — text updates arrive
as the model generates tokens, not only at turn end. This is strictly better for the widget.

The `onStream` wiring is inside the per-task event listener in `runTask()` (shown in §3):

```typescript
// message_update → live text streaming (fires many times per turn)
if (ev.type === "message_update" && ev.message.role === "assistant") {
  const msg = ev.message as AssistantMessage;
  const text = msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
  if (text) {
    onProgress?.(text);
    onStream?.({ kind: "text", text });
  }
}

// tool_execution_start → tool indicator
if (ev.type === "tool_execution_start") {
  onStream?.({ kind: "tool", name: ev.toolName, summary: "" });
}
```

### `runTaskWithStreaming()` — **unchanged**

This wrapper function is not modified. It calls `runTask()` and passes an `onStream` callback that
updates `memberState.streaming` and calls `scheduleWidgetRefresh()`. Since `runTask()` now calls
`onStream` with `message_update` events instead of `message_end` events, the widget will update
more frequently (live token streaming). No other change is needed here.

### Types

Add imports for `AssistantMessage` and `TextContent`:

```typescript
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
```

> **Decision point for engineer:** `@mariozechner/pi-ai` is a dependency of
> `@mariozechner/pi-coding-agent` but may not be a direct dependency of `pit2`. Check
> `package.json`. If not present, add it, or use `(ev.message as any).content` with a type guard
> comment. Recommendation: add the import — the package is already transitively available.

---

## 8. Signal / Cancellation

### Current approach

`runTask()` listens for `signal.abort` and sends `SIGTERM` to the subprocess, followed by
`SIGKILL` after 5 seconds.

### New approach

`RpcClient` exposes `client.abort()` which sends `{ type: "abort" }` to the running agent. This
is the correct way to cancel a prompt in RPC mode.

The wiring is in `runTask()` as shown in §3:

```typescript
let aborted = false;
let abortHandler: (() => void) | null = null;
if (signal) {
  abortHandler = () => {
    aborted = true;
    client.abort().catch(() => {});  // fire-and-forget; abort() may throw if process is dead
  };
  if (signal.aborted) {
    abortHandler();
  } else {
    signal.addEventListener("abort", abortHandler, { once: true });
  }
}
```

After `waitForIdle()` resolves (abort causes an early idle), check `aborted` and throw:

```typescript
if (aborted) throw new Error("Task aborted");
```

### Client lifecycle after abort

After an abort, the RPC process is still alive and the session is intact. The client can be reused
for the next task. **Do not remove the entry from `liveMembers` on abort.** Only remove on crash
(§9).

### Abort propagation

`waitForIdle()` will resolve (via `agent_end`) when the abort completes. The framework sends
`agent_end` after aborting. The `runTask()` try/catch checks `aborted` before inspecting the
result.

---

## 9. Error Handling — Crash Detection and Recovery

### Crash types

Two categories:
1. **RpcClient error** — `prompt()` or `waitForIdle()` throws (process dead, timeout, etc.)
2. **Agent error** — task ran to completion but produced an error (non-zero exit in JSON mode had
   `exitCode !== 0`; in RPC mode the agent always "succeeds" at the transport level)

### Category 1 — `prompt()` or `waitForIdle()` throws

Caught in the `catch` block of `runTask()`:

```typescript
} catch (err: any) {
  if (aborted || signal?.aborted) throw new Error("Task aborted");

  // Treat any non-abort error as a potential client crash
  if (liveMembers.get(key)?.client === client) {
    liveMembers.delete(key);
    client.stop().catch(() => {});
  }

  throw err;  // caller sees a rejected promise; delegate tool renders error to LLM
}
```

**No retry.** The error is surfaced to the delegate tool, which returns `isError: true` to the
LLM. The LLM can decide to re-delegate if appropriate. Automatic retry risks silently losing
context and producing confusing behaviour.

### Category 2 — Agent ran but produced no useful output

In RPC mode there is no `exitCode`. `getLastAssistantText()` returns `null` if the agent produced
no assistant message (e.g. was interrupted, or the model refused).

Handle in `runTask()`:

```typescript
const output = (await client.getLastAssistantText()) ?? "";

if (!output) {
  // Agent completed but produced nothing — treat as an error but don't kill the client
  return {
    exitCode: 1,
    output: "(no output)",
    stderr: client.getStderr(),
    usage: taskUsage,
  };
}

return { exitCode: 0, output, stderr: "", usage: taskUsage };
```

> **Decision point for engineer:** Should a "no output" result remove the client from `liveMembers`?
> Recommendation: **no** — the client is still alive and its context intact. The agent may have
> simply produced no text (e.g. only tool calls). Let the client survive.

### Pre-emptive crash detection via private `process` field

As noted in §2, attach an exit listener immediately after `client.start()`:

```typescript
const proc = (client as any).process as ChildProcess | null;
proc?.once("exit", () => {
  if (liveMembers.get(key)?.client === client) {
    liveMembers.delete(key);
    // Do NOT call client.stop() here — process is already dead
  }
});
```

This ensures `liveMembers` is cleaned up even if the crash happens between tasks (not during a
`runTask()` call). The `reapIdleClients()` interval would eventually clean up a stale entry, but
this is faster and avoids attempting `prompt()` on a dead client.

### Stderr capture

`RpcClient` accumulates stderr internally (`client.getStderr()`). In the "no output" error path
above, include `client.getStderr()` in the returned `stderr` field. This lets the delegate tool
surface diagnostic information to the LLM.

---

## 10. What Stays the Same

The following parts of `index.ts` are **untouched** by this implementation:

### Untouched entirely

- `TeamMember`, `Roster`, `AgentConfig`, `RunResult`, `StreamEvent` interfaces
- `NAME_POOL`, `getRosterPath()`, `loadRoster()`, `saveRoster()`, `pickUnusedName()`, `nameToId()`
- `getAgentsDir()`, `loadAgentConfig()`, `listAvailableRoles()`
- `memberMemoryPath()`
- `getPiInvocation()` — kept but no longer called by `runTask()` (retain for possible future use)
- `writeTempPrompt()` — kept but no longer called (retain or delete at engineer's discretion)
- `getFinalOutput()`, `JsonMessage` — kept for reference / potential future use
- `ANSI_STRIP_RE`, `lastMeaningfulLine()`, `extractStreamSnippet()`
- `AssigneeFields`, `DelegateParams` schemas
- `MemberStatus`, `MemberState` interfaces
- `runTaskWithStreaming()` — wrapper is unchanged; it calls `runTask()` the same way
- `buildWidgetLines()`, `updateWidget()`, `scheduleWidgetRefresh()`
- `scheduleDoneReset()`, `deliverResult()`
- `accumulateUsage()` — unchanged; still called from delegate tool after `runTask()` returns
- `/team`, `/roles`, `/hire`, `/async` command handlers — unchanged
- `hire` tool — unchanged
- `delegate` tool — **all four modes (single, parallel, chain, async variants)** are unchanged;
  they call `runTaskWithStreaming()` which calls `runTask()`. No changes to their call sites.
- `resolveOrScale()` — unchanged
- `withScalingLock()`, `scalingLocks` — unchanged
- `session_start` handler — add reaper start (§4) but everything else unchanged
- `session_shutdown` handler — add client teardown (§4) but timer cleanup is unchanged

### The only functions that change

| Function / declaration | Change |
|---|---|
| `runTask()` | Full replacement (§3) |
| `session_start` handler | Add reaper start (§4) |
| `session_shutdown` handler | Add client teardown (§4) |
| `/fire` command handler | Add `stopLiveClient()` call (§5) |
| `fire` tool `execute` | Add `stopLiveClient()` call (§5) |
| Top-level imports | Add `RpcClient`, `RpcClientOptions` from `@mariozechner/pi-coding-agent`; add `AssistantMessage`, `TextContent` from `@mariozechner/pi-ai` |

### New additions (no replacements)

| Addition | Location |
|---|---|
| `interface LiveMemberEntry` | Module scope, after `RunResult` |
| `const liveMembers` | Module scope, after `LiveMemberEntry` |
| `liveMemberKey()` | Module scope |
| `memberSystemPromptPath()` | Module scope |
| `buildMemberSystemPromptFile()` | Module scope |
| `getOrCreateClient()` | Module scope |
| `initializeClientMemory()` | Module scope |
| `reapIdleClients()` | Module scope |
| `stopLiveClient()` | Module scope |
| `let reaperInterval` | Inside `export default function(pi)` closure, with other `let` declarations |

---

## Appendix A: Explicit Decisions for the Engineer

The following ambiguities were not fully resolved by the architect. Each has a recommended answer;
the engineer should confirm before implementing.

| # | Question | Recommendation |
|---|---|---|
| A1 | `RpcClient` hardcodes `node` as executor. Does the target deployment use bun-compiled pi? | If yes, add a detection guard and throw early. If no, proceed with `cliPath: process.argv[1]`. |
| A2 | Is `@mariozechner/pi-ai` a direct dependency of `pit2`? | Check `package.json`. If absent, add it. If not possible, use `(msg as any).usage` with a comment. |
| A3 | Should `/fire` also delete `.pi/prompts/members/<slug>.md`? | Recommended: yes, for cleanliness. Low priority — the file is harmless if left. |
| A4 | `waitForIdle()` default timeout is 60s. This spec uses 600s (10 min) for tasks and 30s for memory init. Are those values acceptable? | Confirm with stakeholder. Tasks can legitimately take longer than 10 min for large codebases. Consider making the task timeout a config constant at the top of the file: `const TASK_IDLE_TIMEOUT_MS = 10 * 60 * 1000;`. |
| A5 | After a client crash mid-task, the delegate tool re-throws the error. Should the LLM be told the member "crashed" or just see a generic error? | Recommended: wrap in a descriptive error message: `"${memberName} process crashed. Context has been reset — the next task will start fresh."` |

---

## Appendix B: File Layout After Implementation

All new module-scope additions appear in this order (between the existing `memberMemoryPath` helper
and the existing `writeTempPrompt` helper):

```
// ─── Subagent persistent clients ──────────────────────────────────────────────

interface LiveMemberEntry { ... }
const liveMembers = new Map<...>();
function liveMemberKey(...): string { ... }
function memberSystemPromptPath(...): string { ... }
async function buildMemberSystemPromptFile(...): Promise<string> { ... }
async function initializeClientMemory(...): Promise<void> { ... }
async function getOrCreateClient(...): Promise<RpcClient> { ... }
function reapIdleClients(): void { ... }
async function stopLiveClient(...): Promise<void> { ... }
```

The existing `writeTempPrompt()` function may be removed if the engineer confirms it has no other
callers. A global grep for `writeTempPrompt` in the extensions directory will confirm this.
