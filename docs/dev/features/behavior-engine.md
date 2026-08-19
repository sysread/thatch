# Behavior Engine (LLM Self-Discipline Rules)

A statistical model of the LLM's own operational discipline. Captures "when
situation X arises, I should do Y." Mirrors the
[prediction engine](prediction-engine.md) architecture but serves a different
purpose: predictions model what the *user* wants; behaviors model what the
*LLM* should do.

## What it does

- Four tools: `behavior_codify`, `behavior_feedback`, `behavior_list`,
  `behavior_delete`. All defined in `src/tool-defs.ts`.
- Auto-fires at every user message: embeds the prompt, cosine-matches against
  behavior matchers, injects scored behaviors as a synthetic nudge part.
- Ham/spam feedback (ham = relevant, spam = not relevant) adjusts Bayesian
  confidence, training the classifier over time.
- Anti-laziness guard in prompt instructions: prevents codifying rules that
  make the agent less thorough. Rules should encode discipline, not shortcuts.
- Default behavior seeding at startup: seeds several default behaviors into
  the global store (session wrap-up, work finalization, research discipline,
  day-turnover checks, dead-end capture, git archaeology). Idempotent across
  releases via version stamps.

## How it works

### Data model: matchers, behaviors, edges, provenance

Four tables in SQLite — same shape as the prediction engine:

- **Behavior matchers** — situation descriptions (when to apply the rule).
  Embedded, cosine-matched at `chat.message`. Capture "when."
- **Behaviors** — self-discipline rule statements (what to do). Capture
  "what." Each carries a rationale explaining why the rule is worth
  persisting.
- **Edges** — weighted matcher-to-behavior links. Many-to-many. The same
  matcher can link to multiple behaviors; the same behavior can be reached
  by multiple matchers.
- **Provenance** — audit trail of every signal applied to a behavior
  (`codify`, `confirm` / ham, `disconfirm` / spam) with detail and timestamp.

### Confidence model (Bayesian posterior)

Same formula and constants as the prediction engine — the constants live in
`src/scoring-engine.ts` and are shared by both engines:

```text
confidence = (confirm_count + K * P0) / (confirm_count + disconfirm_count + K)
```

- K = 5 (shrinkage parameter)
- P0 = 0.5 (prior)
- Ham feedback = confirm signal. Spam feedback = disconfirm signal.
- Same shrinkage and relevance-gated properties as predictions: a single ham
  is plausible, not reliable. Untested behaviors stay at P0.

### How it differs from the prediction engine

| Aspect | Prediction engine | Behavior engine |
|--------|-------------------|-----------------|
| Models | What the USER wants | What the LLM should do |
| Graded by | User feedback (confirm/disconfirm/soft) | LLM's own ham/spam relevance judgment |
| Firewall principle | Applies — the model that uses predictions cannot grade them | Does NOT apply — the LLM grading its own behaviors IS the point |
| Signal types | confirm, disconfirm, soft, create | confirm (ham), disconfirm (spam), codify |
| Default seeding | No | Yes (multiple default behaviors at startup) |

The firewall principle from predictions does not apply here. The LLM grading
its own behavioral rules is the point, not a violation. Ham/spam is a
relevance judgment ("does this rule apply here?"), not a value judgment ("is
this a good rule?"). The agent evaluates each surfaced behavior against the
current situation and records whether it was relevant.

### Codify (`behavior_codify` tool)

Parameters: `situation` (triggering context), `behavior` (the rule),
`rationale` (why worth persisting).

Runs in a single DB transaction:

1. **Matcher dedup** — finds an existing behavior matcher above cosine 0.85,
   else creates one.
2. **Behavior dedup** — store-wide search for a near-identical behavior
   (cosine >= 0.85). If found, links this matcher to it via an edge rather
   than creating a duplicate row.
3. **New behavior** — creates behavior + edge + provenance entry tagged
   `codify`.
4. Returns `[codified]` for a new behavior or `[linked]` for an existing one
   (with confidence and counts).

Confidence starts at P0 (0.5) with 0 evidence.

### Feedback (`behavior_feedback` tool)

Parameters: `behavior` (statement, semantic match at cosine >= 0.85),
`relevant` (boolean), `context` (situation description for provenance).

- `relevant: true` = ham = confirm signal.
- `relevant: false` = spam = disconfirm signal.
- Adjusts confidence and records provenance tagged `ham:` or `spam:`.
- Returns updated confidence and confirm/disconfirm counts.
- Returns a "not found" message if no behavior matches.

### Auto-fire (opencode: `chat.message` hook)

- Reuses the prompt embedding already computed for the recall nudge — same
  embedding serves recall (tier 2), prediction (tier 3), and behavior (tier
  4). One embed, three lookups.
- Calls `db.scoreBehaviorNudge([repo, "global"], embedding,
  BEHAVIOR_THRESHOLD)`.
- Threshold: 0.60 (env: `THATCH_BEHAVIOR_THRESHOLD`). Same as prediction —
  surfacing a discipline rule is as disruptive as surfacing a preference.
- Injects `behaviorNudge(items)` as a separate synthetic text part with a
  `[thatch] Situational behaviors` header.
- 0-evidence behaviors use "consider"; behaviors with evidence use "do".
- Independent try/catch — a behavior failure does not block recall or
  prediction.
- Toast: `[thatch] N behaviors surfaced`.

### Auto-fire (MCP: sideband)

- `flush-tools` fires the behavior query via the sideband socket's
  `behaviors` method, in parallel with recall and predictions.
- The same `scoreBehaviorNudge` entry point prevents scoring drift between
  host paths.
- Sideband failure returns `null`; the caller skips the behavior nudge
  gracefully.

### Default behavior seeding (`src/seed-behaviors.ts`)

Runs at startup in both the opencode plugin (`src/index.ts`) and the MCP
server (`src/mcp.ts`), after DB and model initialization.

Seeds multiple default behaviors into the global store — session wrap-up
(check for uncommitted changes, untracked files, stale artifacts), work
finalization (check before commits/merges), research discipline (investigate
before proposing changes), day-turnover checks (rebase staleness, new review
comments), dead-end capture (save red herrings as memories), and git
archaeology (understand history before debugging or planning).

Idempotent across releases via version stamps:

1. For each default behavior, embeds the situation and behavior text.
2. Checks whether a behavior matcher with cosine >= 0.85 already exists.
3. If found, checks the linked behavior's rationale for a version stamp
   (`seed-version:X.Y.Z`).
4. If the stamp matches the current package version, skips — already seeded.
5. If the stamp differs (older release seeded it) or is absent (manually
   codified), deletes the old behavior and re-creates it with the current
   version stamp. The matcher and edge cascade-delete with the behavior.
6. Creates: behavior matcher (situation embedding), behavior (statement +
   rationale embedding, with version stamp), edge (weight 1.0), provenance
   entry tagged `codify`.

### Anti-laziness guard

Prompt instructions in all host variants explicitly prevent the agent from
codifying rules that make it less thorough. The guard text — "Do not codify
rules that make you lazier or less thorough. Rules should encode discipline,
not shortcuts." — appears in `src/prompts.ts` in each host's system prompt.

### Consumption

When surfaced behaviors appear in the nudge, the agent evaluates each against
the current situation:

- If relevant (ham): follows the rule and calls `behavior_feedback` with
  `relevant: true` (confirm).
- If not relevant (spam): calls `behavior_feedback` with `relevant: false`
  (disconfirm).

This trains the classifier so future nudges are more accurate. Behaviors
that consistently score as spam will drop in confidence and eventually fall
below the auto-fire threshold.

## Interactions with other features

- **Nudge pipeline** ([nudge-pipeline.md](nudge-pipeline.md)): behavior
  auto-fire is tier 4. Shares the prompt embedding with recall (tier 2) and
  prediction (tier 3).
- **Prediction engine** ([prediction-engine.md](prediction-engine.md)): same
  four-table data model, same Bayesian confidence, same scoring engine.
  Different semantics and different grading — user feedback vs. self
  feedback.
- **Scoring engine**: `src/scoring-engine.ts` provides the generic
  four-table scoring base. `BehaviorEngine` (`src/behavior.ts`) is a thin
  wrapper with behavior-specific table names.
- **Memory store** ([memory-store.md](memory-store.md)): same embedding
  model (BGE-small-en-v1.5), same SQLite DB, different tables.
- **Sideband IPC** ([sideband.md](sideband.md)): MCP hosts query behaviors
  via the sideband socket's `behaviors` method.

## Source files

| File | Role |
|------|------|
| `src/behavior.ts` | Thin wrapper around `ScoringEngine` with behavior-specific table names |
| `src/scoring-engine.ts` | Generic four-table scoring engine with Bayesian confidence (shared base for prediction and behavior) |
| `src/seed-behaviors.ts` | Default behavior seeding at startup — version-stamped, idempotent across releases |
| `src/db.ts` | Behavior tables, `scoreBehaviorNudge` delegation |
| `src/tool-defs.ts` | Four behavior tools (`codify`, `feedback`, `list`, `delete`) |
| `src/prompts.ts` | `behaviorNudge` formatting, verb selection ("consider" vs "do"), anti-laziness guard |
| `src/sideband.ts` | `behaviors` method for the MCP path |

## Database tables

```sql
behavior_matchers(
    id          TEXT PRIMARY KEY,
    store       TEXT NOT NULL REFERENCES stores(name),
    description TEXT NOT NULL,
    embedding   BLOB,
    model       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)

behaviors(
    id               TEXT PRIMARY KEY,
    store            TEXT NOT NULL REFERENCES stores(name),
    statement        TEXT NOT NULL,
    rationale        TEXT,
    embedding        BLOB,
    model            TEXT,
    confidence       REAL NOT NULL DEFAULT 0.5,
    confirm_count    REAL NOT NULL DEFAULT 0,
    disconfirm_count REAL NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)

behavior_edges(
    matcher_id  TEXT NOT NULL,
    behavior_id TEXT NOT NULL,
    weight      REAL NOT NULL DEFAULT 1.0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (matcher_id, behavior_id),
    FOREIGN KEY (matcher_id)  REFERENCES behavior_matchers(id) ON DELETE CASCADE,
    FOREIGN KEY (behavior_id) REFERENCES behaviors(id)         ON DELETE CASCADE
)

behavior_provenance(
    id          TEXT PRIMARY KEY,
    behavior_id TEXT NOT NULL,
    signal      TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    FOREIGN KEY (behavior_id) REFERENCES behaviors(id) ON DELETE CASCADE
)
```

## Key invariants

1. **The firewall principle does NOT apply.** The LLM grading its own
   behaviors is the point. Ham/spam is a relevance judgment, not a value
   judgment.

2. **Anti-laziness guard prevents codifying shortcuts.** Rules must encode
   discipline, not shortcuts. The guard text is in the system prompt for all
   host variants.

3. **Same `scoreBehaviorNudge` entry point** in both host paths (opencode
   `chat.message` hook and MCP sideband) prevents scoring drift.

4. **Default behavior seeding is idempotent.** Version stamps in the
   rationale text allow re-seeding when content changes across releases
   without duplicating rows.

5. **One embedding computation serves recall, prediction, and behavior.**
   The prompt is embedded once at `chat.message`; three separate cosine
   scans run against different tables.

6. **Dedup at creation.** Cosine >= 0.85 for both matchers and behaviors.
