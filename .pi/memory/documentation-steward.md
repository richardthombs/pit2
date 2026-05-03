# Skyler Nguyen — Documentation Steward Memory

## Corpus locations
- User-facing docs: `docs/features.md`, `README.md`
- Role definitions: `.pi/agents/*.md`
- Roster: `.pi/roster.json`
- Project overview (owned by me): `AGENTS.md`
- System prompt: `.pi/SYSTEM.md`

## Key facts about the current system

### Memory model
- Memory is **per-role**, not per-member: `.pi/memory/<role>.md` (e.g. `typescript-engineer.md`)
- All members with the same role share one file
- Firing a member does NOT delete the memory file

### Subagent spawning
- Uses `RpcClient` with `--mode rpc --no-session` (not `--mode json -p`)
- Persistent subprocess per member per session; tasks sent over RPC protocol
- Spawn args: `--no-session --no-context-files --system-prompt "" --append-system-prompt <tmpfile> [--tools ...]`
- Defined in `getOrCreateClient()` in `.pi/extensions/org/index.ts`

### Broker failure counts
- `failureCounts` is a Map on the module-level singleton in `broker.ts`
- NOT cleared on `broker.start()` — persists for the lifetime of the broker process
- Stop + restart does NOT reset failure counts
