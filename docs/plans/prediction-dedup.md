# Plan: prediction dedup (corpus-level consolidation pass)

Status: consensus design, split out of prediction-consolidation.md (Oct 2026,
after five refinement rounds there plus a scoring-path review session). Not
yet implemented. Needs no fire data — independent of the compounds plan.

## Synopsis

A corpus-level dedup pass for the prediction engine: find behavioral
duplicates (same preference, different wording) that the write-time 0.85
dedup misses, surface them through the hygiene nudge, and let the agent merge
or mark them. Direct port of the memory dedup machinery
(`findDuplicates` + `dedup_pairs` + `dedup_mark_checked`) onto the prediction
tables. Cosine-only — no fire tracking, no cron, no separate backend.

## Background

Write-time dedup catches near-identical statements at creation:
`findNearestPrediction` (0.85) blocks same-store duplicates, and cross-store
writes link via edge instead of duplicating. What still accumulates is the
behavioral duplicate: the same preference re-stated in different words weeks
apart, landing under the 0.85 floor. Left alone, both copies keep firing and
split the nudge's limited slots (5) and the user's confirm feedback across
two entries that should have one evidence history.

The memory side solved this shape already: `findDuplicates`
(src/db.ts:838-881) does an O(n²) pairwise cosine over a store, skips pairs
already adjudicated in `dedup_pairs` (sorted-pair canonical key), and returns
score-sorted candidates; `thatch_dedup_mark_checked` records verdicts so
judged pairs stop re-surfacing. This plan ports that machinery to
predictions, where the item id (not a slug) keys the pair.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Threshold 0.70 | Band placement, not a tuned constant: 0.85+ is already caught at write time, so the reachable gap is [0.70, 0.85). Below 0.70, bge-small-en-v1.5 noise makes distinct-preference pairs plausible candidates; the memory side earns its tighter 0.85 because entries are long-form, while predictions are short statements where rewordings land mid-band. |
| Per-store scan | Cross-store near-duplicates are already handled at write time (edge-linked to the home store, not copied). Scanning across stores would re-litigate rows the write path deliberately linked. |
| Agent-driven merge, existing tools | The agent reads the candidate pair, deletes the weaker (`prediction_delete`), and re-points the loser's matchers by calling `prediction_update` with the winner's statement (existing edge-creation path). No merge tool in v1. |
| Pairs need persistent verdicts | Unlike a duplicate pair (destroyed by the merge), a pair judged DISTINCT re-fires every session start unless recorded. So the checked-pairs table is load-bearing, not bookkeeping polish. |
| New `prediction_mark_checked` tool | Mirrors the memory-side `dedup_mark_checked`; joins the `prediction_*` tool family. Tool-count assertions in tests/setup.test.ts must be updated (they hardcode family counts). |
| Nudge-driven, session-start only | Same cadence as memory dedup — folded into the existing hygiene report. No cron exists; n small (tens) keeps the O(n²) negligible. |

## Architecture

**New table** (same conventions as `dedup_pairs`: canonical-order keying,
idempotent CREATE):

```sql
CREATE TABLE IF NOT EXISTS prediction_dedup_pairs (
  store      TEXT NOT NULL,
  id_a       TEXT NOT NULL,
  id_b       TEXT NOT NULL,
  status     TEXT NOT NULL,  -- "duplicate" | "distinct"
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (store, id_a, id_b)
);
```

Writes sort the id pair into canonical order so (A,B) and (B,A) are the same
row — the exact contract `dedup_pairs` holds (memory: "dedup_pairs keyed by
sorted slug pair"); any reader must sort identically.

**New DB method** `findPredictionDuplicates(store, threshold = 0.70)`:
load predictions with embeddings for the store, skip pairs already in
`prediction_dedup_pairs`, pairwise cosine, return score-descended candidates
`{predictionA, predictionB, cosine, statementA, statementB}`. Shape mirrors
`findDuplicates` (src/db.ts:838-881); embed-length guard as there.

**New tool** `prediction_mark_checked(store, id_a, id_b, status)`: upserts
the pair row so the pair stops (or continues) surfacing. Arg descriptions
state the canonical-order rule so the model self-corrects.

**Hygiene integration** (`src/hygiene.ts`): when candidates exist,
`hygieneReport` gains `N prediction duplicate pairs pending review`.

**Agent flow** (prompt guidance rides the existing prediction instructions):

1. Read both predictions and their matchers.
2. If duplicates: `prediction_update` with the winner's statement against the
   loser's matcher texts (folds the matcher edges over), then
   `prediction_delete` the loser, then `prediction_mark_checked` duplicate.
3. If distinct: `prediction_mark_checked` distinct and move on.

## Data flow

```
session.created (top-level)
  → hygieneReport
    → findDuplicates (memories, existing)
    → findPredictionDuplicates (NEW)
    → inject hygiene nudge with all signals

Agent reads hygiene nudge
  → merges (delete + update) or marks distinct → prediction_mark_checked
```

## Dependencies

No new runtime deps. One table, one DB method, one tool, one hygiene line.

- `src/db.ts` — table, `findPredictionDuplicates`, checked-pair read/write
- `src/tool-defs.ts` — `prediction_mark_checked` (shared registry, like the
  other prediction tools)
- `src/hygiene.ts` — the pending-pairs line
- `src/prompts.ts` — merge-flow guidance in all three host prompt variants
- `tests/prediction.test.ts` — threshold band, checked-pair skip, sorted-pair
  canonicalization, merge flow via the existing tools
- `tests/tool-defs.test.ts` — registry count/name assertions
- `tests/qa/auto/` — one use case: candidate pair surfaces, merge drains it,
  distinct verdict suppresses re-surfacing

## Deliberately deferred

- **Co-fire (behavioral) dedup** — upgrading `findPredictionDuplicates` with
  the co-fire ratio once fire tracking exists: stays in
  [prediction-consolidation.md](prediction-consolidation.md), which is the
  reason that plan still references this file's method.
- **Cross-store pair scan** — write-time linking covers the realistic case;
  revisit only if linked-but-both-firing becomes an observed nuisance.
- **Auto-merge above a high cosine** — the write-time floor already covers
  0.85+; an aggressive auto-merge would need its own provenance story.
