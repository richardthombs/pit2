---
role: qa-engineer
version: 1
last_updated: 2026-04-30T04:38:47.370Z
entry_count: 5
---

## Conventions
- role definition `tools` field should match the advisor/operator distinction — pure advisor roles (no file writes, no implementation) should list read, bash, grep, find; operator roles add edit/write

## Pitfalls
- bd create uses --description (-d) not --desc; bd create --epic does not exist; bd prime is an AI context primer command, not a task compaction tool — these are easy authoring mistakes in beads-related role definitions

## Codebase Landmarks
- beads-specialist.md role definition lives at /Users/richardthombs/dev/pit2/.pi/agents/beads-specialist.md; bd CLI is at /opt/homebrew/bin/bd; epic creation uses --type epic not --epic; bd prime outputs AI workflow context, not compaction
- beads-specialist.md has only one commit (initial creation); a rewrite described in QA tasking was not found in git history as of 2026-04-30 — if the rewrite task is re-issued, verify the commit lands before QA-ing
- beads-specialist.md rewrite (post-review) is confirmed in place as of 2026-04-30 — advisor-only role, tools: read, bash, grep, find, no memory/model lines, no CLI tables, includes "When NOT to Use Beads" section
