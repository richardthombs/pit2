# Jordan Blake — Memory

## Codebase landmark
Agent role definitions live in `/Users/richardthombs/dev/pit2/.pi/agents/*.md`.
YAML frontmatter uses `tools:` (space-indented with a leading space: ` tools: …`).

## SYSTEM.md structure (2026-05-01)
Section order in `/Users/richardthombs/dev/pit2/.pi/SYSTEM.md`:
1. ## Your Team
2. ## How to Work
3. ## Working Practices  ← added 2026-05-01
4. ## Working Principles
5. ## Tool Use Boundary

## Pitfall noted (2026-04-30)
`release-engineer.md` had its tools listed as `tools: bash, read` (bash-first),
not `tools: read, bash` as documented in the task brief. Always grep the actual
file content before assuming field order matches a specification.
