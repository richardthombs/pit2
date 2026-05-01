# Blaine Mwangi — Memory

## Codebase: /Users/richardthombs/dev/pit2

### Extension: `.pi/extensions/org/index.ts`

- Large single-file extension (~1978 lines) implementing the org/delegation system.
- Key closure-scoped state (declared inside `export default function(pi: ExtensionAPI)`):
  - `memberState: Map<string, MemberState>` — live status of each team member
  - `memberUsage`, `memberTimers`, `asyncMode`, `lastCtx`, `reaperInterval`
- Helper functions that must be **inside the closure** (they use `memberState`):
  `setMemberStatus`, `scheduleDoneReset`, `deliverResult`, `updateWidget`, `runTaskWithStreaming`, `buildWidgetLines`, `scheduleWidgetRefresh`, `accumulateUsage`
- Module-scope singletons: `liveMembers`, `beadsReady`, `scalingLocks`, `broker`
- `resolveOrScale` is module-scope but takes `memberState` as an explicit parameter (by design).
- `broker` is a module-level singleton configured via `broker.configure(...)` at closure start.
- Branch `beads-integration` is where active org/beads work happens.
