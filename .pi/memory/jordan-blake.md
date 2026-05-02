# Jordan Blake — Memory

## SYSTEM.md — broker-only dispatch rewrite (beads-integration branch)
The `## How to Work` section was fully replaced (delegate→beads+broker). Key structural decisions:
- Merged the two QA paragraphs (spec §8.2 had them separate but were redundant)
- Title convention embedded inline in the "Include all context" bullet, not as a separate heading
- "Design vs Notes" section renamed to "Fields: description, design, notes" for the description-first convention
- "Your Team" paragraph still has two `delegate` references — left untouched per "make no other changes" scope; flagged as follow-up needed

## YAML frontmatter — `tools:` spacing
The `tools:` key in agent frontmatter has **no leading space** in the files observed so far (`software-architect.md`, `technical-writer.md`, `prompt-engineer.md`, `documentation-steward.md`). An earlier memory entry claimed a leading space was required — that was incorrect for these files. Match the existing file's style when editing.
