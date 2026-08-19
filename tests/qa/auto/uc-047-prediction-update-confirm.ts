import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-047: Prediction update — confirm signal.
 *
 * Automatable: the update tool's execute function is a pure DB+embedding
 * operation. This test seeds a prediction at P0, calls prediction_update
 * with signal "confirm" via the tool execute function, and verifies that
 * confidence rises and confirm_count increases.
 */

const useCase: UseCase = {
  name: "UC-047-prediction-update-confirm",
  preconditions: [
    "- An existing prediction in the model (created via signal 'create' or seeded directly)",
  ].join("\n"),
  steps: [
    "1. Seed a prediction at P0 (0.50, 0 evidence).",
    '2. Call `prediction_update(matcher="<existing matcher>", prediction="<existing prediction>", signal="confirm", rationale="user confirmed")`.',
    "3. Call `prediction_list` to inspect updated confidence and counts.",
  ].join("\n"),
  expected: [
    '- Step 2: Returns `[confirm] "<statement>" confidence=0.58 (1/0)`. `confirm_count` increases by 1. Confidence rises from 0.50 to `(1 + 5*0.5) / (1 + 0 + 5) = 0.583`. A provenance entry with signal "confirm" is recorded.',
    "- Step 3: `prediction_list` shows the prediction with confidence=0.58, evidence count=1, and provenance entries for both the create and confirm signals (newest-first).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Step 1: seed a prediction via prediction_update with signal "create".
      await findTool("prediction_update").execute({
        matcher: "deciding how to structure error handling",
        prediction: "handle error cases before happy paths",
        signal: "create",
        rationale: "user stated this preference",
      }, coreCtx);

      // Verify it starts at P0.
      let predictions = db.listPredictions(store);
      if (predictions.length !== 1) {
        console.log(`  FAIL: expected 1 prediction after create, got ${predictions.length}`);
        return "FAIL";
      }
      if (Math.abs(predictions[0].confidence - 0.5) > 0.01) {
        console.log(`  FAIL: initial confidence should be ~0.5, got ${predictions[0].confidence}`);
        return "FAIL";
      }

      // Step 2: confirm signal on the same prediction (same matcher+prediction text).
      const result = await findTool("prediction_update").execute({
        matcher: "deciding how to structure error handling",
        prediction: "handle error cases before happy paths",
        signal: "confirm",
        rationale: "user confirmed",
      }, coreCtx);

      if (!result.includes("[confirm]")) {
        console.log(`  FAIL: expected [confirm] in result, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("0.58")) {
        console.log(`  FAIL: expected confidence=0.58 in result, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("(1/0)")) {
        console.log(`  FAIL: expected (1/0) counts in result, got: ${result}`);
        return "FAIL";
      }

      // Step 3: prediction_list shows updated confidence and evidence.
      const list = await findTool("prediction_list").execute({}, coreCtx);
      if (!list.includes("0.58")) {
        console.log(`  FAIL: prediction_list should show confidence 0.58, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("1 tests")) {
        console.log(`  FAIL: prediction_list should show 1 test, got: ${list}`);
        return "FAIL";
      }
      // Provenance should have both create and confirm entries.
      if (!list.includes("create:")) {
        console.log(`  FAIL: prediction_list should show create provenance, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("confirm:")) {
        console.log(`  FAIL: prediction_list should show confirm provenance, got: ${list}`);
        return "FAIL";
      }

      // Verify confidence via DB directly (more precise).
      predictions = db.listPredictions(store);
      const expectedConf = (1 + 5 * 0.5) / (1 + 0 + 5);
      if (Math.abs(predictions[0].confidence - expectedConf) > 0.01) {
        console.log(`  FAIL: confidence should be ~${expectedConf.toFixed(3)}, got ${predictions[0].confidence}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
