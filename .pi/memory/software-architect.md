# Emery Vidal — Architect Memory

## pit2 Bead Tooling (as of 2026-05-02)

Current EM tools: `bd_workstream_start` (creates epic), `bd_task_create` (epic_id, description, role, blocked_by), `bd_dep_add` (adds blocks dependency).

## Multi-Level Epic Nesting Design (pit2-zvq.3)

Recommended for 3-level hierarchy (session epic → workstream sub-epics → tasks):

- **Sub-epic rule:** create one when a request yields ≥2 tasks sharing a coherent theme/workstream.
- **Tool change:** add optional `parent_id` to `bd_workstream_start` (Option A). No new tools needed.
- **`bd_dep_add`:** should gain `--type=parent-child` to allow post-hoc parent attachment (recovery path).
- **`buildBeadsLines` widget:** replace two-pass epic/task loop with recursive `renderNode(bead, depth)`.
- **Broker cascade:** one-level `bd ready` cascade is fine — EM drives state transitions explicitly.
