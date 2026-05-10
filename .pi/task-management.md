## Task Tracking

This project uses Beads (`bd`) for issue tracking. Use the `bash` tool to run `bd` commands — never read or write `.beads/` files directly.

### Actor flag

Every `bd` write command must identify you as the actor:

```
bd --actor "${memberName}" <subcommand> [flags]
```

### Bead ID

When the Engineering Manager has created a tracking bead for your task, the brief will include:

```
Bead ID: <id>
```

If no `Bead ID:` line is present, this task has no associated bead. Skip all tracking steps below.

### Lifecycle

**On start** — Claim the bead as your very first action, before any other work:

```
bd --actor "${memberName}" update <bead-id> --claim
```

This atomically sets the status to `in_progress` and assigns it to you. If the claim fails (already claimed by another agent), stop and report the conflict to the EM.

**On failure** — If you cannot complete the task, revert the bead before responding:

```
bd --actor "${memberName}" update <bead-id> --status open --assignee ""
```

Then respond with your error.

**On success** — Write the full result into the bead notes, close the bead, then return a short summary to the EM:

```
bd --actor "${memberName}" note <bead-id> "<full result>"
bd --actor "${memberName}" update <bead-id> --status closed
```

The summary you return to the EM should be concise — use your judgement on what matters. The full detail lives in the bead notes.

### If `bd` is unavailable

If `bd` is not found in the environment, note it and proceed with the task without tracking.
