---
role: documentation-steward
last_updated: 2026-05-05
---

## Codebase Landmarks

- `docs/features.md` — formal feature specs (my primary doc)
- `AGENTS.md` — concise user/EM guide (keep token-lean)
- `README.md` — technical reference (technical-writer's domain, not mine)
- `.pi/extensions/org/index.ts` — core extension; source of truth for behaviour
- `.pi/extensions/org/utils.ts` — pure utilities (memory helpers, token formatting)
- `.pi/agents/*.md` — 9 roles: software-architect, typescript-engineer, qa-engineer, prompt-engineer, pi-specialist, documentation-steward, technical-writer, release-engineer, beads-specialist

## Decisions

- Per-member memory (not per-role) is the current system — files at `.pi/memory/<name>.md`, always-on, self-managed by agents via their tools
- Async mode defaults to ON (`asyncMode = true` on startup and session reset)
- hire and fire are both slash commands AND LLM-callable tools
- Auto-scaling: delegate by role auto-hires when all role members are busy

## Pitfalls

- features.md can be out-of-date after implementation changes — always re-read before auditing (the file may have been partially updated already)
- `appendToRoleMemory`, `extractMemoryEntries`, `getMemoryPath` (role-based), and `memory: true` frontmatter parsing are dead code in index.ts — never called. The old role-based MEMORY block system was replaced by per-member self-managed memory. Report to technical writer / TypeScript engineer.
- AGENTS.md is loaded into LLM context windows — keep every line earning its tokens

## Conventions

- "Per-member memory" (not "per-role memory") is correct terminology since the 2026-05 implementation
- Memory block heading in agent prompts: `## Your Identity & Memory`
- Memory files always injected (name + path + instructions), file contents appended only if file exists
