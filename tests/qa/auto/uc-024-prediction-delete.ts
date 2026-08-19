import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-024: Prediction delete and provenance inspection.
 *
 * Automatable: deletePrediction is a pure DB operation with FK cascade.
 * This test seeds two predictions, deletes one via findNearestPrediction +
 * deletePrediction, and verifies the cascade clears edges and provenance.
 * Also tests the not-found case.
 */

const useCase: UseCase = {
  name: "UC-024-prediction-delete",
  preconditions: [
    "- An opencode or Claude Code / Cursor session with predictions in the model",
  ].join("\n"),
  steps: [
    "1. Seed two predictions in the same store.",
    "2. `prediction_list` to see both predictions with matchers, confidence, and provenance.",
    '3. `prediction_delete(statement="first prediction text")` to remove one.',
    "4. `prediction_list` to verify only one prediction remains.",
    '5. `prediction_delete(statement="nonexistent prediction")` to test not-found handling.',
  ].join("\n"),
  expected: [
    "- Step 2: Both predictions listed with confidence, evidence count, matchers (with weights), and provenance entries (signal type, detail, date).",
    "- Step 3: Returns `[deleted]` with the matched prediction's statement. Matching is semantic (cosine >= 0.85), not exact string match. Edges and provenance are cascade-deleted via FK ON DELETE CASCADE.",
    "- Step 4: Only the remaining prediction is listed. No orphaned edges or provenance entries.",
    '- Step 5: Returns "No prediction matching ... found" for a statement with no semantic match above threshold.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Step 1: seed two predictions linked to one matcher.
      const matcherText = "reviewing code changes";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createMatcher(store, matcherText, matcherEmbed, model.name);

      const pred1Text = "go through findings one at a time";
      const pred1Embed = await model.queryEmbed(pred1Text);
      const pred1Id = db.createPrediction(store, pred1Text, "reason 1", pred1Embed, model.name);
      db.createEdge(matcherId, pred1Id, 1.0);
      db.addProvenance(pred1Id, "create", "initial");

      const pred2Text = "leave a comment explaining the why";
      const pred2Embed = await model.queryEmbed(pred2Text);
      const pred2Id = db.createPrediction(store, pred2Text, "reason 2", pred2Embed, model.name);
      db.createEdge(matcherId, pred2Id, 1.0);
      db.addProvenance(pred2Id, "create", "initial");

      // Step 2: list both predictions.
      let predictions = db.listPredictions(store);
      if (predictions.length !== 2) {
        console.log(`  FAIL: expected 2 predictions, got ${predictions.length}`);
        return "FAIL";
      }

      // Step 3: delete the first prediction via semantic match.
      const found = db.findNearestPrediction(store, pred1Embed, 0.85);
      if (!found) {
        console.log("  FAIL: findNearestPrediction could not find prediction to delete");
        return "FAIL";
      }
      const deleted = db.deletePrediction(found.id);
      if (!deleted) {
        console.log("  FAIL: deletePrediction returned false");
        return "FAIL";
      }

      // Step 4: only one prediction remains.
      predictions = db.listPredictions(store);
      if (predictions.length !== 1) {
        console.log(`  FAIL: expected 1 prediction after delete, got ${predictions.length}`);
        return "FAIL";
      }
      if (predictions[0].statement !== pred2Text) {
        console.log(`  FAIL: remaining prediction should be pred2, got ${predictions[0].statement}`);
        return "FAIL";
      }

      // Cascade: no orphaned provenance for the deleted prediction.
      const orphanedProv = db.getProvenance(pred1Id);
      if (orphanedProv.length !== 0) {
        console.log(`  FAIL: orphaned provenance entries: ${orphanedProv.length}`);
        return "FAIL";
      }

      // Cascade: scoring no longer returns the deleted prediction.
      const matchers = [{ id: matcherId, description: matcherText, score: 1.0 }];
      const scored = db.scorePredictions(matchers);
      if (scored.length !== 1 || scored[0].prediction_id !== pred2Id) {
        console.log(`  FAIL: scoring should only return pred2, got ${scored.length} items`);
        return "FAIL";
      }

      // Step 5: not-found case. Unrelated text -> cosine ~0 < 0.85 -> null.
      const notFound = db.findNearestPrediction(
        store,
        await model.queryEmbed("completely unrelated text that doesn't match anything"),
        0.85,
      );
      if (notFound) {
        console.log("  FAIL: findNearestPrediction should return null for nonexistent prediction");
        return "FAIL";
      }

      // deletePrediction returns false for a nonexistent ID.
      if (db.deletePrediction("nonexistent-id")) {
        console.log("  FAIL: deletePrediction should return false for nonexistent ID");
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
