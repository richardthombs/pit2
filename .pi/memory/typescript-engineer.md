# Remy Osei — Memory

## Codebase

- Main extension file: `.pi/extensions/org/index.ts` (~1700 lines) — contains roster management, RPC client lifecycle, beads widget rendering, and all tool/command registrations.
- Supporting files: `.pi/extensions/org/broker.ts`, `.pi/extensions/org/utils.ts`
- Agent role definitions: `.pi/agents/<role>.md` (frontmatter + body = system prompt)
- Roster stored at `.pi/roster.json`
- Role-scoped memory files: `.pi/memory/<role>.md` (shared across members of same role)

## TypeScript/Compilation

- Extensions loaded via `jiti` — no compilation step needed; `tsc --noEmit` for type-checking only
- Many pre-existing `implicit any` and missing-module errors in `tsc` output — not introduced by my changes, safe to ignore when verifying a targeted edit

## Beads Widget

- `BeadsTree` holds `nodes: BeadsTreeNode[]` (root epics only) and `orphans: BeadItem[]` (tasks without an epic parent in the list)
- `BeadsTreeNode` has `bead`, `children`, `tasks` — supports recursive nesting at any depth
- `buildBeadsLines` uses a recursive `renderNode(node, indentStr, isLast, depth)` with `MAX_DEPTH = 4`
- `indentStr` accumulates by appending `"│   "` (not last) or `"    "` (last) at each depth level — produces correct box-drawing continuation lines
- `itemIdx` is unified across `children` and `tasks` in `renderNode` so the last item (regardless of type) correctly gets `"└─ "`
