import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-049: Prediction query — no match.
 *
 * Automatable: the query tool's threshold filtering is a pure DB+embedding
 * operation. This test seeds a matcher and prediction, then queries with
 * completely unrelated text and verifies "No matching predictions found."
 */

const useCase: UseCase = {
  name: "UC-049-prediction-no-match",
  preconditions: [
    "- A DB with at least one matcher and linked prediction",
    "- The query context is semantically unrelated to all stored matchers",
  ].join("\n"),
  steps: [
    "1. Seed a matcher and a linked prediction in a store.",
    '2. Call `prediction_query(context="<text completely unrelated to any matcher>")`.',
  ].join("\n"),
  expected: [
    '- Step 2: Returns `No matching predictions found.` No predictions are returned. No error is raised.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Seed a matcher and prediction.
      const matcherText = "database indexing strategy";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createMatcher(store, matcherText, matcherEmbed, model.name);

      const predText = "use composite indexes for multi-column queries";
      const predEmbed = await model.queryEmbed(predText);
      const predId = db.createPrediction(store, predText, "performance", predEmbed, model.name);
      db.createEdge(matcherId, predId, 1.0);

      // Query with completely unrelated text.
      const result = await findTool("prediction_query").execute({
        context: "designing a UI layout for a mobile app",
      }, coreCtx);

      if (!result.includes("No matching predictions found.")) {
        console.log(`  FAIL: expected "No matching predictions found.", got: ${result}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
