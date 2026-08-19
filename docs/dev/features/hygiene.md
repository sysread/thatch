# Hygiene System

Store maintenance signals surfaced at session start. The plugin never deletes
memories itself — it surfaces problems and lets the agent tend the store.

## What it does

- Three signals: duplicate candidates, stale entries, orphaned branch memories
- Runs at session start on all three hosts
- Only non-zero signals are reported (healthy stores stay silent)
- Standalone `thatch hygiene` CLI command for manual inspection

## How it works

### Three signals

1. **Duplicate candidates** — `db.findDuplicates(repo)`: near-duplicate memory
   pairs via cosine >= 0.85 pending review. These are the same pairs that
   `find_duplicates` surfaces, but the hygiene report is a count-only summary,
   not the full pair list.

2. **Stale entries** — `db.staleEntryCount(repo, cutoff)`: memories neither
   updated nor recalled in 90+ days (`STALE_DAYS = 90`). Uses `recall_count`
   and `last_recalled_at` columns. Archived memories are excluded
   (`WHERE archived = 0`).

3. **Orphaned branch memories** — `db.branchesInStore(repo)` cross-references
   against `git.listBranches(worktree)`. Memories scoped to branches that no
   longer exist. Skipped when the worktree is not a git repo
   (`listBranches` returns `[]`) to avoid false positives — without a git
   repo, every branch-scoped memory would look orphaned.

### When it runs

- **opencode**: `session.created` event for top-level sessions (no `parentID`).
  The hygiene report is appended to the session-start reminder sent via
  `client.session.prompt`.
- **Claude Code**: `SessionStart` hook → `thatch reminder` (runs
  `hygieneReport`, appends to reminder text, prints to stdout).
- **Cursor**: `sessionStart` hook → `thatch reminder --json` (same, wrapped as
  `additional_context` JSON).
- **Standalone**: `thatch hygiene` CLI command (prints report or
  "Store is healthy." to stdout).

### Report format

Only non-zero signals are reported. A healthy store produces no output
(silent). The report is appended to the session-start reminder with
instructions for the agent to tend the store when convenient.

### Shared implementation

`hygieneReport(db, repo, worktree)` in `src/hygiene.ts` is shared by:

- The opencode plugin's session-start hook (`src/index.ts`)
- The CLI's `thatch reminder` and `thatch hygiene` subcommands (`bin/thatch`)

## Interactions with other features

- [Deduplication](deduplication.md): hygiene reports the count of pending dedup
  pairs; the agent uses `find_duplicates` to see the actual pairs.
- [Memory store](memory-store.md): staleness uses `recall_count` and
  `last_recalled_at`; orphan check uses the `branch` column.
- Session lifecycle: hygiene runs at `session.created` for top-level sessions.
- Nudge pipeline: hygiene is part of the session-start reminder, not the
  per-message nudge pipeline.

## Source files

- `src/hygiene.ts` — `hygieneReport` function
- `src/db.ts` — `findDuplicates`, `staleEntryCount`, `branchesInStore`
- `src/git.ts` — `listBranches`
- `bin/thatch` — `hygiene` and `reminder` subcommands

## Key invariants

- The plugin never deletes memories. It surfaces problems; the agent tends the
  store.
- Only non-zero signals are reported.
- Orphan check is skipped outside a git repo.
- Archived memories are excluded from staleness and duplicate checks.
