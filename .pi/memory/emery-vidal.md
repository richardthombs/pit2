# Emery Vidal — Memory

## Broker / Bead Gotchas

- **"issue not found" on `bd close`** may be a false alarm race condition: the task was already closed by an earlier attempt. Before treating it as data loss, run `bd show <id> --json` to verify status. If `status: closed` and `close_reason` is set, the result is safe.
