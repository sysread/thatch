import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../src/embeddings";

/**
 * UC-023: Prediction confidence and signal model.
 *
 * Automatable: the Bayesian confidence math and signal mapping are pure DB
 * operations. This test seeds a prediction, applies confirm/soft/disconfirm
 * signals in sequence, and verifies the confidence and evidence counts at
 * each step against the formula:
 *   confidence = (confirm_count + K*P0) / (confirm_count + disconfirm_count + K)
 * with K=5, P0=0.5, W_SOFT=0.25.
 */

const useCase: UseCase = {
  name: "UC-023-prediction-confidence-model",
  preconditions: [
    "- An opencode or Claude Code / Cursor session with the prediction model seeded",
  ].join("\n"),
  steps: [
    '1. `prediction_update(matcher="X", prediction="Y", signal="create")` — seeds at p0 (0.50, 0 evidence).',
    '2. `prediction_update(matcher="X", prediction="Y", signal="confirm")` — user confirmed.',
    '3. `prediction_update(matcher="X", prediction="Y", signal="soft")` — user partially disagreed.',
    '4. `prediction_update(matcher="X", prediction="Y", signal="disconfirm")` — user pushed back.',
    "5. `prediction_list` to inspect confidence and evidence counts.",
    '6. `prediction_query(context="X")` to query the model.',
  ].join("\n"),
  expected: [
    "- Step 1: Returns `[created]`, confidence=0.50, counts (0/0).",
    "- Step 2: Returns `[confirm]`, confidence > 0.50. Formula: (1 + 5*0.5) / (1 + 0 + 5) = 0.583. Counts (1/0).",
    "- Step 3: Returns `[soft]`, confidence drops slightly. Soft adds 0.25 to disconfirm_count. Formula: (1 + 2.5) / (1 + 0.25 + 5) = 0.571. Counts (1/0.25).",
    "- Step 4: Returns `[disconfirm]`, confidence drops further. Formula: (1 + 2.5) / (1 + 1.25 + 5) = 0.524. Counts (1/1.25).",
    "- Step 5: `prediction_list` shows the prediction with accumulated provenance entries (create, confirm, soft, disconfirm) sorted newest-first.",
    '- Step 6: `prediction_query` returns the prediction with the current confidence and evidence count. Uses "you may prefer" for 0-evidence and "you tend to" for predictions with evidence. Threshold (0.45) filters out matchers below the relevance floor.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    // K=5, P0=0.5, W_SOFT=0.25
    const K = 5, P0 = 0.5;

    try {
      const matcherText = "deciding how to structure error handling";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createMatcher(store, matcherText, matcherEmbed, model.name);

      const predText = "handle error cases before happy paths";
      const predEmbed = await model.queryEmbed(predText);
      const predId = db.createPrediction(store, predText, "user prefers errors first", predEmbed, model.name);
      db.createEdge(matcherId, predId, 1.0);

      // Step 1: create -> confidence=0.50, counts (0, 0).
      let pred = db.getPrediction(predId);
      if (Math.abs(pred!.confidence - 0.5) > 0.001) {
        console.log(`  FAIL: initial confidence should be 0.5, got ${pred!.confidence}`);
        return "FAIL";
      }
      if (pred!.confirm_count !== 0 || pred!.disconfirm_count !== 0) {
        console.log(`  FAIL: initial counts should be (0, 0), got (${pred!.confirm_count}, ${pred!.disconfirm_count})`);
        return "FAIL";
      }

      // Step 2: confirm -> (1 + K*P0) / (1 + 0 + K) = 3.5/6.
      db.adjustConfidence(predId, "confirm");
      db.addProvenance(predId, "confirm", "user confirmed");
      pred = db.getPrediction(predId);
      if (pred!.confirm_count !== 1) {
        console.log(`  FAIL: confirm_count should be 1, got ${pred!.confirm_count}`);
        return "FAIL";
      }
      const expectedAfterConfirm = (1 + K * P0) / (1 + 0 + K);
      if (Math.abs(pred!.confidence - expectedAfterConfirm) > 0.001) {
        console.log(`  FAIL: after confirm confidence should be ${expectedAfterConfirm.toFixed(4)}, got ${pred!.confidence}`);
        return "FAIL";
      }

      // Step 3: soft -> adds 0.25 to disconfirm_count.
      // (1 + K*P0) / (1 + 0.25 + K) = 3.5/6.25.
      db.adjustConfidence(predId, "soft");
      db.addProvenance(predId, "soft", "user partially disagreed");
      pred = db.getPrediction(predId);
      if (Math.abs(pred!.disconfirm_count - 0.25) > 0.001) {
        console.log(`  FAIL: disconfirm_count should be 0.25, got ${pred!.disconfirm_count}`);
        return "FAIL";
      }
      const expectedAfterSoft = (1 + K * P0) / (1 + 0.25 + K);
      if (Math.abs(pred!.confidence - expectedAfterSoft) > 0.001) {
        console.log(`  FAIL: after soft confidence should be ${expectedAfterSoft.toFixed(4)}, got ${pred!.confidence}`);
        return "FAIL";
      }

      // Step 4: disconfirm -> adds 1 to disconfirm_count (now 1.25).
      // (1 + K*P0) / (1 + 1.25 + K) = 3.5/7.25.
      db.adjustConfidence(predId, "disconfirm");
      db.addProvenance(predId, "disconfirm", "user pushed back");
      pred = db.getPrediction(predId);
      if (Math.abs(pred!.disconfirm_count - 1.25) > 0.001) {
        console.log(`  FAIL: disconfirm_count should be 1.25, got ${pred!.disconfirm_count}`);
        return "FAIL";
      }
      const expectedAfterDisconfirm = (1 + K * P0) / (1 + 1.25 + K);
      if (Math.abs(pred!.confidence - expectedAfterDisconfirm) > 0.001) {
        console.log(`  FAIL: after disconfirm confidence should be ${expectedAfterDisconfirm.toFixed(4)}, got ${pred!.confidence}`);
        return "FAIL";
      }

      // Step 5: provenance has 3 entries (confirm, soft, disconfirm), newest first.
      const provenance = db.getProvenance(predId);
      if (provenance.length !== 3) {
        console.log(`  FAIL: expected 3 provenance entries, got ${provenance.length}`);
        return "FAIL";
      }
      if (provenance[0].signal !== "disconfirm" || provenance[1].signal !== "soft" || provenance[2].signal !== "confirm") {
        console.log(`  FAIL: provenance order wrong: ${provenance.map((p: { signal: string }) => p.signal).join(", ")}`);
        return "FAIL";
      }

      // Step 6: scorePredictionNudge returns the prediction with current confidence.
      const queryEmbed = await model.queryEmbed(matcherText);
      const items = db.scorePredictionNudge([store], queryEmbed, 0.0, 5);
      if (items.length === 0) {
        console.log("  FAIL: scorePredictionNudge returned no items");
        return "FAIL";
      }
      // Nudge confidence is rounded to 3 decimal places in scorePredictions.
      if (Math.abs(items[0].confidence - Math.round(expectedAfterDisconfirm * 1000) / 1000) > 0.001) {
        console.log(`  FAIL: nudge confidence should be ~${expectedAfterDisconfirm.toFixed(3)}, got ${items[0].confidence}`);
        return "FAIL";
      }
      // evidence_count = Math.round(confirm_count + disconfirm_count) = Math.round(2.25) = 2.
      if (items[0].evidence_count !== 2) {
        console.log(`  FAIL: evidence_count should be 2, got ${items[0].evidence_count}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
