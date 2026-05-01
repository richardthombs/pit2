# Finley Park — Memory

## Project: pit2

### Key design docs
- `.pi/docs/design-beads-integration-b.md` — detailed Integration B design (broker, labels, broker.ts pseudocode, ADR-005). Status: Proposed.
- `.pi/docs/design-beads-scalability.md` — full scalability analysis: 7 bottlenecks (B1–B7), 4 integration tiers (A–D), coverage matrix, limitations.
- `.pi/docs/spec-beads-integration-a.md` — Integration A implementation spec (status: implemented).
- `.pi/docs/beads-em-reference.md` — verified bd CLI reference (authored by Mercer Lin).

### Beads integration status
- **Integration A** — implemented. 7 tools in `index.ts`. EM-only writer, embedded mode.
- **Integration B** — proposed/not implemented. Adds `broker.ts` (`.pi/extensions/org/broker.ts`), broker hooks in `bd_task_create` / `bd_task_update`, `bd_broker_start` / `bd_broker_stop` tools, `role` param on `bd_task_create`.
- **Integration C/D** — not implemented, no spec yet.

### Critical implementation details
- Labels (`--label <slug>`) are the role routing mechanism — NOT the description field. `labels[]` is present in `bd ready --json` response; no `bd show` needed for role lookup.
- `bd show --json` and `bd update --json` and `bd close --json` all return an **array** `[{...}]` — must parse with `[0]`.
- `bd dep add <blocked-id> <blocker-id>` — first arg IS the blocked task (counterintuitive).
- `--status=open,in_progress` comma-separated, do NOT repeat the flag.
- `bd ready` includes epics — always pass `--type=task`.
- `provides:` prefix on labels causes hard failure. Bare slugs only.
- `description` field in `bd show` is `omitempty` — check key presence, not truthiness.

### Architecture: broker vs delegate
- `delegate` tool: EM in critical path for every task. Results return to EM context. EM manually closes beads.
- Broker: EM populates queue, broker auto-dispatches when tasks become ready. Broker closes beads. Results go into bead `reason` field; EM pulls on demand. EM notified of failures via `pi.sendUserMessage`.
- Both share the same `memberState` map and `resolveOrScale`. `resolveOrScale` must be hoisted to module scope (currently inside delegate closure) for broker to use it.
- Write serialisation: per-cwd Promise chain for all `bd` writes. `runTask` (agent execution) is NOT serialised.

### Non-obvious facts
- Broker lives in `.pi/extensions/org/broker.ts` (inside org extension, not separate) — intentional tight coupling to `resolveOrScale`, `runTask`, `memberState`, `runBd`.
- `bd_broker_start` opt-in; broker is NOT active by default.
- Integration B design (as written) uses embedded mode + broker as sole writer — NOT server mode. The scalability doc's description of Integration B using server mode is an earlier framing; the detailed design doc (integration-b.md) resolved this to broker-mediated embedded mode.
- B6 (name pool ceiling, 30 names) is NOT addressed by any beads integration tier.
