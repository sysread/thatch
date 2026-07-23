# Prediction engine (in progress)

> **Status: implementation complete across both host paths.** The
> schema, tools, auto-fire (opencode), sideband prediction fire (MCP),
> prompt instructions, and tests are shipped and passing the quality
> gate. The feature is ready for field testing. This doc is the live
> ledger; when the work closes, graduate durable parts into a permanent
> `docs/dev/prediction-engine.md` and retire this file.

## Purpose

A **user decision model** that learns the user's preferences for
judgment calls the coding agent faces every session: scope (how much to
do), appropriateness (is this the right thing), methodology (the right
way). The agent gets a "guess what the user would want in this
situation" system -- inspired by nak's samskara predictive model, but
different mechanism and domain.

The delta over flat thatch memory is three things flat memory cannot do:

1. **Graded confidence** -- memory is binary (stored or not).
   Predictions have a Bayesian posterior that is reinforced or weakened
   by user feedback. This enables ambiguity-surfacing: when confidence
   is thin or predictions conflict, the agent asks the user instead of
   guessing.
2. **Context-disambiguation** -- matchers separate "when" from "what."
   The same topic (tech debt in a PR) can produce opposite predictions
   in different situations (flaky test blocking CI = fix it; unrelated
   to change = skip it). Flat memory encodes this in prose the LLM must
   re-reason about every time; the prediction engine encodes it as
   structure.
3. **Agent-driven feedback loop** -- the LLM itself decides to
   strengthen or weaken a prediction based on user feedback, creating a
   loop that flat memory lacks.

## Design decisions (settled)

These came out of design discussion with Jeff, July 2026. They are
constraints, not open questions.

1. **Auto-fire at chat.message.** The hook already embeds the user's
   text for the recall nudge. The prediction fire shares that embedding
   and does a second cosine search against the matchers table. When
   matchers clear a relevance floor, scored predictions are injected as
   a synthetic nudge part. No matchers fire = nothing injected (zero
   tokens, zero latency). No "if appropriate" hedging -- the block's
   presence is the appropriateness signal.

2. **Tool-based update, agent-driven.** No local LLM classifier. Prompt
   instructions tell the agent: when the user corrects you, answers a
   question, or provides a clear signal, use prediction_update to
   create/reinforce/weaken a prediction. The LLM decides with
   appropriately nuanced prompt instructions; the tool is the trusted
   boundary that handles embedding, dedup, and confidence math.

3. **Statistical model query, not AI.** The query (embed + cosine +
   weighted edges) is mechanical -- same as thatch_memory_recall but
   against different tables. No model call. The agent can also call
   prediction_query explicitly when it wants to check the model before a
   judgment call.

4. **No local LLM.** Considered and declined. The host LLM is already
   reading the message and classifying "was this a correction?" as part
   of understanding it. Adding a second classifier pays twice for the
   same answer. The cost of not having a classifier is wasted nudge text
   on turns with no signal -- not wasted model calls.

5. **Descriptive context, not directive.** The injected block reads
   "[0.72 conf, 4 tests] When X: you tend to Y" -- same shape as
   samskara's compound summary. The system prompt instructions govern
   how to act on it (follow strong silently, surface weak/competing,
   update on user response). No "if appropriate" or "consider" hedging
   in the injection itself.

6. **Confidence mirrors samskara health.** A Bayesian posterior with
   population-prior shrinkage: `confidence = (confirm + k*p0) /
   (confirm + disconfirm + k)`. No wall-clock decay -- relevance-gated,
   like samskara. Being tested (user gives feedback) is what moves
   confidence. Untested predictions stay at p0.

7. **LLM is the conflict detector.** The auto-fire returns all
   predictions from matching matchers, not just the top one. The LLM
   reads competing predictions and decides whether they conflict. No
   mechanical conflict heuristic -- the LLM is better at semantic
   conflict detection than any rule.

## The normative asymmetry (carried from samskara)

Samskara's intents doc identifies a normative asymmetry: the descriptive
layer (samskara predictions) is ethically free to surface, but the
normative layer (intents -- "what the model is working toward") carries
weight because it shapes behavior. The prediction engine is descriptive
("you tend to prefer X"), not normative ("I'm working toward X with
you"). It reads user behavior, it does not pursue an agenda. The
firewall from samskara's efficacy model carries over: the model that
uses predictions cannot grade its own predictions -- the user's
feedback is the only signal that moves confidence.

## Data model

Four new tables in the same SQLite DB, same conventions as the existing
`entries`/`dedup_pairs` tables (idempotent CREATE TABLE IF NOT EXISTS,
BLOB embeddings, store column, crypto.randomUUID PKs).

### `prediction_matchers`

Context patterns describing situations. The "when."

- `id TEXT PRIMARY KEY` (crypto.randomUUID).
- `store TEXT NOT NULL`.
- `description TEXT NOT NULL` -- "reviewing a PR with pre-existing tech
  debt."
- `embedding BLOB` -- 384-dim Float32Array, passageEmbed (no query
  prefix; matchers are passages, not queries).
- `model TEXT`.
- `created_at`, `updated_at` -- ISO timestamps.

### `predictions`

User preference statements. The "what."

- `id TEXT PRIMARY KEY`.
- `store TEXT NOT NULL`.
- `statement TEXT NOT NULL` -- "skip it unless it's blocking this
  change."
- `rationale TEXT` -- why this prediction exists (inspector context).
- `embedding BLOB` -- for dedup at creation time.
- `model TEXT`.
- `confidence REAL NOT NULL DEFAULT 0.5` -- Bayesian posterior [0,1].
- `confirm_count REAL NOT NULL DEFAULT 0` -- fractional (soft signals
  are sub-unit).
- `disconfirm_count REAL NOT NULL DEFAULT 0` -- same.
- `created_at`, `updated_at`.

### `prediction_edges`

Weighted matcher-to-prediction links. The "context-dependence."

- `matcher_id TEXT NOT NULL` (FK to prediction_matchers, CASCADE).
- `prediction_id TEXT NOT NULL` (FK to predictions, CASCADE).
- `weight REAL NOT NULL DEFAULT 1.0`.
- `created_at`.
- `PRIMARY KEY (matcher_id, prediction_id)`.

### `prediction_provenance`

Audit trail. Gives the inspector context and the agent "plenty of
context" for nuance.

- `id TEXT PRIMARY KEY`.
- `prediction_id TEXT NOT NULL` (FK to predictions, CASCADE).
- `signal TEXT NOT NULL` -- 'confirm' | 'disconfirm' | 'soft' |
  'create'.
- `detail TEXT` -- what the user said or did.
- `created_at`.

## Confidence model

Mirrors samskara's health posterior with population-prior shrinkage.

```
confidence = (confirm_count + k * p0) / (confirm_count + disconfirm_count + k)

k      = 5     (prior strength, pseudo-count)
p0     = 0.5   (population baseline; make population-derived later)
W_SOFT = 0.25  (soft miss weight, same as samskara)
```

- `confirm` signal: confirm_count += 1.
- `disconfirm` signal: disconfirm_count += 1.
- `soft` signal: disconfirm_count += W_SOFT (0.25).
- `create` signal: no confidence adjustment, just seeds at p0.
- No wall-clock decay. Relevance-gated: being tested (user gives
  feedback) is what moves confidence. Untested = stays at p0.
- confirm_count / disconfirm_count are REAL (fractional). An integer
  column would truncate soft signals to 0 (samskara's bug).
- p0 starts at 0.5 for v1. Later: `populationP0(store)` = sum(confirm) /
  sum(confirm + disconfirm), with a 0.5 fallback under 20 evidence.

## Scoring at query time

```
score = cosine(user_text, matcher.embedding) * edge.weight * prediction.confidence
```

The auto-fire returns all predictions from matching matchers (not just
the top scoring one), so the LLM can read conflicts. The score is for
ranking and display, not for a mechanical "follow if above X" gate --
the LLM decides whether to follow, surface, or ignore, informed by the
confidence and evidence count shown alongside.

## Ambiguity-surfacing (the killer feature)

- **Strong prediction** (high confidence, sufficient evidence) -> agent
  follows silently, does not interrupt.
- **No prediction** -> agent asks the user (same as today).
- **Ambiguous or competing predictions** -> agent surfaces naturally:
  "I think you usually prefer X here, but I'm not sure -- what do you
  want?"
- **User responds to a surfaced prediction** -> agent calls
  prediction_update to reinforce or weaken.

Value = fewer interruptions, not more. High-confidence predictions
suppress questions the agent would otherwise ask.

## Tool surface

Four tools, following the existing ToolDef pattern in tool-defs.ts.

### `prediction_query`

Mechanical search. Returns scored predictions with matcher
description, confidence, and evidence count.

Args: `context` (string), `store` (optional).

### `prediction_update`

The trusted boundary. The agent says "here's the situation, here's the
preference, here's what happened." The tool handles: embed matcher,
find/create by cosine dedup, embed prediction, find/create by cosine
dedup, adjust confidence, record provenance.

Args: `matcher` (string), `prediction` (string), `signal` (confirm |
disconfirm | soft | create), `rationale` (string), `store` (optional).

### `prediction_list`

Inspector. Lists all predictions with confidence, evidence, matchers,
and rationale.

Args: `store` (optional).

## Auto-fire in chat.message hook

Slots into the existing recall-nudge path in index.ts, sharing the
embedding call. After the recall nudge block, before the catch:

```
embedding = await model.queryEmbed(promptText)  // already computed

// recall nudge (existing)
results = db.search([repo, "global"], embedding, { limit: 5 })
if matches >= RECALL_THRESHOLD -> inject recallNudge

// prediction fire (new)
predItems = db.scorePredictionNudge([repo, "global"], embedding, PREDICTION_THRESHOLD)
if predItems.length > 0:
    output.parts.push(predictionNudge(predItems))  // synthetic: true
```

One more cosine scan against a separate table. Same brute-force
pattern, same cost profile. No extra embedding call.

## System prompt instructions

New section in all three prompt variants (systemPrompt,
claudeInstructions, cursorInstructions), after "Before Responding."

New tools registered in the tool list line:
`thatch_prediction_query`, `thatch_prediction_update`,
`thatch_prediction_list` (opencode); bare names for MCP.

The injected block format:

```
## User decision model
- [0.72 conf, 4 tests] When reviewing a PR with pre-existing tech debt: you tend to skip it unless it's blocking the change
- [0.61 conf, 2 tests] When the tech debt is a flaky test: you've preferred fixing it
```

Prompt instructions:
- Follow strong predictions silently.
- Surface weak or competing predictions to the user naturally.
- When the user responds to a surfaced prediction, use
  prediction_update to reinforce or weaken.
- When the user corrects you, answers a question, or provides a clear
  signal, use prediction_query then prediction_update.

## Constants

```
PREDICTION_THRESHOLD   = 0.45  // lower than RECALL_THRESHOLD (0.55)
MATCHER_DEDUP_COSINE   = 0.85  // near-duplicate check at creation
PREDICTION_DEDUP_COSINE = 0.85
P0                     = 0.5   // prior (population-derived later)
K                      = 5     // prior strength
W_SOFT                 = 0.25  // soft miss weight
```

## Hook integration

The `tool.execute.after` hook (index.ts) already skips
`thatch_*`-prefixed tools from the extraction buffer.
`thatch_prediction_*` is caught by that check -- no special handling
needed. MCP path same: `mcp__thatch__prediction_*` caught by the
`mcp__thatch__*` filter in extract-queue.ts.

Prediction calls do NOT drain the extraction buffer -- they are a
separate system. The agent may do both in the same turn (save a memory
AND update a prediction).

## Build status

Landed so far:

1. DB schema + methods (db.ts) -- four new tables (prediction_matchers,
   predictions, prediction_edges, prediction_provenance) in #initSchema,
   plus findMatchers, scorePredictions, findNearestMatcher,
   findNearestPrediction, createMatcher, createPrediction, createEdge,
   adjustConfidence, addProvenance, listPredictions, populationP0,
   getPrediction, getProvenance, deletePrediction, scorePredictionNudge.
   Confidence uses Bayesian posterior with k=5, p0=0.5, W_SOFT=0.25.
2. Tool definitions (tool-defs.ts) -- prediction_query,
   prediction_update, prediction_list, prediction_delete. Added to
   TOOL_DEFS array (9 -> 13).
3. Auto-fire (index.ts) -- prediction fire in chat.message hook,
   sharing embedding with recall nudge. Prediction blocks injected
   when matchers clear PREDICTION_THRESHOLD (0.45). predictionNudge
   formatter in prompts.ts.
4. System prompt (prompts.ts) -- "User Decision Model" section in all
   three variants (systemPrompt, claudeInstructions,
   cursorInstructions). New tools in all three tool lists.
5. Tools wiring (tools.ts + mcp.ts) -- automatic via TOOL_DEFS
   iteration. No manual changes needed.
6. Tests -- tests/prediction.test.ts (schema, confidence math, dedup,
   scoring, provenance, listPredictions, populationP0). Updated
   tool-defs.test.ts and plugin.test.ts tool count assertions (9 -> 13).
7. MCP path (sideband.ts + bin/thatch) -- the sideband server now
   handles `method: "predictions"` alongside `method: "match"`, so
   the warm MCP server can query matchers and score predictions for
   one-shot hook processes. The `flush-tools` CLI subcommand (already
   wired into UserPromptSubmit hooks for Claude Code and Cursor) now
   fires predictions alongside the recall nudge in its tier 2 block,
   sharing one sideband round-trip via `Promise.all`. A standalone
   `flush-predictions` subcommand is also available for testing.
   No new hook installation needed -- the existing `flush-tools` hook
   covers it.

Future enhancements:

1. **p0 population derivation** -- v1 uses flat 0.5. Once enough
   predictions accumulate, switch to population-derived p0 per store.
2. **Auto-fire block separation** -- separate synthetic part from the
   recall nudge, or combined? Starting with separate (simpler).
3. **Inspector UI** -- `thatch prediction list` CLI subcommand for
   terminal inspection. No Svelte UI (thatch has no UI).
4. **Score formula tuning** -- v1 is `cosine * weight * confidence`.
   If confidence dominates (high confidence on weak cosine swamps low
   confidence on strong cosine), add samskara's `cosine^1.3` power.
   Start simple; let data drive.
5. **Edge weight tuning** -- v1 is flat 1.0 for all edges. The weight
   encodes context-dependence but we have no signal to set it yet.
   Could later set it from the matcher's cosine at creation time
   (stronger match = higher weight) or from co-occurrence statistics.

## Interactions

- **Memory** (existing) -- distinct system. Memory is facts the
  agent/user committed; predictions are learned preferences with graded
  confidence. No data flows between them. The agent may write a memory
  about a preference AND update a prediction about the same preference;
  the memory is the "what" (durable fact), the prediction is the "how
  confident" (graded, updated by feedback).
- **Extraction pipeline** (existing) -- prediction tools are excluded
  from the extraction buffer by the thatch_* prefix filter. No
  feedback loop.
- **Recall nudge** (existing) -- the prediction fire shares the
  embedding call and runs in the same chat.message hook path (opencode)
  or the same sideband round-trip (MCP). The two nudges are separate
  synthetic parts (opencode) or combined in one output block (MCP);
  either can be absent.
- **Sideband** (existing, MCP path) -- the sideband server now handles
  a `predictions` method alongside `match`. The `flush-tools` CLI
  subcommand queries both in parallel via `Promise.all`.
- **Compaction guard** (existing) -- the compacting set check at the
  top of chat.message suppresses ALL nudges, including prediction fire.
  No change needed.

## Gotchas

- **Matcher embeddings use passageEmbed, not queryEmbed.** Matchers
  are passages (stored content matched against), not queries. The query
  prefix applies to the user's text at fire time. Same pattern as
  remember() which uses passageEmbed for content.
- **confirm_count / disconfirm_count MUST be REAL.** An integer column
  truncates soft signals (W_SOFT = 0.25) to 0 and freezes confidence at
  p0. This is the same bug samskara had.
- **Cold start is free.** Empty matchers table, findMatchers returns
  [], nothing injected. The feature is inert until the first
  prediction_update call. No migration, no config.
- **Prediction calls do not drain the extraction buffer.** They are a
  separate system. The agent may do both in the same turn.

## Reference

- nak samskara: `docs/dev/samskara.md` in the nak repo (the predictive
  model of the user this feature is inspired by).
- nak intents: `docs/dev/in-progress/intents.md` in the nak repo (the
  normative layer atop samskara; the C efficacy model and firewall
  between employment and efficacy informed the confidence model here).
- thatch memory: this doc's "Interactions" section.
- thatch extraction pipeline: `docs/dev/README.md` + `docs/dev/mcp-parity.md`.
- thatch hook surface: `docs/dev/setup-and-hooks.md`, `docs/dev/gotchas.md`.