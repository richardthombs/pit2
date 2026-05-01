# Skyler Nguyen — Memory

## Key File Locations

- `AGENTS.md` — User guide for the EM; I own this file (loaded into every LLM context — keep concise)
- `docs/features.md` — Formal feature specifications for all user-visible features
- `.pi/extensions/org/index.ts` — Core org extension (all logic: delegate, hire/fire, widget, memory, broker tools)
- `.pi/extensions/org/broker.ts` — Broker class (Integration B); singleton exported as `broker`
- `.pi/prompts/memory.md` — Memory injection template (uses [name] and [path] substitutions)
- `.pi/memory/<member-id>.md` — Per-member memory files (member ID = name lowercased, spaces → hyphens)

## Beads Integration (workstream persistence)

- Seven `bd_*` tools registered in `index.ts` around line 1122; `bd_broker_start`/`bd_broker_stop` at ~1555
- Auto-init via `bd init --stealth` at session start; `beadsReady` map tracks readiness per cwd
- `.beads/` directory lives at project root (runtime artifact, not source)
- Documented in: `docs/features.md` (full specs for both Beads and Broker), `AGENTS.md` (concise tables), `README.md` (key files + architecture)
- Guidance to EM on when/how to use lives in `.pi/SYSTEM.md` "Workstream State (Beads)" section

## Broker (Integration B)

- Class defined in `broker.ts`; module-level singleton `broker` imported into `index.ts`
- Dispatches labelled (`role`) beads tasks to available team members autonomously
- Uses `resolveOrScale` (same as delegate) to find/hire members; serialises bd writes via per-cwd `writeQueue`
- Result capture: git commit SHA / notes ≤40 KB / `.pi/task-results/<id>.md` for larger outputs
- 3-failure defer: task set to `deferred`, EM notified; failure counts reset on `broker.start()`
- Unlabelled tasks = EM-owned; broker never touches them

## Memory is per-MEMBER, not per-role

- Injected unconditionally for ALL members
- Template from `.pi/prompts/memory.md`; content appended to system prompt after template block
- Firing a member deletes their memory file
- `memory: true` frontmatter flag is vestigial — loaded into AgentConfig but NOT checked in runTask

## Async Mode

- Default is ON (`let asyncMode = true` in index.ts)

## Subagent Spawning (Context Isolation)

- Args include `--system-prompt ""` and `--no-context-files`
- Prevents subagents from receiving `.pi/SYSTEM.md` and `AGENTS.md`

## Widget Streaming

- While `status === "working"` and `state.streaming` is set: shows live snippets
- Tools shown as `⚙ <tool-name>`; text shows last meaningful line (up to 80 chars)
- Refresh interval: 150ms; done/error states show task description instead
