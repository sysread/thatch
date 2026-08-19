import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-046: Prediction update — create signal.
 *
 * Automatable: the update tool's execute function is a pure DB+embedding
 * operation. This test calls prediction_update with signal "create" via
 * the tool execute function, then verifies the created prediction via
 * prediction_list and prediction_query.
 */

const useCase: UseCase = {
  name: "UC-046-prediction-update-create",
  preconditions: [
    "- A clean DB (no existing matchers or predictions matching the new ones)",
  ].join("\n"),
  steps: [
    '1. Call `prediction_update(matcher="deciding how to structure error handling", prediction="handle error cases before happy paths", signal="create", rationale="user stated this preference")`.',
    "2. Call `prediction_list` to inspect the created prediction.",
    '3. Call `prediction_query(context="deciding how to structure error handling")` to verify it fires.',
  ].join("\n"),
  expected: [
    '- Step 1: Returns `[created] <store> :: "<prediction>" for "<matcher>"`. A new matcher row and prediction row are created. An edge links them with weight 1.0. A provenance entry with signal "create" is recorded.',
    "- Step 2: `prediction_list` shows one prediction with confidence=0.50, evidence count=0, one matcher, and one provenance entry (create).",
    '- Step 3: `prediction_query` returns the prediction with "you may prefer" (0-evidence verb).',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Step 1: prediction_update with signal "create".
      const result = await findTool("prediction_update").execute({
        matcher: "deciding how to structure error handling",
        prediction: "handle error cases before happy paths",
        signal: "create",
        rationale: "user stated this preference",
      }, coreCtx);

      if (!result.includes("[created]")) {
        console.log(`  FAIL: expected [created] in result, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("handle error cases before happy paths")) {
        console.log(`  FAIL: result should contain prediction statement, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("deciding how to structure error handling")) {
        console.log(`  FAIL: result should contain matcher text, got: ${result}`);
        return "FAIL";
      }

      // Step 2: prediction_list shows one prediction with confidence=0.50, 0 evidence.
      const list = await findTool("prediction_list").execute({}, coreCtx);
      if (!list.includes("handle error cases before happy paths")) {
        console.log(`  FAIL: prediction_list should contain the prediction, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("0.50")) {
        console.log(`  FAIL: prediction_list should show confidence 0.50, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("0 tests")) {
        console.log(`  FAIL: prediction_list should show 0 tests, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("create:")) {
        console.log(`  FAIL: prediction_list should show provenance with create signal, got: ${list}`);
        return "FAIL";
      }

      // Verify only one prediction was created.
      const predictions = db.listPredictions(store);
      if (predictions.length !== 1) {
        console.log(`  FAIL: expected 1 prediction, got ${predictions.length}`);
        return "FAIL";
      }

      // Step 3: prediction_query returns the prediction with 0-evidence verb.
      const query = await findTool("prediction_query").execute({
        context: "deciding how to structure error handling",
      }, coreCtx);
      if (!query.includes("handle error cases before happy paths")) {
        console.log(`  FAIL: prediction_query should return the prediction, got: ${query}`);
        return "FAIL";
      }
      if (!query.includes("you may prefer")) {
        console.log(`  FAIL: 0-evidence prediction should use "you may prefer", got: ${query}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
