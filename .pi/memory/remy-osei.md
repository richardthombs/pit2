# Remy Osei — Memory

## Project: pit2 (`/Users/richardthombs/dev/pit2`)

### Branch context
- Active branch is `beads-integration`. Main development of the org extension happens here.

### org extension (`/Users/richardthombs/dev/pit2/.pi/extensions/org/index.ts`)
- As of 2026-05-01 on `beads-integration`, the file already contains all four context-window-usage changes:
  - `contextPct?: number | null` on `MemberState`
  - Post-task `getSessionStats()` call in `runTaskWithStreaming()`
  - Async reaper that polls `getSessionStats()` for working members
  - `ctx:XX%` display in `buildWidgetLines()` (shown for any non-null number — threshold removed 2026-05-01)
- The file is ~1978 lines; the 50 KB read limit cuts off around line 1404.

### RpcClient / `getSessionStats`
- `RpcClient` is imported from `@mariozechner/pi-coding-agent`.
- `client.getSessionStats()` returns an object with `contextUsage?.percent` (number | undefined).
- `null` is used in `memberState.contextPct` to mean "model doesn't report context usage"; `undefined` means "not yet polled".
