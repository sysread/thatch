# UC-022: Prediction create-on-existing (dedup + link)

**Preconditions**
- An opencode session with at least one existing prediction (from UC-021 or seeded directly)
- The existing prediction's matcher context is semantically similar to a new observation

**Steps**

1. Seed a prediction: `prediction_update(matcher="reviewing a PR", prediction="go through findings one at a time using a todo list", signal="create")`.
2. In the same or a new session, call `prediction_update(matcher="code review session", prediction="go through findings one at a time using a todo list", signal="create")`.
3. Call `prediction_update(matcher="code review session", prediction="go through findings one at a time using a todo list", signal="confirm")`.
4. Call `prediction_list` to inspect the model.

**Expected**
- Step 2: `findNearestPrediction` finds the existing prediction (cosine > 0.85). The tool returns `[linked]` (not `[created]`). The new matcher is linked via an edge. No duplicate prediction is created. Confidence is unchanged (create is confidence-neutral).
- Step 3: Same prediction is found. The matcher edge already exists (ON CONFLICT DO NOTHING). Confidence is adjusted upward by the confirm signal. Returns `[confirm]` with updated confidence.
- Step 4: `prediction_list` shows one prediction with two matchers ("reviewing a PR" and "code review session"), confidence reflecting one confirm, and provenance entries for both the create and confirm signals.

_Automatable: yes — the create-on-existing path is tested in `tool-defs.test.ts` (prediction_update create on existing prediction links without disconfirming). The dedup + edge + confidence behavior is verified with assertions on the return value and prediction_list output._
