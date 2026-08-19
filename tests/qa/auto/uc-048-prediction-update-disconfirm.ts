import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-048: Prediction update — disconfirm signal.
 *
 * Automatable: the update tool's execute function is a pure DB+embedding
 * operation. This test seeds a prediction, confirms it, then disconfirms
 * it via the tool execute function. Verifies confidence drops but the
 * prediction still fires because the matcher cosine is high enough.
 */

const useCase: UseCase = {
  name: "UC-048-prediction-update-disconfirm",
  preconditions: [
    "- An existing prediction in the model (created via signal 'create' or seeded directly)",
  ].join("\n"),
  steps: [
    "1. Seed a prediction at P0 (0.50, 0 evidence).",
    '2. Call `prediction_update(matcher="<existing>", prediction="<existing>", signal="confirm", rationale="user confirmed")`.',
    '3. Call `prediction_update(matcher="<existing>", prediction="<existing>", signal="disconfirm", rationale="user pushed back")`.',
    '4. Call `prediction_query(context="<text matching the matcher>")` to verify the prediction still fires.',
    '5. Call `prediction_delete(statement="<existing prediction>")` to remove the wrong prediction.',
  ].join("\n"),
  expected: [
    "- Step 2: Confidence rises to 0.58. Counts (1/0).",
    "- Step 3: Confidence drops to 0.50. Counts (1/1). Returns `[disconfirm]` with updated confidence. A provenance entry with signal 'disconfirm' is recorded.",
    "- Step 4: The prediction still appears in the query results — disconfirming lowers confidence but does not remove the prediction or suppress the nudge.",
    "- Step 5: Returns `[deleted]`. The prediction, its edges, and its provenance are removed.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      const matcherText = "deciding how to structure error handling";
      const predText = "handle error cases before happy paths";

      // Step 1: create the prediction.
      await findTool("prediction_update").execute({
        matcher: matcherText,
        prediction: predText,
        signal: "create",
        rationale: "user stated this preference",
      }, coreCtx);

      // Step 2: confirm it.
      const confirmResult = await findTool("prediction_update").execute({
        matcher: matcherText,
        prediction: predText,
        signal: "confirm",
        rationale: "user confirmed",
      }, coreCtx);
      if (!confirmResult.includes("[confirm]") || !confirmResult.includes("(1/0)")) {
        console.log(`  FAIL: confirm result wrong, got: ${confirmResult}`);
        return "FAIL";
      }

      // Step 3: disconfirm it.
      const disconfirmResult = await findTool("prediction_update").execute({
        matcher: matcherText,
        prediction: predText,
        signal: "disconfirm",
        rationale: "user pushed back",
      }, coreCtx);
      if (!disconfirmResult.includes("[disconfirm]")) {
        console.log(`  FAIL: expected [disconfirm], got: ${disconfirmResult}`);
        return "FAIL";
      }
      if (!disconfirmResult.includes("(1/1)")) {
        console.log(`  FAIL: expected (1/1) counts, got: ${disconfirmResult}`);
        return "FAIL";
      }
      // Confidence: (1 + 5*0.5) / (1 + 1 + 5) = 3.5/7 = 0.50
      if (!disconfirmResult.includes("0.50")) {
        console.log(`  FAIL: expected confidence=0.50, got: ${disconfirmResult}`);
        return "FAIL";
      }

      // Step 4: prediction still fires — disconfirming doesn't suppress the nudge.
      const query = await findTool("prediction_query").execute({
        context: matcherText,
      }, coreCtx);
      if (!query.includes(predText)) {
        console.log(`  FAIL: prediction should still appear in query after disconfirm, got: ${query}`);
        return "FAIL";
      }

      // Step 5: delete the wrong prediction.
      const deleteResult = await findTool("prediction_delete").execute({
        statement: predText,
      }, coreCtx);
      if (!deleteResult.includes("[deleted]")) {
        console.log(`  FAIL: expected [deleted], got: ${deleteResult}`);
        return "FAIL";
      }

      // Verify the prediction is gone.
      const predictions = db.listPredictions(store);
      if (predictions.length !== 0) {
        console.log(`  FAIL: expected 0 predictions after delete, got ${predictions.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
