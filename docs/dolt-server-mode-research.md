# Dolt Server Mode Research: Process Model, Concurrency, and Fit for Beads

**Task:** pit2-1rnz.4.2  
**Author:** Emery Vidal (software-architect)  
**Date:** 2026-05-04  
**Status:** Complete — feeds into synthesis task pit2-1rnz.4.3

---

## 1. Dolt Server Mode Mechanics

### Process Model

`dolt sql-server` is a persistent, long-lived process that speaks the MySQL wire protocol. It is started once and accepts TCP (or Unix socket) connections from clients indefinitely. Clients connect, run SQL, and disconnect — the server stays alive between commands.

**Beads implementation** (source: [`doltserver.go`](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/internal/doltserver/doltserver.go)):

```go
cmd := exec.Command(doltBin, "sql-server", "-H", host, "-P", strconv.Itoa(port), "--loglevel=warning")
cmd.Dir = doltDir  // the .dolt/ working directory
cmd.SysProcAttr = procAttrDetached()  // detached from parent process
```

The server is started with `procAttrDetached()` so it survives the `bd` command that started it. Beads writes the server PID to `.beads/dolt-server.pid` and the actual listening port to `.beads/dolt-server.port` for subsequent commands to reconnect.

Each subsequent `bd` command connects via MySQL DSN (`host:port`, `root` user, no password by default), issues SQL, commits, and closes the connection. The server process keeps running.

### Auto-Start Lifecycle

Beads implements a full server lifecycle manager:

- **`EnsureRunning(beadsDir)`** — the main entry point; checks if server is running (via PID file + process check), starts it if not. Protected by an exclusive `flock` on `.beads/dolt-server.lock` to prevent concurrent start races.
- **`Start(beadsDir)`** — allocates an ephemeral OS port (via `net.Listen(":0")`), spawns `dolt sql-server`, polls TCP until the server accepts connections (default 10s timeout, configurable via `BEADS_DOLT_READY_TIMEOUT`).
- **`Stop(beadsDir)`** — flushes uncommitted working set changes first (via `CALL DOLT_COMMIT`), then sends graceful shutdown.
- **`KillStaleServers(beadsDir)`** — called at the start of `Start()` inside the lock; finds orphan dolt processes sharing the data directory and kills them.

Port allocation uses ephemeral OS ports to eliminate birthday-problem collisions (GH#2098, GH#2372). The port is stored in `.beads/dolt-server.port` (gitignored).

### Concurrency Model

The dolt sql-server handles multiple simultaneous clients using standard MySQL session semantics: each connection is isolated, writes use standard MySQL transaction isolation (committed reads by default). Commits serialize via Dolt's internal manifest write logic — there is one manifest writer at a time, inside the server process.

This is categorically different from embedded mode where multiple OS-level processes compete to write the same NBS manifest files.

---

## 2. The Two Problems — Root Cause Analysis from Code

### Current pit2 Configuration

`/Users/richardthombs/dev/pit2/.beads/metadata.json`:
```json
{
  "backend": "dolt",
  "dolt_mode": "embedded",
  "dolt_database": "pit2"
}
```

pit2 is in **embedded Dolt mode**. This means the `dolthub/driver` Go library (CGO) runs the Dolt engine in-process within each `bd` command. No external `dolt` binary is spawned for normal operations. Data lives at `.beads/embeddeddolt/pit2/.dolt/`.

### Problem 1 — Checkpoint Conflicts

**Root cause:** Embedded mode has no cross-process serialization for regular `bd` commands.

`acquireEmbeddedLock()` in [`store_factory.go`](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/cmd/bd/store_factory.go#L50-L59) acquires an exclusive flock — **but it is only called from `bd init`** (line 713 of `init.go`). Regular commands (`bd ready`, `bd create`, `bd list`, etc.) call `newDoltStoreFromConfig()` → `embeddeddolt.Open()` directly with no flock.

When two `bd` commands run simultaneously (e.g., coordinator dispatching while EM runs `bd list`), both processes open the embedded Dolt engine against the same `.dolt/noms/` chunk store. Dolt's internal manifest uses optimistic concurrency — each writer reads the current root hash, makes changes, then tries to CAS-update the manifest. When two processes attempt to commit at the same moment, one fails with a manifest conflict. This surfaces as a "checkpoint failure."

Additionally, Dolt's embedded engine runs internal background threads (stats collection, GC). When multiple instances run concurrently, these threads also compete on the same files.

### Problem 2 — Stale Processes

**Root cause:** `bd` processes themselves hang during slow embedded-mode operations.

The embedded Dolt engine does all NBS I/O synchronously in the `bd` process. Heavy operations — writing chunk tables, checkpointing the manifest, compacting storage — can take 10–13 seconds (the `pit2-36b` timeout bead documents exactly this). When the coordinator's `runBd` timeout fires, it sends SIGPIPE or kills the `bd` process, but the process may be stuck in the embedded engine's synchronous I/O. The process appears "hung" until the OS delivers the kill signal or the I/O eventually completes.

There are no separate external `dolt` processes in embedded mode — the "stale processes" are `bd` processes themselves stuck in the embedded engine. They must be manually killed when the engine hangs.

---

## 3. Does Server Mode Fix These Problems?

### Checkpoint Conflicts — Yes, definitively

In server mode, **there is exactly one process with write access to the `.dolt/noms/` files**: the persistent `dolt sql-server`. All `bd` commands connect as MySQL clients. SQL transactions handle isolation. There is no manifest-level optimistic locking competition between OS processes. The checkpoint (Dolt commit) happens inside the server; clients just receive a success/failure SQL result.

From `store_factory.go`:
```go
// Server mode: connects via MySQL TCP — the server handles concurrency
if cfg.ServerMode {
    return dolt.New(ctx, cfg)  // MySQL TCP connection
}
// Embedded mode: opens Dolt engine in-process — NO cross-process locking
return embeddeddolt.Open(ctx, beadsDir, cfg.Database, "main")
```

### Stale Processes — Yes, structurally

In server mode, each `bd` command opens a TCP connection to the already-running server, runs SQL, and closes. TCP close is near-instant. Even if the `runBd` timeout fires and kills the `bd` process, it leaves no dolt process behind. The server continues serving other clients.

The slow checkpoint operations still happen, but they happen **inside the server**, not blocking the `bd` client process. From the client's perspective, a `bd create` is: open TCP → `INSERT` → `CALL DOLT_COMMIT` → close TCP. The commit is fast because the server's single writer serializes commits without manifest conflict overhead.

---

## 4. What It Would Take to Enable Server Mode for pit2

### Configuration Changes Required

**Option A — Environment variable (no file edits)**:
```bash
export BEADS_DOLT_SERVER_MODE=1
export BEADS_DOLT_DATA_DIR=/path/to/pit2/.beads/embeddeddolt
```

`BEADS_DOLT_SERVER_MODE=1` flips `IsDoltServerMode()` to true (checked before metadata.json). `BEADS_DOLT_DATA_DIR` is needed because embedded mode stores data at `.beads/embeddeddolt/` but server mode defaults to `.beads/dolt/`.

**Option B — metadata.json edit**:
Change `.beads/metadata.json` from `"dolt_mode": "embedded"` to `"dolt_mode": "server"`. Also requires `BEADS_DOLT_DATA_DIR` or moving the data directory.

Note: `bd dolt set mode` is currently blocked with "Error: mode is not yet configurable" ([`dolt.go` line ~320](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/cmd/bd/dolt.go#L320)). Direct metadata.json edit or env var is required.

### Data Directory Reconciliation

This is the key migration friction point:

| Mode | Data path |
|------|-----------|
| Embedded (current) | `.beads/embeddeddolt/pit2/.dolt/` |
| Server (target) | `.beads/dolt/pit2/.dolt/` |

The simplest path is **Option A with BEADS_DOLT_DATA_DIR** pointing to the existing embedded data directory. The server opens it directly — it's the same underlying Dolt storage format. No data migration needed.

Alternatively, move/symlink the data directory:
```bash
mv .beads/embeddeddolt .beads/dolt
```
Then remove the `dolt_mode` override from metadata.json. The server will find `pit2/` under `.beads/dolt/` automatically.

### Operational Requirements

- `dolt` binary must be installed and in `$PATH` on the machine
- `dolt config --global user.name` and `user.email` must be set (beads auto-sets these from git config — see `ensureDoltIdentity()`)
- First startup takes up to 60s if the stats engine and privileges database need initialization (`BEADS_DOLT_READY_TIMEOUT=60` is the current default)
- The server auto-starts on first `bd` command (ServerModeOwned — beads manages the lifecycle)
- The server is restarted automatically if it crashes
- PID and port files live in `.beads/` (gitignored)

### For the pit2 Multi-Agent Setup

The coordinator (`index.ts`) runs many concurrent `bd` commands. In server mode:
- All `bd` commands from all concurrent agents/brokers connect to the same server
- No flock contention between parallel `bd list`, `bd ready`, `bd show`, `bd create` calls
- The server handles concurrent reads with full parallelism (reads don't block each other)
- Writes (create, update, close) are serialized at the SQL transaction level — proper ACID semantics

Shared server mode (`BEADS_DOLT_SHARED_SERVER=1`) is an option but is designed for multiple projects on the same machine. For a single project like pit2, per-project managed server (`ServerModeOwned`) is the right choice.

---

## 5. Trade-offs

| | Embedded (current) | Server (proposed) |
|-|---------------------|-------------------|
| Concurrent access | **❌ No cross-process locking** | ✅ Full MySQL transaction isolation |
| Checkpoint conflicts | **❌ Possible when 2+ bd commands run** | ✅ Eliminated — single writer in server |
| Stale processes | **❌ bd hangs during slow NBS I/O** | ✅ Client exits fast; server handles I/O |
| Dependency | CGO + embedded engine (statically linked) | Requires `dolt` binary in PATH |
| Startup latency | ~1-3s per command (engine init) | ~ms per command (TCP connect) — but 1-60s for first server start |
| Failure modes | Process hang, NBS corruption | Server crash, port conflict (both auto-recovered by beads) |
| Log file | None | `.beads/dolt-server.log` (rotated, warning-level only) |
| Data migration | — | Path change needed (mitigated by BEADS_DOLT_DATA_DIR) |
| `bd dolt killall` | N/A | Cleans up orphan server processes |

---

## 6. Recommendation

**Switch pit2 to server mode.** The evidence is decisive:

1. The embedded mode's lack of cross-process write serialization is the direct cause of checkpoint conflicts. Server mode eliminates this structurally.
2. The stale-process problem (stuck `bd` processes) is caused by `bd` being the Dolt engine. In server mode, `bd` is just a MySQL client — it can't get stuck in Dolt I/O.
3. Beads has production-quality server lifecycle management (auto-start, PID tracking, stale-server cleanup, port collision handling, manifest corruption recovery). The operational risk is low.
4. The migration friction is minimal: set `BEADS_DOLT_DATA_DIR` and `BEADS_DOLT_SERVER_MODE=1` (or move the data dir), and run `bd dolt start` once.

**Key implementation steps:**
1. Decide whether to use env vars or metadata.json edit
2. Reconcile data directory (either point `BEADS_DOLT_DATA_DIR` at the existing embeddeddolt path, or `mv .beads/embeddeddolt .beads/dolt`)
3. Remove `"dolt_mode": "embedded"` from metadata.json
4. Run `bd dolt start` to verify the server starts against the existing data
5. Run `bd list --json` to verify data is intact
6. Run a concurrent stress test (two `bd create` calls in parallel) to confirm no conflicts

**Open questions for synthesis task:**
- Mercer's investigation (pit2-1rnz.4.1) may reveal whether the flock IS being called for regular commands in the current beads version installed on this machine (vs. the HEAD version in the repo). The code I reviewed is HEAD; the installed version may differ.
- Whether `bd dolt set mode` blockage (`"mode is not yet configurable"`) has been addressed in the installed version.
- Whether there are any compatibility issues between the embedded-format databases and the server-mode database format that Mercer may have observed.

---

## Source References

All code references from commit [`ac15e099`](https://github.com/gastownhall/beads/tree/ac15e099e33de515406f6ddb851c202cdedaf607) (HEAD of gastownhall/beads at time of research):

- Server lifecycle: [`internal/doltserver/doltserver.go`](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/internal/doltserver/doltserver.go)
- Server mode detection: [`internal/doltserver/servermode.go`](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/internal/doltserver/servermode.go)
- Store factory (embedded vs server selection): [`cmd/bd/store_factory.go`](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/cmd/bd/store_factory.go)
- Embedded Dolt open + connection config: [`internal/storage/embeddeddolt/open.go`](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/internal/storage/embeddeddolt/open.go)
- Embedded flock (only for bd init): [`internal/storage/embeddeddolt/flock.go`](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/internal/storage/embeddeddolt/flock.go)
- Config file (IsDoltServerMode, env vars): [`internal/configfile/configfile.go`](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/internal/configfile/configfile.go#L244)
- Mode-change blockage: [`cmd/bd/dolt.go`](https://github.com/gastownhall/beads/blob/ac15e099e33de515406f6ddb851c202cdedaf607/cmd/bd/dolt.go)
