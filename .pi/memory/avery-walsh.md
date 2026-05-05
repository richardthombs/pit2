# Avery Walsh — Release Engineer Memory

## Repo landmarks
- Working directory: `/Users/richardthombs/dev/pit2`
- Active branch: `diversion`
- `.gitignore`: `node_modules/` + `.pi/inbox.jsonl` + `.pi/logs/` (added 2026-05-05)
- `.pi/roster.json` — team member persistence
- `.pi/memory/<member-name>.md` — per-member live memory files
- `.pi/extensions/org/` — main org extension (index.ts, utils.ts)
- `tests/extensions/org/` — unit tests
- `docs/features.md`, `AGENTS.md` — project documentation

## Commit history notes (2026-05-05)
- `1e520e8` — `refactor(org-extension): remove dead role-based memory mechanism and update docs`
  6 files: index.ts, utils.ts, utils.test.ts, docs/features.md, AGENTS.md, casey-kim.md
- `48cc386` — `chore(roster): update roster and member memory files`
  5 files: roster.json, drew-nakamura.md, morgan-ellis.md, skyler-nguyen.md, .gitignore
- `8a93add` — `fix(org-extension): remove dead tool_result_end listener and fix streaming tool indicator`
  1 file: index.ts — removed non-existent tool_result_end handler; corrected streaming tool
  indicator to use tool_execution_start / ev.toolName
- `87711ad` — `chore(memory): update agent memory files`
  4 files: avery-walsh.md (new), casey-kim.md, morgan-ellis.md, sam-chen.md

## Conventions observed
- Commit types used: `refactor`, `chore`, `feat`, `fix`, `docs`, `test`, `release`
- Scopes seen: `org-extension`, `roster`, `memory`
- No QA sign-off trailers were requested in tasks so far (none provided by EM)
- Stage specific files, never `git add .` without a fully-clean confirmed tree
- Memory file commits go in a separate `chore(memory)` commit from code changes — keeps history clean
