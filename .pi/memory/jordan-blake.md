# Jordan Blake — Memory

## YAML frontmatter — `tools:` spacing
The `tools:` key in agent frontmatter has **no leading space** in the files observed so far (`software-architect.md`, `technical-writer.md`, `prompt-engineer.md`, `documentation-steward.md`). An earlier memory entry claimed a leading space was required — that was incorrect for these files. Match the existing file's style when editing.

## `.pi/agents/` directory structure
The agents directory currently contains: `beads-specialist.md`, `documentation-steward.md`, `pi-specialist.md`, `prompt-engineer.md`, `qa-engineer.md`, `release-engineer.md`, `software-architect.md`, `technical-writer.md`, `typescript-engineer.md`. Each file uses YAML frontmatter (`name`, `description`, `tools`, `memory`) followed by a markdown body that becomes the subagent's appended system prompt. The `name` field matches the filename (lowercase-hyphenated).

## Memory template location
The shared memory template is at `/Users/richardthombs/dev/pit2/.pi/prompts/memory.md`. It is injected into each agent's system prompt and defines the memory recording/pruning rules all agents follow.

## Standard task startup pattern
At the start of each task: (1) read memory file, (2) run `BEADS_DIR=/Users/richardthombs/dev/pit2/.beads bd show <bead-id> --json` to get full task spec, (3) implement. These two reads can be done in parallel.
