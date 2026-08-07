import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../src/embeddings";

/**
 * UC-022: Prediction create-on-existing (dedup + link).
 *
 * Automatable: the dedup path (findNearestPrediction + createEdge) is a pure
 * DB operation. This test seeds a prediction, then simulates a second
 * prediction_update with the same prediction text but a new matcher. The
 * existing prediction should be found and linked, not duplicated.
 */

const useCase: UseCase = {
  name: "UC-022-prediction-dedup",
  preconditions: [
    "- An opencode session with at least one existing prediction (from UC-021 or seeded directly)",
    "- The existing prediction's matcher context is semantically similar to a new observation",
  ].join("\n"),
  steps: [
    '1. Seed a prediction: `prediction_update(matcher="reviewing a PR", prediction="go through findings one at a time using a todo list", signal="create")`.',
    '2. In the same or a new session, call `prediction_update(matcher="code review session", prediction="go through findings one at a time using a todo list", signal="create")`.',
    '3. Call `prediction_update(matcher="code review session", prediction="go through findings one at a time using a todo list", signal="confirm")`.',
    "4. Call `prediction_list` to inspect the model.",
  ].join("\n"),
  expected: [
    '- Step 2: `findNearestPrediction` finds the existing prediction (cosine > 0.85). The tool returns `[linked]` (not `[created]`). The new matcher is linked via an edge. No duplicate prediction is created. Confidence is unchanged (create is confidence-neutral).',
    "- Step 3: Same prediction is found. The matcher edge already exists (ON CONFLICT DO NOTHING). Confidence is adjusted upward by the confirm signal. Returns `[confirm]` with updated confidence.",
    '- Step 4: `prediction_list` shows one prediction with two matchers ("reviewing a PR" and "code review session"), confidence reflecting one confirm, and provenance entries for both the create and confirm signals.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Step 1: seed a prediction with matcher "reviewing a PR".
      const matcher1Text = "reviewing a PR";
      const matcher1Embed = await model.queryEmbed(matcher1Text);
      const matcher1Id = db.createMatcher(store, matcher1Text, matcher1Embed, model.name);

      const predText = "go through findings one at a time using a todo list";
      const predEmbed = await model.queryEmbed(predText);
      const predId = db.createPrediction(store, predText, "user prefers ordered review", predEmbed, model.name);
      db.createEdge(matcher1Id, predId, 1.0);
      db.addProvenance(predId, "create", "initial creation");

      // Step 2: new matcher "code review session", same prediction text.
      // findNearestMatcher with 0.85 threshold: different text from matcher1,
      // so cosine ~0 < 0.85 -> null -> create new matcher.
      // findNearestPrediction with 0.85 threshold: same predEmbed -> cosine
      // 1.0 >= 0.85 -> finds existing prediction. Link via edge, no duplicate.
      const matcher2Text = "code review session";
      const matcher2Embed = await model.queryEmbed(matcher2Text);
      const existingMatcher = db.findNearestMatcher(store, matcher2Embed, 0.85);
      const matcher2Id = existingMatcher ? existingMatcher.id : db.createMatcher(store, matcher2Text, matcher2Embed, model.name);

      const existingPred = db.findNearestPrediction(store, predEmbed, 0.85);
      if (!existingPred) {
        console.log("  FAIL: findNearestPrediction should have found the existing prediction");
        return "FAIL";
      }
      // Link the new matcher to the existing prediction (no new prediction row).
      db.createEdge(matcher2Id, existingPred.id, 1.0);
      db.addProvenance(existingPred.id, "create", "linked from new matcher");

      // Verify: only one prediction (no duplicate).
      let predictions = db.listPredictions(store);
      if (predictions.length !== 1) {
        console.log(`  FAIL: expected 1 prediction, got ${predictions.length}`);
        return "FAIL";
      }

      // Verify: prediction has two matchers.
      if (predictions[0].matchers.length !== 2) {
        console.log(`  FAIL: expected 2 matchers, got ${predictions[0].matchers.length}`);
        return "FAIL";
      }

      // Verify: confidence unchanged (create is confidence-neutral).
      if (Math.abs(predictions[0].confidence - 0.5) > 0.01) {
        console.log(`  FAIL: confidence should still be ~0.5 after create, got ${predictions[0].confidence}`);
        return "FAIL";
      }

      // Step 3: confirm signal on the same prediction.
      db.adjustConfidence(existingPred.id, "confirm");
      db.addProvenance(existingPred.id, "confirm", "user confirmed");

      const confirmed = db.getPrediction(existingPred.id);
      if (!confirmed || confirmed.confirm_count !== 1) {
        console.log(`  FAIL: expected confirm_count=1, got ${confirmed?.confirm_count}`);
        return "FAIL";
      }
      if (confirmed.confidence <= 0.5) {
        console.log(`  FAIL: confidence should increase after confirm, got ${confirmed.confidence}`);
        return "FAIL";
      }

      // Verify: provenance has 3 entries (create, create-link, confirm).
      const provenance = db.getProvenance(existingPred.id);
      if (provenance.length !== 3) {
        console.log(`  FAIL: expected 3 provenance entries, got ${provenance.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
