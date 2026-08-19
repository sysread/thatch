# Prediction Engine

Thatch learns your decision-making preferences over time. When you correct
the agent, answer its questions, or express a preference, thatch
records it as a prediction. On future sessions, if your prompt
semantically matches a learned context, thatch surfaces the prediction
as a nudge the agent can follow.

## How it works

Predictions are context-dependent. Each prediction has two parts:

- **Matcher**: a description of the situation ("when reviewing a PR
  with tech debt"). This is what gets embedded and matched against
  your prompt.
- **Prediction**: the preference statement ("flag tech debt before
  reviewing the diff"). This is what the agent reads and follows.

A matcher can link to multiple predictions (different preferences for the
same situation). A prediction can be linked from multiple matchers (the
same preference applies in different situations).

## Confidence

Each prediction has a confidence score from 0 to 1, based on a Bayesian
posterior:

- Starts at 0.5 (no evidence either way).
- Each confirm moves it up. Each disconfirm moves it down.
- Soft signals count as 0.25 of a full signal (weak disconfirm).
- No wall-clock decay. Confidence only moves when you provide feedback.

The agent follows strong predictions silently, surfaces ambiguous or
competing predictions to you, and updates the model when you respond.

## Auto-fire

When you send a prompt, thatch embeds it and searches for matching
matchers. If any match above the threshold (default 0.60), thatch injects
a `User decision model` block into the agent's context. The block looks
like:

```text
[thatch] User decision model
- [0.72 conf, 4 tests] When reviewing a PR with tech debt: you tend to
  flag tech debt before reviewing the diff
- [0.61 conf, 2 tests] When choosing test scope: you may prefer
  integration tests over unit tests
```

The agent reads this and decides whether to follow the prediction,
surface it to you, or ignore it. You never see the nudge directly.

## Tools

| Tool | What it does |
|------|-------------|
| `thatch_prediction_query` | Query the model for predictions matching a context. Returns scored predictions with confidence and evidence count. |
| `thatch_prediction_update` | Create, reinforce, or weaken a prediction. Takes a matcher (situation), prediction (preference), signal (confirm/disconfirm/soft/create), and rationale. |
| `thatch_prediction_list` | List all predictions with matchers, confidence, evidence count, and provenance history. |
| `thatch_prediction_delete` | Delete a prediction by semantic match. Edges and provenance are cascade-deleted. |

## Configuration

- `THATCH_PREDICTION_THRESHOLD`: cosine score threshold for prediction
  auto-fire. Defaults to 0.60. Lower surfaces more predictions
  (noisier); higher surfaces fewer (stricter).

## Limitations

- The agent creates predictions based on your feedback. Thatch never
  creates predictions on its own. If the agent does not proactively
  record your preferences, the model stays empty.
- There is no formation nudge. The system prompt instructs the agent
  to watch for preference signals, but the agent must decide to act on
  those instructions.
- 0-evidence predictions (confidence 0.5) still surface. The nudge
  uses "you may prefer" language for these, which hedges appropriately.
- Confidence never reaches 0 or 1. A disconfirmed prediction can still
  fire if its matcher matches strongly. Delete it with
  `thatch_prediction_delete` if it is wrong.
- Predictions are per-store. A preference learned in one project's
  store does not automatically apply to other projects. The global
  store is shared across projects.

See [memory.md](memory.md) for the base memory system and
[behavior-engine.md](behavior-engine.md) for the self-discipline rules.
