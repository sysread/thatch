# Prediction Engine (User Decision Model)

A statistical model of the user's decision-making preferences. Captures "when
X, the user tends to Y." The agent queries the model when facing judgment
calls and updates it based on user feedback.

## What it does

- Four tools: `prediction_query`, `prediction_update`, `prediction_list`,
  `prediction_delete`. All defined in `src/tool-defs.ts`.
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
2. **Prediction dedup** — store-wide search for a near-identical prediction
   (cosine >= 0.85). If found, links this matcher to it via an edge rather than
   creating a duplicate row.
3. **New prediction with a non-create signal** — applies the signal
   immediately so the first confirm/disconfirm is not lost.
4. **`create` on an existing prediction** — links the edge and records
   provenance but does NOT adjust confidence. `create` is confidence-neutral.
5. **`confirm` / `disconfirm` / `soft`** — maps to `adjustConfidence` and
   records provenance.

Returns a status line with final confidence and confirm/disconfirm counts.
Embeds both the matcher and prediction text.

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
## User decision model
- [0.72 conf, 4 tests] When {matcher}: you tend to {prediction}
- [0.61 conf, 2 tests] When {matcher2}: you may prefer {prediction2}
```

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
| `src/prediction.ts` | Thin wrapper around `ScoringEngine` with prediction-specific table names |
| `src/scoring-engine.ts` | Generic four-table scoring engine with Bayesian confidence (shared base for prediction and behavior) |
| `src/db.ts` | Prediction tables, `scorePredictionNudge` |
| `src/tool-defs.ts` | Four prediction tools (`query`, `update`, `list`, `delete`) |
| `src/prompts.ts` | `predictionNudge` formatting, verb selection |
| `src/sideband.ts` | `predictions` method for the MCP path |

## Database tables

```sql
prediction_matchers(
    id          INTEGER PRIMARY KEY,
    store       TEXT,
    description TEXT,
    embedding   BLOB,
    model       TEXT,
    created_at  TEXT,
    updated_at  TEXT
)

predictions(
    id               INTEGER PRIMARY KEY,
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
    id           INTEGER PRIMARY KEY,
    prediction_id INTEGER,
    signal       TEXT,
    detail       TEXT,
    created_at   TEXT,
    FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
)
```

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
