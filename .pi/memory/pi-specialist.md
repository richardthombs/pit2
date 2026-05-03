# Sam Chen — Pi Specialist Memory

## Codebase Landmarks

- Broker: `.pi/extensions/org/broker.ts` — dispatch loop, `_runAndClose`, `captureResult`, `_requeueTask`
- Main extension: `.pi/extensions/org/index.ts` — `runTask`, `getOrCreateClient`, `runBd`, agent config loading, `resolveOrScale`
- Utils: `.pi/extensions/org/utils.ts` — `UsageStats`, `extractMemoryEntries`, pure helpers

## Broker Architecture (key facts)

- `Broker` is a module-level singleton configured via `broker.configure(...)` before `broker.start(cwd)`.
- `_enqueueWrite` serialises all bd writes per-cwd through a promise chain. `captureResult` and inbox writes are enqueued here.
- `_enqueueMemoryPhase` is a SEPARATE per-role queue for memory-update prompts — runs concurrently with the write queue.
- `_runBdRetry` (3 attempts: 0/500/2000ms) is used in `_dispatchCycle` for claims, `captureResult` for `bd close`, and `_writeMessageToInbox` for `bd create`.
- `failureCounts.clear()` is called on every `broker.start()`, so the 3-failure safety net resets on every broker restart.

## Known Bugs / Findings

- **Task non-closure (pit2-ii56.1 — fixed):** `captureResult` now uses `_runBdRetry` for `bd close`; close failure no longer blocks inbox write.
- **"already claimed" trap:** If `bd ready` surfaces an in_progress task, broker marks a member `working` and skips — task is never re-dispatched and never closed.
- **Fixed (pit2-u9q8):** `scheduleInboxPing` (`index.ts`) now retries `sendUserMessage` with backoff (5 attempts: 5/10/15/20/25s) instead of silently dropping. The `!isIdle()` reschedule at 2s was already present. `_writeMessageToInbox` already uses `_runBdRetry` for `bd create`.

## Agent / Role Facts

- Technical-writer tools: `read, write, edit, bash, grep, find, ls` — no bd tools. Notes are written exclusively by `captureResult`.
- Agent configs live in `.pi/agents/<role>.md` with frontmatter (`name`, `description`, `tools`, `model`, `memory`).
- Per-role shared memory files: `.pi/memory/<role-slug>.md`.
- Per-member system prompt files: `.pi/prompts/members/<member-id>.md` (built fresh on each new client).
