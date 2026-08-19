# Per-Message Nudge Pipeline

Runs on every user message. Four priority tiers share one embedding
computation. The pipeline injects *synthetic parts*---text the model sees in
the conversation but the user does not see in the TUI. This is the inverse of
toast notifications, which are TUI-visible but model-invisible.

The nudge pipeline is thatch's core innovation. It is not a passive
store-and-retrieve system. It is a nudge layer that changes agent behavior by
injecting context at the right moment. See [extraction.md](extraction.md) for
the extraction nudge, [prediction-engine.md](prediction-engine.md) for the
prediction auto-fire, and [behavior-engine.md](behavior-engine.md) for the
behavior auto-fire.

## What it does

On every user message, thatch runs through four priority tiers:

1. **Extraction nudge**---if tool interactions are buffered, tell the agent to
   extract memories.
2. **Recall nudge**---semantically search stored memories for context
   relevant to the user's prompt.
3. **Prediction nudge**---surface user decision-model predictions relevant to
   the current situation.
4. **Behavior nudge**---surface LLM self-discipline rules relevant to the
   current situation.

Tiers 2--4 fire independently and share one embedding computation. Tier 1
returns early, skipping tiers 2--4.

## How it works

Two host paths deliver the same four tiers through different mechanisms. The
opencode path runs in-process with direct event hooks. The MCP path runs via
external CLI hook processes that communicate with the long-lived MCP server
through the sideband socket.

### opencode path (`src/index.ts`, `chat.message` hook)

#### Compaction guard

If the session is in the `compacting` set, thatch checks whether the incoming
message is a compaction summary. If it is, all nudges are suppressed---tools
are blocked during summary generation, so a nudge that says "call
`thatch_memory_recall`" would trigger a blocked-tool error. If the message is
not a compaction summary, compaction has already failed (the auto-continue
never fired). Thatch clears the stale `compacting` flag and proceeds normally.
See [compaction-recovery.md](compaction-recovery.md).

#### Tier 1---Extraction nudge (fallback path)

Fires only when direct extraction was never triggered or threw (the session is
not in the `extracting` set) **and** the in-memory buffer has pending
interactions.

- Injects `extractionNudge(count, missed, "thatch_memory_remember", sessionID)`
  as a synthetic text part.
- Increments the `missedNudges` counter for escalation: polite at 0, insistent
  at 2, ALL-CAPS shouting at 3+.
- Returns early. Tiers 2--4 are skipped.

See [extraction.md](extraction.md) for the full extraction pipeline, including
the accept/complete/requeue lifecycle and the `extracting` set.

#### Tier 2---Recall nudge

- Extracts user prompt text from non-synthetic text parts. Skips if the text
  is shorter than `MIN_PROMPT_LEN` (10 characters, hardcoded). Trivially short
  prompts like "yes" or "ok" match too broadly to be useful.
- Embeds the prompt with the warm in-process model: `model.queryEmbed(text)`.
- Searches memories via `db.search([repo, "global"], embedding, { limit: 5 })`.
  This uses `db.search`, not `db.recall`, to avoid inflating recall telemetry.
  The agent has not actually read the memories yet---the nudge only checks
  whether they relate to the prompt.
- Filters results to `_score >= RECALL_THRESHOLD` (0.55, env:
  `THATCH_RECALL_THRESHOLD`).
- If matches survive: injects `recallNudge(matches)` as a synthetic text part
  and fires a toast notification via `client.tui.showToast`.
- Wrapped in its own try/catch. A recall failure does not block prediction or
  behavior tiers.

#### Tier 3---Prediction auto-fire

- Reuses the same embedding from tier 2. No extra model call.
- Scores prediction matchers via
  `db.scorePredictionNudge([repo, "global"], embedding, PREDICTION_THRESHOLD)`.
  This is a mechanical query: cosine-match against matchers, then score linked
  predictions by Bayesian confidence.
- Threshold: 0.60 (env: `THATCH_PREDICTION_THRESHOLD`). Higher than recall
  because surfacing a preference nudge is more disruptive---the agent may act
  on it or surface it to the user.
- If matches: injects `predictionNudge(items)` as a synthetic text part and
  fires a toast.
- Independent try/catch.

See [prediction-engine.md](prediction-engine.md) for the confidence model,
matcher/prediction/edge data model, and the ambiguity-surfacing behavior.

#### Tier 4---Behavior auto-fire

- Reuses the same embedding. One more cosine scan, this time against
  `behavior_matchers`.
- Scores via
  `db.scoreBehaviorNudge([repo, "global"], embedding, BEHAVIOR_THRESHOLD)`.
- Threshold: 0.60 (env: `THATCH_BEHAVIOR_THRESHOLD`).
- If matches: injects `behaviorNudge(items)` as a synthetic text part and
  fires a toast.
- Independent try/catch.

See [behavior-engine.md](behavior-engine.md) for the ham/spam feedback loop
and the self-discipline rule data model.

#### Tier independence

Tiers 2, 3, and 4 all fire independently. Any subset may inject. All share
one embedding computation. The embedding is computed once, after the
extraction tier returns early, and is reused across three cosine scans against
different tables.

### MCP path (`bin/thatch`, `flush-tools` subcommand)

The `flush-tools` subcommand fires on `UserPromptSubmit` (Claude Code) or
`beforeSubmitPrompt` (Cursor). It reads JSON from stdin:

```json
{
  "session_id": "...",
  "conversation_id": "...",
  "prompt": "...",
  "message": "...",
  "text": "...",
  "user_input": "...",
  "input": "..."
}
```

Session ID is `session_id ?? conversation_id`. Prompt text is the first
present field from `prompt`, `message`, `text`, `user_input`, `input`.

Three priority tiers, first match wins:

#### Tier 1---Extraction nudge

- `peekQueue(sessionID)` peeks the file-backed JSONL queue without draining
  it. The queue persists until the agent calls `memory_remember`, which
  triggers `consumeQueue`.
- If interactions are pending: increments the missed count, prints
  `extractionNudge(count, missed, "mcp__thatch__memory_remember", sessionID)`.
- Breaks. Tiers 2--3 are skipped.

See [extraction.md](extraction.md) for the file-backed queue and the
`buffer-batch` subcommand that populates it.

#### Tier 2---Recall + prediction + behavior via sideband

- Extracts prompt text. Skips if shorter than 10 characters.
- Connects to the sideband socket and fetches all three in parallel:
  `sidebandMatch`, `sidebandPredictions`, `sidebandBehaviors`.
- Same thresholds as opencode: 0.55 recall, 0.60 prediction, 0.60 behavior.
- Concatenates any non-empty results: `claudeRecallNudge`,
  `predictionNudge`, `behaviorNudge`.
- Prints to stdout. Breaks.

The sideband socket lets short-lived hook processes use the warm embedding
model in the long-lived MCP server, avoiding a cold ~34 MB model load on every
prompt. See [sideband.md](sideband.md) for the socket protocol.

#### Tier 3---Static write nudge

Fallback for conversational turns with no tool use and no memory matches.
Prints `claudeWriteNudge()`:

> After responding, check: did you learn new project knowledge, user
> preferences, or corrections worth persisting? If so, save to thatch.

On any error, falls back to the static write nudge. If that import also fails,
silent failure---the hook never blocks the user's prompt over an unrelated
error.

### `flush-predictions` subcommand

Standalone prediction fire---queries the sideband for scored predictions
only. Not installed as a hook. Exists for testing and for hosts that want
prediction-only output. `flush-tools` already fires predictions in tier 2.

### Output format

- **Claude Code**: plain text to stdout. Claude Code feeds hook stdout into
  the agent's context.
- **Cursor**: `--json` flag wraps output as `{ additional_context: "..." }`.
  Cursor injects `additional_context` into the session.

## Thresholds

All thresholds are env-overridable.

| Threshold | Default | Env var |
|-----------|---------|---------|
| Recall nudge | 0.55 | `THATCH_RECALL_THRESHOLD` |
| Prediction auto-fire | 0.60 | `THATCH_PREDICTION_THRESHOLD` |
| Behavior auto-fire | 0.60 | `THATCH_BEHAVIOR_THRESHOLD` |
| Min prompt length | 10 chars | hardcoded (`MIN_PROMPT_LEN`) |

The recall threshold (0.55) is lower than `findDuplicates`'s 0.85 because
"relates to" is a weaker signal than "duplicate." The prediction and behavior
thresholds (0.60) are higher than recall because surfacing a preference or
self-discipline rule is more disruptive than surfacing a memory---the agent
may act on it or interrupt the user.

## Toast notifications (opencode only)

`client.tui.showToast` is best-effort. If the TUI is not connected (headless
mode), the call is silently ignored. Toasts are model-invisible: they go to
the user only, not into the conversation history.

| Trigger | Message | Variant | Duration |
|---------|---------|---------|----------|
| Recall matches | recalled N memories | info | 3s |
| Prediction matches | N predictions surfaced | info | 3s |
| Behavior matches | N behaviors surfaced | info | 3s |
| Extraction child goes idle | new: N, updated: M, deleted: K | success | 4s |

The extraction metrics toast fires only when memories were actually written.
No-save runs produce no toast to avoid notification fatigue.

## Synthetic nudge parts (opencode only)

Nudges are injected via `client.session.prompt` with `noReply: true` and
`synthetic: true`. The `synthetic` flag is a TUI-visibility marker, not a
model-routing flag. The model sees the nudge text in the conversation. The
user does not see it in the TUI transcript. This asymmetry is what makes the
nudge-injection pattern work: the model can act on the nudge without
cluttering the user's view.

Do not confuse `synthetic` with `ignored`. A part marked `ignored` is dropped
from the LLM-bound message. A part marked `synthetic` is only hidden from the
TUI display. The opencode framework's history serializer filters on
`!part.ignored`, not `!part.synthetic`.

## Interactions with other features

- **Extraction pipeline** ([extraction.md](extraction.md)): tier 1 is the
  extraction nudge. The `extracting` set suppresses tier 1 when direct
  extraction is active.
- **Memory store** ([memory-store.md](memory-store.md)): tier 2 searches
  stored memories via `db.search()`. This path records no telemetry---the
  agent has not read the memories yet.
- **Prediction engine** ([prediction-engine.md](prediction-engine.md)): tier
  3 scores prediction matchers by cosine, then scores linked predictions by
  Bayesian confidence.
- **Behavior engine** ([behavior-engine.md](behavior-engine.md)): tier 4
  scores behavior matchers by cosine, then scores linked behaviors by
  ham/spam confidence.
- **Sideband IPC** ([sideband.md](sideband.md)): MCP hosts use the sideband
  socket for warm-model access. The hook process sends the prompt text; the
  MCP server embeds it and runs the cosine scans.
- **Compaction recovery** ([compaction-recovery.md](compaction-recovery.md)):
  the nudge pipeline is suppressed during compaction. The compaction guard
  clears stale flags when compaction fails.
- **Session lifecycle** ([session-lifecycle.md](session-lifecycle.md)):
  direct extraction (`triggerExtraction`) suppresses tier 1 by adding the
  session to the `extracting` set.

## Source files

| File | Role |
|------|------|
| `src/index.ts` | opencode: `chat.message` hook (all 4 tiers), compaction guard, extraction fallback |
| `bin/thatch` | MCP: `flush-tools` and `flush-predictions` subcommands |
| `src/sideband.ts` | MCP: sideband client helpers (`sidebandMatch`, `sidebandPredictions`, `sidebandBehaviors`) |
| `src/prompts.ts` | All nudge formatting functions (`recallNudge`, `claudeRecallNudge`, `predictionNudge`, `behaviorNudge`, `extractionNudge`, `claudeWriteNudge`) |

## Key invariants

- Tier 1 (extraction) returns early. Tiers 2-4 are skipped when tier 1 fires.
- Tiers 2-4 share one embedding computation. One embed, three cosine scans against different tables.
- Each tier is wrapped in its own try/catch. A failure in one tier does not block the others.
- The recall nudge uses `db.search()`, not `db.recall()`, to avoid inflating telemetry. The agent has not read the memories yet.
- The recall threshold (0.55) is lower than prediction/behavior (0.60) because "relates to" is weaker than "should surface to user."
- Nudges are suppressed during compaction. Tools are blocked during summary generation, so a nudge saying "call `memory_recall`" would trigger a blocked-tool error.
- `synthetic` means TUI-invisible, not model-invisible. The model sees the nudge text; the user does not. Do not confuse with `ignored`, which drops the part from the LLM-bound message.
- MCP host hooks must be silent on success. Only `flush-tools` prints. Any stdout from other hooks delays the agent loop.
