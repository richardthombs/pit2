# Mercer Lin — Beads Specialist Memory

## Workstream Widget (org extension)

- **Location:** `.pi/extensions/org/index.ts` — not in the pi framework itself
- **Data source:** `bd list --status=open,in_progress --json` — no time window, no label filter
- **Cache:** Module-level `cachedBeadsTree`; refreshed only when `updateWidget` is called
- **`updateWidget` triggers:** `session_start`, roster file watcher, 60s reaper interval (if context stats changed), streaming events via `scheduleWidgetRefresh` (150ms debounce)
- **`agent_end` does NOT call `updateWidget`** — only calls `drainInbox`
- **Stale cache gap:** `drainInbox` closes inbox beads then sends a followUp, but the cache isn't refreshed until the next turn's streaming events fire. Closed beads remain visible in the widget for that window.

## Inbox / message bead flow

- Inbox beads: `bd list --label=pit2:message --assignee=em/ --status=open --limit=1`
- ACK-before-send: bead closed with `--reason=delivered` before `sendUserMessage` (at-most-once delivery)
- `scheduleInboxPing` sends "📬" as followUp to wake the EM; fires 10s after inbox write, retries up to 5× with backoff
