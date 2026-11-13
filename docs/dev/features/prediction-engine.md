# Prediction Engine (User Decision Model)

A statistical model of the user's decision-making preferences. Captures "when
X, the user tends to Y." The agent queries the model when facing judgment
calls and updates it based on user feedback.

## What it does

- Tools: `prediction_query`, `prediction_update`, `prediction_list`,
  `prediction_delete`, `prediction_mark_checked`,
  `prediction_find_duplicates`. All defined in
  `src/tool-defs.ts`.
- Auto-fires at every user message: embeds the prompt, cosine-matches against
  matchers, injects scored predictions as a synthetic nudge part.
- Bayesian confidence model — a graded score that is reinforced or weakened
  over time, not binary like memory.
- Matcher-prediction edges: many-to-many with weights. The same matcher can
  produce different predictions in different contexts.
- Ambiguity surfacing: strong predictions are followed silently; ambiguous or
  competing predictions are surfaced to the user.
- No wall-clock decay: confidence moves only when tested (user feedback);
  untested predictions stay at the prior.

## How it works

### Data model: matchers, predictions, edges, provenance

Four tables in SQLite, mirroring the behavior engine's shape:

- **Matchers** — context patterns (situation descriptions). Embedded,
  cosine-matched at `chat.message`. Capture "when" — describes the situation.
- **Predictions** — user preference statements with graded confidence.
  Capture "what" — the user's tendency.
- **Edges** — weighted matcher-to-prediction links. Many-to-many. The same
  matcher can produce different predictions in different contexts (the weight
  encodes context-dependency). The same prediction can be reached by multiple
  matchers.
- **Provenance** — audit trail of every signal applied to a prediction
  (`confirm` / `disconfirm` / `soft` / `create`) with detail and timestamp.

### Confidence model (Bayesian posterior)

```text
confidence = (confirm_count + K * P0) / (confirm_count + disconfirm_count + K)
```

- K = 5 (shrinkage parameter)
- P0 = 0.5 (prior)
- Soft signal weight: 0.25 — a soft disconfirm counts as one-quarter of a
  full disconfirm.
- `effective_confidence = confidence`. The shrinkage handles thin evidence: a
  single confirm is plausible, not reliable.
- No wall-clock decay. Confidence is relevance-gated: being tested
  (encountered + user feedback) is what moves it. Untested predictions stay at
  P0.

### Scoring at query time

```text
score = cosine(user_text, matcher.embedding) × edge.weight × prediction.effective_confidence
```

Returns all predictions from matching matchers so the LLM can read conflicts.
The LLM is the conflict detector. Prompt instruction: "if competing
predictions offer conflicting guidance, surface to the user."

### Query (`prediction_query` tool)

- Embeds the context string.
- Finds the top 5 matchers by cosine.
- Filters to cosine >= 0.60 (`PREDICTION_QUERY_THRESHOLD`, matching the
  auto-fire threshold).
- Follows edges to predictions, scores them.
- Returns one line per prediction: `[conf, N tests] When {matcher}: {verb}
  {statement}`.
- Verb reflects evidence count: "you may prefer" (0 evidence) vs "you tend to"
  (has evidence).
- Read-only. Embeds the context.

### Update (`prediction_update` tool)

Parameters: `matcher` (situation description), `prediction` (preference
statement), `signal` (`confirm` / `disconfirm` / `soft` / `create`),
`rationale` (why).

Runs in a single DB transaction:

1. **Matcher dedup** — finds an existing matcher above cosine 0.85, else
   creates one.
2. **Prediction dedup** — search across the target store AND global for a
   near-identical prediction (cosine >= 0.85). If found, links this matcher to
   it via an edge rather than creating a duplicate row. The auto-fire nudge
   scans both stores, so a prediction saved to both would otherwise surface
   twice every turn; the write reinforces the existing row in its home store
   and the result echoes where it landed.
3. **New prediction with a non-create signal** — applies the signal
   immediately so the first confirm/disconfirm is not lost.
4. **`create` on an existing prediction** — links the edge and records
   provenance but does NOT adjust confidence. `create` is confidence-neutral.
5. **`confirm` / `disconfirm` / `soft`** — maps to `adjustConfidence` and
   records provenance.

Returns a status line with final confidence and confirm/disconfirm counts.
Embeds both the matcher and prediction text.

Both text fields are guarded against the signal-value cross-wiring slip: a
matcher or prediction whose text is exactly `confirm` / `disconfirm` /
`soft` / `create` is refused with teaching before any write. The slip
minted one-word prediction rows into the live store (November 2026), rows
the semantic delete path could not safely target.

### Delete (`prediction_delete` tool)

Two paths. The `id` parameter is exact: it addresses one row by its UUID
(ids are globally unique, so no store is needed) and is the safe route for
malformed rows. It takes precedence when both parameters are passed. The
`statement` path is a semantic match (cosine >= 0.85) that refuses
statements under three words: one- and two-word text embeds too generically
for a destructive match ("prefer tabs" can clear 0.85 against "prefer
spaces"). `prediction_list` shows every row's id, which is where the id
comes from. Edges and provenance cascade.

### Dedup pass (corpus-level consolidation)

Write-time dedup (0.85, both stores) catches near-identical statements at
creation. Wording-different duplicates — the same preference restated weeks
later — land below that floor and accumulate. The dedup pass finds them:

- `findPredictionDuplicates(store, threshold = 0.70)` in `src/prediction.ts`:
  pairwise cosine over the store's predictions, skipping pairs already
  adjudicated in `prediction_dedup_pairs`. The threshold is band placement:
  [0.85, 1] is write-time territory, below 0.70 short-statement embeddings
  are too noisy to call duplicates.
- Pairs are keyed on the canonical SORTED id pair — (A,B) and (B,A) are one
  row, the same contract as the memory side's `dedup_pairs`.
- `prediction_mark_checked(id_a, id_b, status)` records the verdict:
  `duplicate` (merged or treat as one) or `distinct` (both legitimate).
  Both ids must be live predictions in the target store: unknown ids are
  refused (with a did-you-mean suggestion against the store's ids) and
  wrong-store ids are refused naming the store they actually live in,
  because a verdict row referencing anything else suppresses nothing.
  Distinct verdicts are the load-bearing case — a destroyed duplicate is
  gone, but a judged-distinct pair re-surfaces every session start unless
  recorded.
- The hygiene report surfaces `N prediction duplicate pairs pending review`,
  naming the pair ids inline while the count is small (capped at five
  pairs - past the cap the ids would crowd out the line, and the listing
  tool carries them). The `prediction_find_duplicates` tool is the full
  listing: every pending pair with both ids, statements, and cosine,
  clustered by shared prediction ids the way the memory side clusters by
  slug (`renderPredictionPairs` in `src/tool-defs.ts`). The agent merges
  (fold the loser's matchers with `prediction_update`,
  mark the pair with `prediction_mark_checked`, then `prediction_delete`
  the loser by id - the verdict must be recorded while both ids are live)
  or judges distinct and records that verdict. Scans are per-store:
  cross-store writes are edge-linked at write
  time instead of duplicated.
- The pair table is swept at every DB open (`#sweepPhantomPredictionPairs`
  in `src/db.ts`): verdict rows whose ids are not both live predictions in
  the pair's own store are deleted. Prediction ids are UUIDs no write path
  reuses, so such rows suppress nothing and can never become meaningful
  again. The sweep collects the merge flow's residue (a verdict recorded
  against a loser that was then deleted), fabricated ids from before
  mark_checked validated, and wrong-store rows. The memory side's
  `dedup_pairs` deliberately has no such sweep: slugs are content-derived
  and a forgotten slug can legitimately be re-created, so a stale-looking
  verdict there can become meaningful again.
- The co-fire refinement (behavioral evidence layered onto this method once
  fire tracking exists) is designed in
  docs/plans/prediction-consolidation.md.

### Auto-fire (opencode: `chat.message` hook)

- Reuses the prompt embedding already computed for the recall nudge — no extra
  model call.
- Calls `db.scorePredictionNudge([repo, "global"], embedding,
  PREDICTION_THRESHOLD)`.
- Threshold: 0.60 (env: `THATCH_PREDICTION_THRESHOLD`). Higher than recall
  (0.55) because surfacing a preference nudge is more disruptive.
- Injects `predictionNudge(items)` as a separate synthetic text part with a
  `[thatch] User decision model` header.
- 0-evidence predictions use "you may prefer"; predictions with evidence use
  "you tend to".
- The block ends with a snapshot footer (see the block example below): the
  labels are a submission-time snapshot, not a live view.
- Independent try/catch — a prediction failure does not block recall or
  behavior.
- Toast: `[thatch] N predictions surfaced`.

### Auto-fire (MCP: sideband)

- `flush-tools` fires the prediction query via the sideband socket's
  `predictions` method, in parallel with recall and behavior.
- The same `scorePredictionNudge` entry point prevents scoring drift between
  host paths.
- Sideband failure returns `null`; the caller skips the prediction nudge
  gracefully.

### System prompt injection

The auto-fire block looks like:

```text
[thatch] User decision model
- [0.72 conf, 4 tests] When {matcher}: you tend to {prediction}
- [0.61 conf, 2 tests] When {matcher2}: you may prefer {prediction2}
Snapshot: these labels reflect the prediction store as of this message's
submission. Predictions updated after submission (including during this
turn) do not refresh it; re-check with thatch_prediction_query before
relying on them.
```

The footer's tool name follows the host: opencode sees
`thatch_prediction_query`; MCP hosts (Claude Code, Cursor) see
`mcp__thatch__prediction_query`. The renderer resolves the spelling
through the caller's `ToolNamer`.

The snapshot footer exists because the block is computed once when the
message is submitted and stays re-injected into every outbound request of
the turn (`pendingInjections`). Predictions the conversation
mutates mid-turn do not refresh the block; the footer tells the consumer
the labels are a submission-time snapshot and points at the live tool.

Prompt instructions: follow strong predictions silently, surface weak or
competing predictions to the user, update the model when the user responds.

### Ambiguity surfacing

The killer feature. Three regimes:

- **Strong prediction** (high confidence + evidence) — the agent follows
  silently, does not interrupt.
- **No prediction** — the agent asks the user (same as today).
- **Ambiguous or competing predictions** — the agent surfaces naturally:
  "I think you usually prefer X, but I'm not sure here — what do you want?"

When the user responds to a surfaced prediction, the agent calls
`prediction_update` to reinforce or weaken. The value is fewer interruptions,
not more.

### Violation ask

The retrospective complement of ambiguity surfacing: the user chose Y where
the model predicted X. A violated prediction is the highest-information event
the model receives, and the firewall principle means only the user can grade
it. The User Decision Model prompt guidance (`src/prompts.ts`, both prompt
variants) instructs: ask why, one line folded into the existing response
("You usually prefer X; Y this time - contextual, or should I update?").

The ask is budgeted. It fires only when the prediction has real evidence and
the choice looks like a deliberate judgment call. A 0-evidence prediction
("you may prefer") just disconfirms silently; there is nothing to learn from
asking. When the context obviously explains the choice, the agent records the
disconfirm with its rationale and stays quiet.

The user's answer routes the update: a context-dependent choice means the
matcher was too broad (disconfirm here, mint a tighter matcher); a preference
change means disconfirm; a false violation means confirm. The agent asks
follow-up questions when the answer does not encode the rationale. Without
the ask, every violation silently erodes confidence and a too-broad matcher
keeps misfiring in the same shape.

### Firewall principle

The model that uses predictions cannot grade its own predictions. The user's
feedback is the signal. The query is mechanical (a statistical model). The
formation and evaluation are agent-driven (via tools, guided by prompt
instructions). This separation prevents the agent from reinforcing its own
biases.

### Relevance-gated decay

Confidence does not decay by wall-clock time. It moves only when tested — when
the user encounters a situation matching the matcher and provides feedback.
Untested predictions stay at P0 (0.5). A prediction that was strongly confirmed
a year ago but never tested since retains its confidence. The design assumes
that user preferences are stable, not time-sensitive.

## Interactions with other features

- **Nudge pipeline** ([nudge-pipeline.md](nudge-pipeline.md)): prediction
  auto-fire is tier 3. Shares the prompt embedding with recall (tier 2) and
  behavior (tier 4).
- **Behavior engine** ([behavior-engine.md](behavior-engine.md)): same
  four-table data model, same Bayesian confidence, same scoring engine.
  Different semantics — predictions model user preferences; behaviors model
  LLM discipline.
- **Scoring engine**: `src/scoring-engine.ts` provides the generic four-table
  scoring base. `PredictionEngine` (`src/prediction.ts`) is a thin wrapper with
  prediction-specific table names.
- **Memory store** ([memory-store.md](memory-store.md)): same embedding model
  (BGE-small-en-v1.5), same SQLite DB, different tables.
- **Sideband IPC** ([sideband.md](sideband.md)): MCP hosts query predictions
  via the sideband socket's `predictions` method.

## Source files

| File | Role |
|------|------|
| `src/prediction.ts` | Thin wrapper around `ScoringEngine` with prediction-specific table names, plus the corpus dedup pass (`findPredictionDuplicates`, pair verdicts) |
| `src/scoring-engine.ts` | Generic four-table scoring engine with Bayesian confidence (shared base for prediction and behavior) |
| `src/db.ts` | Prediction tables, `scorePredictionNudge`, pair-verdict sweep on open |
| `src/tool-defs.ts` | Six prediction tools (`query`, `update`, `list`, `delete`, `mark_checked`, `find_duplicates`) |
| `src/prompts.ts` | `predictionNudge` formatting, verb selection, dedup-merge guidance |
| `src/sideband.ts` | `predictions` method for the MCP path |

## Database tables

```sql
prediction_matchers(
    id          TEXT PRIMARY KEY,
    store       TEXT,
    description TEXT,
    embedding   BLOB,
    model       TEXT,
    created_at  TEXT,
    updated_at  TEXT
)

predictions(
    id               TEXT PRIMARY KEY,
    store            TEXT,
    statement        TEXT,
    rationale        TEXT,
    embedding        BLOB,
    model            TEXT,
    confidence       REAL,
    confirm_count    REAL,
    disconfirm_count REAL,
    created_at       TEXT,
    updated_at       TEXT
)

prediction_edges(
    matcher_id   INTEGER,
    prediction_id INTEGER,
    weight       REAL,
    PRIMARY KEY (matcher_id, prediction_id),
    FOREIGN KEY (matcher_id)    REFERENCES prediction_matchers(id) ON DELETE CASCADE,
    FOREIGN KEY (prediction_id) REFERENCES predictions(id)         ON DELETE CASCADE
)

prediction_provenance(
    id           TEXT PRIMARY KEY,
    prediction_id INTEGER,
    signal       TEXT,
    detail       TEXT,
    created_at   TEXT,
    FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
)

prediction_dedup_pairs(
    store      TEXT,
    id_a       TEXT,
    id_b       TEXT,
    status     TEXT,
    checked_at TEXT,
    PRIMARY KEY (store, id_a, id_b)
)
```

Timestamp semantics: a matcher's `updated_at` is the last change to the
matcher row OR its edge set — `createEdge` bumps it when a new edge lands,
and deleting an item bumps the matchers whose edges cascade away. The
matcher's own text may legitimately be older than its links (a corrected
prediction re-links the existing matcher without touching its text).
An item's `updated_at` is written at creation and then moved by the last
confidence change.

## Key invariants

1. **The firewall principle.** The model that uses predictions cannot grade
   them. User feedback is the only signal.
2. **No wall-clock decay.** Confidence is relevance-gated — being tested moves
   it, not the passage of time.
3. **Dedup at creation.** Cosine >= 0.85 for both matchers and predictions.
4. **Same `scorePredictionNudge` entry point** in both host paths (opencode
   `chat.message` hook and MCP sideband) prevents scoring drift.
5. **Matcher text is embedded raw.** No header prepend — unlike
   `memory_remember`, which prepends `# label\n\n` before embedding.
6. **Adjudicated dedup pairs never re-surface.** Verdict rows are keyed on
   the canonical sorted id pair; `findPredictionDuplicates` skips them.
7. **Pair verdicts reference live rows.** `prediction_mark_checked`
   validates both ids against the target store's predictions, and the
   sweep at DB open deletes verdict rows whose ids are no longer live, so
   the pair table never carries inert rows.
