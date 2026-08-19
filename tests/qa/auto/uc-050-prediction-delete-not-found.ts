import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-050: Prediction delete — not found.
 *
 * Automatable: the delete tool's semantic matching is a pure DB+embedding
 * operation. This test seeds a prediction, then calls prediction_delete
 * with an unrelated statement and verifies the not-found message.
 */

const useCase: UseCase = {
  name: "UC-050-prediction-delete-not-found",
  preconditions: [
    "- A DB with at least one prediction",
    "- The delete statement is semantically unrelated to all stored predictions",
  ].join("\n"),
  steps: [
    "1. Seed a prediction in a store.",
    '2. Call `prediction_delete(statement="<text completely unrelated to any prediction>")`.',
  ].join("\n"),
  expected: [
    '- Step 2: Returns `No prediction matching "<statement>" found in "<store>".` No prediction rows, edges, or provenance entries are deleted.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Seed a prediction.
      const matcherText = "choosing a framework";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createMatcher(store, matcherText, matcherEmbed, model.name);

      const predText = "prefer minimal dependencies";
      const predEmbed = await model.queryEmbed(predText);
      const predId = db.createPrediction(store, predText, "user said", predEmbed, model.name);
      db.createEdge(matcherId, predId, 1.0);

      // Delete with unrelated statement.
      const unrelatedText = "this prediction does not exist at all";
      const result = await findTool("prediction_delete").execute({
        statement: unrelatedText,
      }, coreCtx);

      if (!result.includes("No prediction matching")) {
        console.log(`  FAIL: expected not-found message, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes(unrelatedText)) {
        console.log(`  FAIL: not-found message should contain the statement, got: ${result}`);
        return "FAIL";
      }

      // Verify the prediction still exists (nothing was deleted).
      const predictions = db.listPredictions(store);
      if (predictions.length !== 1) {
        console.log(`  FAIL: prediction should still exist after failed delete, got ${predictions.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
