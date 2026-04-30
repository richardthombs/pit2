---
role: qa-engineer
version: 1
last_updated: 2026-04-30T05:19:50.544Z
entry_count: 8
---

## Conventions
- role definition `tools` field should match the advisor/operator distinction — pure advisor roles (no file writes, no implementation) should list read, bash, grep, find; operator roles add edit/write

## Pitfalls
- bd create uses --description (-d) not --desc; bd create --epic does not exist; bd prime is an AI context primer command, not a task compaction tool — these are easy authoring mistakes in beads-related role definitions

## Codebase Landmarks
- beads-specialist.md role definition lives at /Users/richardthombs/dev/pit2/.pi/agents/beads-specialist.md; bd CLI is at /opt/homebrew/bin/bd; epic creation uses --type epic not --epic; bd prime outputs AI workflow context, not compaction
- beads-specialist.md has only one commit (initial creation); a rewrite described in QA tasking was not found in git history as of 2026-04-30 — if the rewrite task is re-issued, verify the commit lands before QA-ing
- beads-specialist.md rewrite (post-review) is confirmed in place as of 2026-04-30 — advisor-only role, tools: read, bash, grep, find, no memory/model lines, no CLI tables, includes "When NOT to Use Beads" section
- beads-specialist.md tools line was updated to include web_search and fetch_content (as of 2026-04-30), full line: `tools: read, bash, grep, find, web_search, fetch_content`
- In org/index.ts, resolveOrScale is a closure inside delegate's execute() that captures ctx — its updateWidget(ctx) call in the auto-hire branch is a minor stale-ctx gap covered by the guard but not fixed in the 2026-04-30 async stale-ctx fix; worth noting for any future related work
- The EM system prompt lives at /Users/richardthombs/dev/pit2/.pi/SYSTEM.md; Tool Use Boundary section explicitly prohibits using read/bash/grep to answer domain-expertise questions directly — those must be delegated to a specialist
