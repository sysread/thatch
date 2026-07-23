# UC-023: Prediction confidence and signal model

**Preconditions**
- An opencode or Claude Code / Cursor session with the prediction model seeded

**Steps**

1. `prediction_update(matcher="X", prediction="Y", signal="create")` — seeds at p0 (0.50, 0 evidence).
2. `prediction_update(matcher="X", prediction="Y", signal="confirm")` — user confirmed.
3. `prediction_update(matcher="X", prediction="Y", signal="soft")` — user partially disagreed.
4. `prediction_update(matcher="X", prediction="Y", signal="disconfirm")` — user pushed back.
5. `prediction_list` to inspect confidence and evidence counts.
6. `prediction_query(context="X")` to query the model.

**Expected**
- Step 1: Returns `[created]`, confidence=0.50, counts (0/0).
- Step 2: Returns `[confirm]`, confidence > 0.50. Formula: (1 + 5*0.5) / (1 + 0 + 5) = 0.583. Counts (1/0).
- Step 3: Returns `[soft]`, confidence drops slightly. Soft adds 0.25 to disconfirm_count. Formula: (1 + 2.5) / (1 + 0.25 + 5) = 0.571. Counts (1/0.25).
- Step 4: Returns `[disconfirm]`, confidence drops further. Formula: (1 + 2.5) / (1 + 1.25 + 5) = 0.524. Counts (1/1.25).
- Step 5: `prediction_list` shows the prediction with accumulated provenance entries (create, confirm, soft, disconfirm) sorted newest-first.
- Step 6: `prediction_query` returns the prediction with the current confidence and evidence count. Uses "you may prefer" for 0-evidence and "you tend to" for predictions with evidence. Threshold (0.45) filters out matchers below the relevance floor.

_Automatable: yes — the confidence math and signal mapping are tested in `prediction.test.ts` (adjustConfidence confirm/disconfirm/soft/multiple) and `tool-defs.test.ts` (prediction_update confirm applies signal immediately)._
