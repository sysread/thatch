# Hygiene System

Behavior is described in runtime terms; the host-surface registrations and the HostCapabilities mapping are in [opencode-plugin.md](opencode-plugin.md).

Store maintenance signals surfaced at session start. The plugin never deletes
memories itself — it surfaces problems and lets the agent tend the store.

## What it does

- Four signals per store: duplicate candidates, prediction duplicate pairs,
  stale entries, orphaned branch memories
- Covers both stores a session scans: the project store AND global
- Runs at session start on all three hosts
- Only non-zero signals are reported (healthy stores stay silent)
- Per-store failure isolation: a store whose scan throws logs
  `[thatch] hygiene report for <store> failed` to stderr and drops only
  its own line; the other store still renders
- Standalone `thatch hygiene` CLI command for manual inspection

## How it works

### Store coverage

Every project session scans `[repo, "global"]` for nudges, so the hygiene
report covers both stores. Each store's signals print under their own
`Store "<name>":` sentence. The orphaned-branch check runs only for the
project store (the global store has no branch scoping).

### Four signals

1. **Duplicate candidates** — `db.findDuplicates(store)`: near-duplicate memory
   pairs via cosine >= 0.83 (`DEDUP_PAIR_THRESHOLD`, shared with the
   `find_duplicates` tool) pending review. The hygiene report is a count-only
   summary,
   not the full pair list.

2. **Prediction duplicate pairs** — `db.findPredictionDuplicates(store)`:
   prediction-store near-duplicates pending review. When there are at
   most 5 pairs (`PREDICTION_PAIR_IDS_CAP`), the report line names each
   pair's two prediction ids, so `prediction_mark_checked` can settle
   them without a listing call.

3. **Stale entries** — `db.staleEntryCount(store, cutoff)`: memories neither
   updated nor recalled in 60+ days (`STALE_DAYS = 60`). The window is
   short because the recall nudge renders at most 5 memories: a stale
   corpus crowds fresh matches out of that list, so staleness is the
   cheapest consolidation lever. Uses
   `recall_count`
   and `last_recalled_at` columns. Archived memories are excluded
   (`WHERE archived = 0`).

4. **Orphaned branch memories** (project store only) —
   `db.branchesInStore(store)` cross-references
   against `git.listBranches(worktree)`. Memories scoped to branches that no
   longer exist. `listBranches` reads `refs/heads` AND `refs/remotes`
   (remote name stripped), so a branch pushed with an open PR but no local
   checkout is not flagged; a stale tracking ref only delays flagging a
   truly-deleted branch until prune. Skipped when the worktree is not a git
   repo (`listBranches` returns `[]`) to avoid false positives — without a git
   repo, every branch-scoped memory would look orphaned. Archived memories
   are excluded: a branch whose entries are all archived does not appear,
   so the branch list matches the count (`entryCountForBranches` also
   skips archived entries).

### When it runs

- **opencode**: `session.created` event for top-level sessions (no `parentID`).
  The hygiene report is appended to the session-start reminder sent via
  `promptSession` (a noReply delivery).
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

- The opencode plugin's session-start hook (`src/runtime.ts`)
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
- `src/db.ts` — `findDuplicates`, `findPredictionDuplicates`, `staleEntryCount`, `branchesInStore`
- `src/git.ts` — `listBranches`
- `bin/thatch` — `hygiene` and `reminder` subcommands

## Key invariants

- The plugin never deletes memories. It surfaces problems; the agent tends the
  store.
- Only non-zero signals are reported.
- Orphan check is skipped outside a git repo.
- A branch that exists only as a remote-tracking ref (pushed, PR open, no
  local checkout) is not orphaned; a stale tracking ref only delays the
  nudge until prune.
- Archived memories are excluded from the three entry-table checks:
  duplicates, staleness, and the orphaned-branch list. The
  prediction-duplicate scan reads the predictions table, which has no
  archived concept.
