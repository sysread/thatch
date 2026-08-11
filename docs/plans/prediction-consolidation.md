# Prediction Consolidation and Compound Predictions

## Synopsis

Post-processing layers for the prediction engine: fire tracking, co-fire-based
consolidation (dedup), and compound (tier-2) predictions minted from
co-firing constellations of existing predictions. Uses nudge-driven detection
and the existing edge model for fire behavior. No cron, no separate backend.

## Background

The prediction engine ships matchers, predictions, edges, and provenance. It
auto-fires at chat.message and updates via agent tool calls. What it lacks
relative to nak's samskara system:

- **Fire tracking** -- no record of which predictions fire together on the same
  turn. This is the prerequisite for both co-fire dedup and compound detection.
- **Consolidation** -- no corpus-level dedup pass. Write-time dedup
  (findNearestPrediction at 0.85) catches near-identical statements at creation,
  but behavioral duplicates (same preference, different wording) accumulate.
- **Compound predictions** -- no mechanism to mint a higher-order prediction
  from a constellation of predictions that reliably co-fire. Nak's tier-2
  samskaras fire at 77% genuine-engagement vs tier-1's 21% because compound
  claims match broader contexts.

Reference: `docs/dev/samskara.md` in nak (1896 lines), studied July/August 2026.
The architectural difference between the two systems is load-bearing for this
plan (see Key Insight below).

## Key Insight: the edge model carries fire behavior

Nak matches on `prediction_embedding` (the claim text). A tier-2 fires because
its compound claim text cosine-matches the user message. This is why nak needs
fire tracking, cohort_ids, lift computation, and a separate tier-2 detection
RPC -- the compound only fires if its own embedding matches.

Thatch matches on `matcher_embedding` (the context description) and follows
edges. A compound prediction with edges to its children's matchers fires
automatically whenever any child matcher fires. The compound inherits the fire
coverage of all its children. This is "firing in tandem" for free, via the
existing edge model.

The co-fire data is for *deciding what to compound*, not for *making the
compound fire*. This means:

1. A compound needs no tier column, no special scoring path, no fire-path
   changes. It is a prediction with multiple matcher edges.
2. The existing `scorePredictions` already follows all edges and deduplicates by
   prediction_id. A compound scores through its children's edges.
3. The existing `prediction_update` tool already finds existing matchers by
   cosine (0.85 threshold) and creates edges. Calling it multiple times with
   different matcher texts but the same prediction statement creates a
   multi-matcher compound naturally.

A v1 could even skip fire tracking and let the agent create compounds based on
semantic similarity between existing predictions (cosine on prediction
embeddings). Fire tracking makes detection data-driven instead of
embedding-driven, but the edge model carries the fire behavior either way.

## Decisions

| Decision | Rationale |
|----------|-----------|
| No tier column | A compound is a prediction with multiple matcher edges. The edge model already handles multi-matcher predictions. Adding a tier column would special-case scoring and fire paths for no benefit. |
| Fire tracking as prerequisite | Co-fire data drives both consolidation and compound detection. Without it, detection is limited to semantic similarity. With it, detection is behavioral -- based on what actually fires together. |
| Nudge-driven, not cron-driven | Thatch has no cron. Detection runs at session start, folded into the existing hygiene nudge. This is the same pattern as `findDuplicates` for memories. |
| Agent is the minter | Like the existing prediction engine, the agent synthesizes compound statements via `prediction_update`. No separate LLM minter call. The nudge surfaces the candidate constellation; the agent decides whether to compound. |
| Lift for compound detection, ratio for dedup | Nak proved this: the rarer-member ratio (`cofires / min(fires_A, fires_B)`) catches duplicates (perfectly correlated) but fails for compounds because busy-but-independent pairs still reach ratio ~0.5. Lift (`cofires * cohorts / (fires_A * fires_B)`) separates genuine co-activation from base-rate binding. |
| Cosine band separates dedup from compound detection | Dedup operates at cosine >= 0.70 (near-duplicates). Compound detection operates at cosine in [0.30, 0.68) (related but distinct). The 0.68 top end stays below dedup's 0.70 floor so the two phases never fight over the same pair. |

## Architecture

### Phase 1: Fire Tracking

**New table: `prediction_fires`**

```sql
CREATE TABLE IF NOT EXISTS prediction_fires (
  id            TEXT PRIMARY KEY,
  prediction_id TEXT NOT NULL,
  store         TEXT NOT NULL,
  session_id    TEXT,
  cohort_id     TEXT NOT NULL,
  score         REAL NOT NULL,
  fired_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
);
```

`cohort_id` is a UUID generated per auto-fire invocation, shared across all
predictions that scored above threshold in the same `scorePredictionNudge`
call. This is the direct analog of nak's `samskara_fires.cohort_id`.

**Write path:** `scorePredictionNudge` currently returns `PredictionNudgeItem[]`
and is called from two sites (index.ts auto-fire, sideband.ts MCP path). Add a
`recordFires` method that takes the scored predictions + a generated cohort_id
and inserts one row per prediction. The callers generate the cohort_id before
calling `scorePredictionNudge` and pass it through for recording.

Both callers must record fires. The opencode path (index.ts) has the session_id.
The MCP path (sideband.ts) does not have a session_id in the sideband request --
pass null or derive from the socket connection.

**New DB methods:**
- `recordFires(cohortId, sessionId, items, store)` -- batch insert
- `fireCount(predictionId)` -- total fires for a prediction
- `cofireCount(predictionIdA, predictionIdB)` -- count shared cohorts
- `totalCohorts(store)` -- distinct cohort_id count (for lift denominator)

**Schema location:** `#initSchema` in db.ts, alongside existing prediction
tables. Same conventions (uuid PK, store column, idempotent CREATE TABLE IF
NOT EXISTS).

### Phase 2: Consolidation (Co-fire Dedup)

**New DB method: `findPredictionDuplicates(store, threshold)`**

Two-pass, mirroring nak's `samskara_collapse_by_cofiring`:

**Primary pass (behavioral):** For each pair of predictions (A, B) in the store
where both have fire_count > 0:

```
cofires(A, B) >= 3
cofires(A, B) / min(fires_A, fires_B) >= 0.5
cosine(embed_A, embed_B) >= 0.70
```

The ratio normalization is the key: two predictions that always fire together
when either fires are duplicates. Two that co-fire but also fire independently
are adjacent-but-distinct. Cosine is a sanity floor against spurious co-fires.

**Safety cap (cosine-only):** If the prediction count exceeds a target (e.g.,
100), fall through to pure embedding-cosine greedy merge (cosine >= 0.60)
regardless of co-fire data. This catches accumulation when the behavioral pass
finds nothing but the pool is still growing.

**Output:** A list of candidate merge pairs with {predictionA, predictionB,
cofires, ratio, cosine, firesA, firesB}. Surfaced via the hygiene nudge, not
auto-merged. The agent reviews and merges via prediction_delete + (optionally)
prediction_update to fold the loser's matchers into the winner.

The merge itself is agent-driven: the agent sees the candidate pair, reads both
predictions, deletes the weaker one (or uses a future `prediction_merge` tool
if one is added). This matches the memory dedup pattern
(`find_duplicates` + `dedup_mark_checked`).

**Integration point:** `hygiene.ts` -- add a line to `hygieneReport`:
`N prediction duplicate pairs pending review` when candidates exist.

**Nudge throttling:** Runs at session start only, same as the existing hygiene
report. The analysis is O(n^2) over the predictions table but n is small
(tens, not hundreds) so the cost is negligible.

### Phase 3: Compound Prediction Detection

**New DB method: `findCoFireConstellations(store)`**

Returns candidate groups of 3-6 predictions that reliably co-fire but are
semantically distinct (not dedup candidates).

**Detection formula (lift-based, from nak):**

```
eligible(A, B) when:
  cofires(A, B) >= p_min_cofires             -- 10
  lift(A, B)    >= p_min_lift                 -- 2.0
  cosine(embed_A, embed_B) >= p_cosine_lo     -- 0.30 (effectively inert)
  cosine(embed_A, embed_B) <  p_cosine_hi     -- 0.68 (< dedup floor 0.70)

  where lift(A, B) = cofires(A, B) * total_cohorts / (fires_A * fires_B)
```

Lift is observed co-fires over co-fires expected under independence. Base-rate
binding (two busy predictions colliding because both fire often) sits at lift
~1. Genuine co-activation runs several times chance. The `p_min_cofires = 10`
absolute-mass guard prevents small-sample variance (a pair firing 4x that
always co-fires scores a huge lift on 4 points).

**Group growth:**
1. Seed: the strongest-lift eligible edge.
2. Grow: every node sharing an eligible edge with BOTH seed members (not
   either -- co-firing with one is adjacent, not part of the constellation).
   Strongest combined lift first. Capped at 6 members. Reject groups < 3 (a
   2-member group is a dedup candidate, not a compound).
3. Coverage skip: if the candidate's Jaccard overlap with any existing
   compound's child-matchers is >= 0.60, skip to the next-strongest uncovered
   seed. This prevents one compound on a dense region from masking every other
   constellation.

**Precondition:** At least 8 predictions with fire_count > 0 before the
self-join runs. Avoids spending computation on a cold store.

**Output:** A list of candidate constellations, each with {members:
[{prediction_id, statement, matcher_description, cofire_weight}], lift,
group_size}. Surfaced via the hygiene nudge.

**Integration point:** `hygiene.ts` -- add: `N co-fire constellations pending
review` when candidates exist.

### Phase 4: Compound Minting (Agent-Driven)

The nudge surfaces a candidate constellation. The prompt instructions tell the
agent:

1. Read the member predictions and their matchers.
2. Synthesize a generalized statement that captures the shared behavior without
   collapsing to any single child.
3. Call `prediction_update` once per child matcher, using the child's matcher
   text and the new compound statement. Each call finds the existing child
   matcher by cosine (0.85) and creates an edge to the new compound prediction.

The agent calls `prediction_update` with `signal: "create"` for each child
matcher. The first call creates the compound prediction + an edge from the
first child's matcher. Subsequent calls find the existing compound by
`findNearestPrediction` (0.85 store-wide dedup) and add edges from the other
children's matchers.

This works with the existing tool surface. No new tools needed for minting.

**Prompt instructions addition** (in prompts.ts, all three host variants):

After the existing prediction instructions, add guidance for compounds:

- When the hygiene nudge reports co-fire constellations, consider whether the
  members share a generalizable behavior.
- If so, synthesize a compound statement and call `prediction_update` once per
  child matcher with the compound statement. The tool handles matcher dedup and
  edge creation.
- A compound should be strictly more general than any single child. If you
  cannot generalize, do not compound.
- The compound inherits the fire coverage of its children's matchers. It will
  fire whenever any child matcher fires.

### Phase 5: Compound Summary (Optional, Future)

Nak generates a cached prose summary of top samskaras that rides every system
prompt. Thatch could do the same: a one-paragraph summary of the strongest
predictions, regenerated when the prediction set changes significantly.

This is lower priority. The per-turn auto-fire nudge already surfaces relevant
predictions. A compound summary would capture stable bias across every turn,
not just when a matcher fires. Defer until the compound predictions prove
useful in practice.

## Data Flow

```
chat.message (user text)
  → embed promptText (shared with recall nudge)
  → scorePredictionNudge([repo, global], embedding, 0.45)
    → findMatchers (cosine >= 0.45)
    → scorePredictions (follow edges, dedup by prediction_id)
    → recordFires (NEW: persist cohort with shared cohort_id)
    → return PredictionNudgeItem[]
  → inject prediction nudge (existing)

session.created (top-level)
  → hygieneReport
    → findDuplicates (memories, existing)
    → findPredictionDuplicates (NEW: co-fire dedup candidates)
    → findCoFireConstellations (NEW: compound candidates)
    → inject hygiene nudge with all signals

Agent reads hygiene nudge
  → reviews dedup candidates → prediction_delete / merge
  → reviews constellation candidates → prediction_update (compound minting)
```

## Dependencies

No new runtime dependencies. All detection is SQLite queries + JS cosine
computation, same as existing prediction methods.

**Schema:** One new table (`prediction_fires`), added to `#initSchema` in
db.ts.

**Code changes by file:**
- `src/db.ts` -- new table, 4-5 new methods (recordFires, fireCount,
  cofireCount, totalCohorts, findPredictionDuplicates, findCoFireConstellations)
- `src/index.ts` -- generate cohort_id, pass to recordFires in auto-fire path
- `src/sideband.ts` -- same for MCP path
- `src/hygiene.ts` -- add prediction dedup + constellation counts to report
- `src/prompts.ts` -- compound minting guidance in all three prompt variants
- `tests/prediction.test.ts` -- tests for new DB methods
- `tests/plugin.test.ts` -- test that fire tracking records cohorts

## Implementation Order

1. **Fire tracking** (table + recordFires + caller wiring). Foundation for
   everything else. Ship and let fire data accumulate.
2. **Cosine dedup** (findPredictionDuplicates + hygiene integration). Does not
   need fire tracking. Can ship in parallel with phase 1. Immediate value:
   catches behavioral duplicates the write-time 0.85 dedup misses.
3. **Co-fire dedup** (add co-fire ratio + cosine filter to
  findPredictionDuplicates). Needs fire data to accumulate first. Wait a few
   weeks after phase 1 ships.
4. **Compound detection** (findCoFireConstellations + hygiene integration).
   Needs more fire data than dedup (p_min_cofires = 10). Wait longer.
5. **Compound minting** (prompt instructions + agent-driven via existing
  tools). Ships with phase 4 -- the nudge surfaces candidates, the agent
   compounds.

Phases 1-2 can ship together. Phases 3-5 follow once fire data accumulates.

## Test Plan

- `prediction.test.ts`: test recordFires, fireCount, cofireCount,
  totalCohorts with synthetic cohorts. Test findPredictionDuplicates with
  known co-firing pairs. Test findCoFireConstellations with lift thresholds.
  Use the existing `makeEmbed(seed, dim=384)` helper.
- `plugin.test.ts`: test that chat.message auto-fire records a cohort.
  Follow the recall-nudge test pattern (mock.module transformers + server
  hooks).
- `hygiene.test.ts` (if exists) or `plugin.test.ts`: test that hygiene report
  includes prediction dedup/constellation counts when candidates exist.

## Risks and Mitigations

**Risk: O(n^2) co-fire self-join at session start.**
Mitigation: n is small (tens of predictions per store). The self-join is over
`prediction_fires` grouped by cohort_id, not over embeddings. Add a
precondition gate (minimum prediction count, minimum fire count) before running
the analysis.

**Risk: Compound predictions fire too much, dominating the nudge.**
Mitigation: The existing `scorePredictionNudge` deduplicates by prediction_id
and slices to limit=5. A compound competes on equal footing with its children.
If a compound and a child both fire, the higher-scoring one wins the slot. The
compound's score is `cosine(matcher) * edge.weight * confidence` -- same
formula. No special treatment.

**Risk: Agent creates poor compounds (too generic, not useful).**
Mitigation: The prompt instructions include the "strictly more general" guard
and the "if you cannot generalize, do not compound" escape hatch. The compound
starts at confidence 0.5 (p0) and earns confidence through user feedback like
any prediction. Bad compounds get disconfirmed and stop dominating the nudge.

**Risk: Fire tracking bloats the DB.**
Mitigation: `prediction_fires` rows are small (id, prediction_id, store,
session_id, cohort_id, score, fired_at). At ~10 predictions per fire event and
~100 fire events per session, that is ~1000 rows per session. Add a cleanup
pass (delete fires older than 90 days with no corresponding prediction) if
this becomes a concern. Low priority.

## Notes

- The `populationP0` method already exists but is not wired into
  `createPrediction`. Wiring it would make new predictions (including
  compounds) start at the store's actual hit rate instead of flat 0.5. This is
  a separate improvement, not part of this plan, but worth doing alongside
  phase 1.
- The existing write-time dedup (`findNearestPrediction` at 0.85) catches
  near-identical statements at creation. The co-fire dedup in phase 3 catches
  behavioral duplicates that differ in wording. The two are complementary:
  write-time catches semantic twins, co-fire catches behavioral twins.
- Nak's tier-2 decline ledger (`samskara_tier2_declines`, TTL'd 7 days) prevents
  re-offering a declined constellation every sweep. Thatch's equivalent: a
  `prediction_constellation_declines` table or a `dedup_pairs`-style
  checked-pairs set. Defer until the agent is actually declining candidates and
  the re-offer becomes annoying.
