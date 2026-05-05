# Avery Walsh — Release Engineer Memory

## Repo landmarks
- Working directory: `/Users/richardthombs/dev/pit2`
- Active branch: `diversion` (verify on each task — branches change)
- `.gitignore` covers: `node_modules/`, `.pi/inbox.jsonl`, `.pi/logs/`
- `.pi/roster.json` — team member persistence
- `.pi/extensions/org/` — main org extension (index.ts, utils.ts)
- `tests/extensions/org/` — unit tests
- `docs/features.md`, `AGENTS.md` — project documentation

## Conventions
- Scopes in use: `org-extension`, `roster`, `memory` (+ standard types: feat, fix, chore, docs, refactor, test, release)
- QA sign-off trailers (`QA-approved-by:`) have never been requested by the EM — don't add unless told
- Memory file changes always go in a **separate** `chore(memory)` commit, not bundled with code changes
