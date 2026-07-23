# UC-024: Prediction delete and provenance inspection

**Preconditions**
- An opencode or Claude Code / Cursor session with predictions in the model

**Steps**

1. Seed two predictions in the same store.
2. `prediction_list` to see both predictions with matchers, confidence, and provenance.
3. `prediction_delete(statement="first prediction text")` to remove one.
4. `prediction_list` to verify only one prediction remains.
5. `prediction_delete(statement="nonexistent prediction")` to test not-found handling.

**Expected**
- Step 2: Both predictions listed with confidence, evidence count, matchers (with weights), and provenance entries (signal type, detail, date).
- Step 3: Returns `[deleted]` with the matched prediction's statement. Matching is semantic (cosine >= 0.85), not exact string match. Edges and provenance are cascade-deleted via FK ON DELETE CASCADE.
- Step 4: Only the remaining prediction is listed. No orphaned edges or provenance entries.
- Step 5: Returns "No prediction matching ... found" for a statement with no semantic match above threshold.

_Automatable: yes — prediction_delete is tested in `tool-defs.test.ts` (found and not-found cases), and deletePrediction cascade is tested in `prediction.test.ts` (cascade to edges and provenance, non-existent ID)._
