# Deduplication System

Agent-driven detection and resolution of duplicate memories. The system
surfaces candidates; the agent decides what to do.

## What it does

- `find_duplicates` tool: cosine similarity pairs, grouped into
  connected-component clusters
- `dedup_mark_checked` tool: records a pairwise verdict so `find_duplicates`
  stops re-reporting
- Automatic verdict clearing: overwriting either memory clears the verdict
- `thatch-dedup-classifier` skill: classifies the relationship and reconciles
  pairs

## How it works

### find_duplicates (tool)

- Parameters: `store` (optional, default project store), `threshold`
  (optional, default 0.85)
- Finds memory pairs whose embeddings exceed the cosine similarity threshold
- Groups related pairs into connected-component clusters: a cluster of 3+
  labels usually means one topic fragmented across entries that should be
  consolidated
- Pairs already resolved via `dedup_mark_checked` are skipped
- Output: clustered rendering — "Cluster of N:" then
  `[score:N] labelA <-> labelB` lines
- Read-only

### dedup_mark_checked (tool)

- Parameters: `label_a`, `label_b` (both required), `status` (one of
  `duplicate`, `supplement`, `contradiction`, `unrelated`), `store` (optional)
- Records a pairwise verdict so `find_duplicates` stops re-reporting that pair
- Labels are slugified internally
- Overwriting either memory later clears the verdict automatically
  (DB-level: the `remember()` and `forgetEntry()` functions `DELETE` from
  `dedup_pairs` for the affected slug)
- Returns `[checked] store :: a <-> b -> status`

### Verdict lifecycle

1. `find_duplicates` surfaces a pair above threshold
2. Agent loads the `thatch-dedup-classifier` skill
3. Agent classifies the pair: `duplicate` (merge), `supplement` (keep both),
   `contradiction` (resolve), `unrelated` (mark and ignore)
4. For duplicates: agent merges via `memory_remember(overwrite: true)` +
   `memory_forget` the other entry
5. Agent calls `dedup_mark_checked` for the surviving pair
6. Overwriting either memory clears the verdict → the pair can re-flag if the
   merge created a new similarity

### The dedup_pairs table

- PK: `(store, slug_a, slug_b)` — slugs stored sorted (`a < b`) for canonical
  matching
- No FK to entries (slugs are compared by string, not by FK constraint)
- Overwriting or forgetting an entry clears all verdicts involving that slug
  (`DELETE` in `remember()` and `forgetEntry()`)

### thatch-dedup-classifier skill

- Shared skill (`artifacts/skills/thatch-dedup-classifier.md`)
- Classifies the relationship between two similar memory entries
- Provides a structured process: read both entries, compare content, decide
  verdict, reconcile
- Can be dispatched as a sub-agent by the extraction pipeline or loaded
  directly by the agent

## Interactions with other features

- [Memory store](memory-store.md): `find_duplicates` searches stored memories;
  merging uses `memory_remember(overwrite)` + `memory_forget`.
- [Hygiene](hygiene.md): hygiene report counts pending dedup pairs (same
  underlying `db.findDuplicates`).
- Skills: `thatch-dedup-classifier` is the skill that guides the
  reconciliation process.
- [Extraction](extraction.md): extraction can trigger the dedup cycle when
  write-time duplicate detection fires.

## Source files

- `src/db.ts` — `findDuplicates`, `markChecked`, `dedup_pairs` table
- `src/tool-defs.ts` — 2 dedup tools (`find_duplicates`, `dedup_mark_checked`)
- `artifacts/skills/thatch-dedup-classifier.md` — classifier skill

## Database tables

- `dedup_pairs(store, slug_a, slug_b, status, checked_at, PK(store, slug_a, slug_b))`

## Key invariants

- `find_duplicates` groups pairs into clusters (connected components). A
  cluster of 3+ should be consolidated into one memory.
- Verdicts are automatically cleared when either memory is overwritten or
  forgotten. This is intended — a merge can create a new similarity that
  should re-flag.
- The threshold (0.85) is higher than the recall nudge threshold (0.55) because
  "duplicate" is a stronger claim than "relates to".
- Slugs in `dedup_pairs` are stored sorted (`a < b`) for canonical matching
  regardless of argument order.
