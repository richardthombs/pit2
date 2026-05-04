# Recommendation: Dolt Server Mode Adoption for pit2

**Task:** pit2-1rnz.4.3  
**Author:** Emery Vidal (software-architect)  
**Date:** 2026-05-04  
**Status:** Final — ready for EM decision  

**Inputs:**
- pit2-1rnz.4.1 — Mercer Lin's investigation of beads dolt integration (embedded mode internals, process model, checkpoint path, stale-process root causes)
- pit2-1rnz.4.2 — Emery Vidal's research on Dolt server mode mechanics, concurrency, and beads support  
- Source commit: `ac15e099` (gastownhall/beads main)

---

## 1. Root Cause Summary

Two symptoms have been reported. The research resolves both unambiguously.

### Symptom 1: Checkpoint failures / conflicts

**Root cause: concurrent `bd` processes competing on the noms chunk store.**

pit2 uses embedded Dolt mode. Each `bd` command runs the Dolt storage engine **in-process** as a CGO library (`dolthub/driver`). The Dolt library's internal NBS manifest uses optimistic concurrency: each writer reads the current root hash, applies changes, then attempts a CAS-update to the manifest. When two `bd` commands run simultaneously — as happens routinely in pit2's multi-agent coordinator setup (coordinator dispatch + EM `bd list`, or two agents calling `bd create` in parallel) — both writers attempt the CAS simultaneously, one fails, and the failure surfaces as a "checkpoint conflict."

The application-level exclusive lock (`acquireEmbeddedLock()` in `store_factory.go`) was designed for exactly this purpose — but it is **only called from `bd init`**, not from regular commands. Normal embedded mode operation has **no cross-process write serialization whatsoever**.

Additional background pressure: the embedded Dolt engine spins up internal goroutines (stats collection, GC) in each `bd` process. With N simultaneous `bd` processes, there are N sets of these background threads competing on the same storage files.

### Symptom 2: Stale / hanging `bd` processes

**Root cause: `bd` itself is the Dolt engine; slow NBS I/O blocks the `bd` process.**

In embedded mode, `bd` is not just a client — it *is* the Dolt storage layer. Heavy operations (chunk table writes, manifest checkpoints, storage compaction) happen synchronously in the `bd` process and can take 10–13 seconds (documented in bead pit2-36b). When the coordinator's `runBd` timeout fires, it kills the `bd` process — but if the process is mid-checkpoint, it may be stuck in synchronous kernel I/O and hang until the OS delivers the signal or the I/O completes. The result is a "stale" process that must be manually killed.

**Important distinction:** the specific stale `dolt sql-server` process (PID 81989) currently running on this machine belongs to the **rtos project** (which already uses server mode), not pit2. It is an unrelated artifact of a manifest-corruption recovery event in rtos that left a server running against a backed-up data directory. This is a separate operational issue in rtos; it should be addressed by running `kill 81989` and deleting `.beads/dolt-server.pid` in the rtos project, then running `bd doctor`. It does not affect the pit2 decision.

---

## 2. Does Server Mode Fix It?

| Root Cause | Server Mode Response | Assessment |
|---|---|---|
| Concurrent manifest CAS conflicts (multiple `bd` processes) | Single `dolt sql-server` owns NBS files exclusively; `bd` commands are pure MySQL clients; SQL transaction isolation serializes writes inside the server | ✅ **Eliminates** — structurally impossible for two clients to race on the manifest |
| Background embedded engine threads contending on storage | No in-process engine in `bd`; clients issue SQL and close | ✅ **Eliminates** — zero engine threads in `bd` processes |
| `bd` process hanging during slow checkpoint I/O | Checkpoint happens inside the server; `bd` client just waits on the SQL result, then closes the TCP socket | ✅ **Eliminates stale `bd` processes** — client exits immediately after SQL response; server may still be slow, but that's contained |
| rtos stale server (PID 81989) | Unrelated — rtos-specific `recoverCorruptManifest` bug that doesn't kill a server still pointing at the backed-up directory | ❌ **Not pit2's problem** — fix separately in rtos |

**Net assessment:** server mode addresses both of pit2's symptoms at the root, not as workarounds.

The one caveat: a persistent `dolt sql-server` process can itself freeze under extreme concurrent load. The beads repo documents a historical incident (`scripts/repro-dolt-hang/INCIDENT-REPORT.md`) where ~20 agents caused a server deadlock. The root cause was a redundant `tx.Commit()` after `DOLT_COMMIT` plus absent connection timeouts — both since fixed. With those fixes in place, server mode concurrency is sound for pit2's load profile (typically single-digit simultaneous `bd` commands).

---

## 3. Recommendation

**Adopt server mode for pit2.**

The case is clear-cut:

1. Embedded mode's checkpoint conflict problem is structural, not incidental — it cannot be fixed without changing the mode. No application-level patch would be sufficient without modifying beads itself to gate all write commands on `acquireEmbeddedLock()`.

2. The stale-process problem disappears automatically when `bd` stops being the Dolt engine.

3. Beads has production-quality server lifecycle management: auto-start on first `bd` command, PID and port file tracking, orphan cleanup via `KillStaleServers`, manifest-corruption recovery. Operational overhead is low.

4. Migration friction is minimal — the embedded and server-mode formats are the same underlying Dolt storage; no data transformation is required.

---

## 4. Migration Sketch

### Prerequisites

- `dolt` binary installed and in `$PATH` (verify: `dolt version`)
- `dolt config --global user.name` and `user.email` set (beads reads these via `ensureDoltIdentity()`)

### Option A: Environment variable (zero file edits, easiest to trial)

```bash
export BEADS_DOLT_SERVER_MODE=1
export BEADS_DOLT_DATA_DIR=/Users/richardthombs/dev/pit2/.beads/embeddeddolt
```

`BEADS_DOLT_SERVER_MODE=1` overrides the metadata.json mode at the `IsDoltServerMode()` check. `BEADS_DOLT_DATA_DIR` points the server at the existing embedded data directory — no data copy needed.

Add these exports to the shell profile (or to the coordinator's env) and run `bd dolt start` to verify the server starts correctly.

### Option B: Permanent config + data directory move (clean long-term state)

```bash
# 1. Stop all bd activity
# 2. Move data directory to the server-mode default location
mv /Users/richardthombs/dev/pit2/.beads/embeddeddolt \
   /Users/richardthombs/dev/pit2/.beads/dolt

# 3. Edit metadata.json — change "dolt_mode": "embedded" to "dolt_mode": "server"
#    (or remove dolt_mode entirely — server is the default when dolt_mode is absent)
#    Note: bd dolt set mode is currently blocked ("mode is not yet configurable")
#    Direct JSON edit is required

# 4. Start and verify
bd dolt start
bd list --json
```

### Verification Steps (both options)

```bash
# 1. Server starts successfully
bd dolt start
# Expected: "dolt sql-server started on port NNNNN"

# 2. Data is intact
bd list --json | head
# Expected: existing beads are visible

# 3. Concurrent write test — no checkpoint conflicts
for i in 1 2 3; do
  BEADS_DIR=/Users/richardthombs/dev/pit2/.beads bd create -t "server-test-$i" &
done
wait
# Expected: all three beads created successfully, no "checkpoint conflict" errors

# 4. Client exits cleanly after command
time bd list > /dev/null
# Expected: returns in <500ms (not 10–13s), no lingering bd processes
```

### Coordinator Integration

No coordinator code changes are required. All `runBd(...)` calls continue to invoke the `bd` CLI as before. The difference is transparent: `bd` commands become lightweight TCP clients and return quickly. The coordinator's timeout parameters remain valid (and will now almost never be needed).

As a precaution, tune `BEADS_DOLT_READY_TIMEOUT` to at least 60s (the default) in the coordinator's environment, since the very first `bd` command after a server restart may wait up to 60s for the server to initialize its privilege database.

---

## 5. Risks and Open Questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| Installed `bd` binary may differ from HEAD source (flock behaviour, env var names) | Low–Medium | Run `bd version` and compare against `ac15e099` changeset; if older, verify `BEADS_DOLT_SERVER_MODE` env var is honoured |
| `dolt` binary not in PATH in coordinator subprocess environment | Medium | Confirm with `which dolt` inside the coordinator's shell; add to PATH if needed |
| First-start 60s delay surprises coordinator timeout | Low | Set `BEADS_DOLT_READY_TIMEOUT=60`; ensure coordinator does not time out `bd dolt start` itself |
| rtos server-mode `recoverCorruptManifest` bug (doesn't kill server on recovery) | Exists today but unrelated to pit2 | Fix independently in rtos: kill PID 81989, delete `.beads/dolt-server.pid`, run `bd doctor` |
| Server crash during heavy coordinator load | Low (historical bug fixed) | Beads auto-restarts a crashed server on next `bd` command; transient failure, coordinator retry handles it |
| Option B (mv) risks if any running process has a file handle open | Low (just stop bd activity first) | Use Option A for trial; only do Option B during a quiet maintenance window |

**No spike or proof-of-concept is needed before committing.** The migration is low-risk, trivially reversible (revert env vars or metadata.json edit), and beads has production-level server mode support. The blocking question — does the installed `bd` version support `BEADS_DOLT_SERVER_MODE`? — can be answered with a one-line test before any data is touched.

---

## Decision

**Recommendation: Proceed with Option A first** (env vars, no data move). This allows validation against the live pit2 dataset with zero risk and easy rollback. If stable over one coordinator session, promote to Option B for a clean permanent configuration.

Both problems (checkpoint conflicts, stale processes) will be resolved structurally once server mode is active.

## Operations Note
Set `BEADS_DOLT_READY_TIMEOUT=60` in the shell environment where pi is launched.
This env var flows automatically to all bd child processes. First server start may
take up to 60s; subsequent bd commands connect in milliseconds via TCP.
