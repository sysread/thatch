# Hygiene

Thatch checks your memory store for maintenance issues at the start of
every session. The agent sees the report and can tend the store when
convenient. Thatch never deletes memories on its own.

## How it works

At session start, thatch runs three checks against the current project
store. Only non-zero signals are reported. A healthy store stays
silent.

### Duplicate candidates

Memories whose content is very similar (cosine similarity >= 0.85).
These are the same pairs that `thatch_find_duplicates` surfaces. The
hygiene report shows the count, not the full list. To see the actual
pairs, the agent calls `thatch_find_duplicates`.

See [deduplication.md](deduplication.md) for the full dedup workflow.

### Stale entries

Memories that have not been updated or recalled in 90+ days. The check
uses `recall_count` and `last_recalled_at` columns, which are stamped
by `thatch_memory_recall` and CLI `thatch search`. Archived memories
are excluded.

If a memory is stale but still accurate, the agent can recall it
(which resets the timer). If it is stale and wrong, the agent can
update it with `overwrite: true` or delete it with
`thatch_memory_forget`.

### Orphaned branch memories

Memories scoped to a git branch that no longer exists. The check
cross-references the `branch` column against `git branch --list`. This
check is skipped when the working directory is not a git repo, so it
never produces false positives outside a repo.

To fix orphaned memories, the agent can consolidate them into
project-wide memories (re-save without the `branch` param) or archive
them.

## CLI

```bash
thatch hygiene    # print the hygiene report standalone
```

The session-start reminder (`thatch reminder`, called automatically by
hooks) also includes the hygiene report when any signal is non-zero.

## What you see

You do not see the hygiene report directly. The agent sees it in the
session-start reminder and may mention it: "Your store has 3 duplicate
candidates and 2 stale memories. Want me to clean those up?"

On opencode, the reminder is a synthetic prompt injected at session
start. On Claude Code and Cursor, it is printed by the SessionStart
hook and fed into the session as context.

## Limitations

- The plugin never deletes memories. It surfaces problems; the agent
  decides what to do.
- Stale entries use a 90-day window (hardcoded `STALE_DAYS = 90`).
  There is no configuration for this.
- The duplicate threshold (0.85) is higher than the recall nudge
  threshold (0.55) because "duplicate" is a stronger claim than
  "relates to."
- Orphaned branch check is skipped outside a git repo.

See [memory.md](memory.md) for the memory system and
[deduplication.md](deduplication.md) for the dedup workflow.
