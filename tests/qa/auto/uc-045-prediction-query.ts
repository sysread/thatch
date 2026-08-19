import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-045: Prediction query.
 *
 * Automatable: the query tool is a pure DB+embedding operation. This test
 * seeds a matcher and linked prediction, calls prediction_query via the
 * tool execute function, and verifies the output format and threshold
 * filtering.
 */

const useCase: UseCase = {
  name: "UC-045-prediction-query",
  preconditions: [
    "- A DB with at least one matcher and linked prediction",
    "- The matcher text is semantically related to the query context",
  ].join("\n"),
  steps: [
    "1. Seed a matcher and a linked prediction in a store.",
    '2. Call `prediction_query(context="<text matching the matcher>")`.',
    '3. Call `prediction_query(context="<unrelated text>")`.',
  ].join("\n"),
  expected: [
    '- Step 2: Returns one or more lines formatted as `[X.XX conf, N tests] When <matcher>: <verb> <statement>`. The verb is "you tend to" for predictions with evidence (>0 tests) and "you may prefer" for 0-evidence predictions. Confidence and evidence count match the stored values.',
    '- Step 3: Returns `No matching predictions found.` No predictions are returned.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const coreCtx: CoreContext = { db, model, defaultStore: "test-store" };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Seed a matcher and 0-evidence prediction linked by an edge.
      const matcherText = "deciding how to structure error handling";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createMatcher("test-store", matcherText, matcherEmbed, model.name);

      const predText = "handle error cases before happy paths";
      const predEmbed = await model.queryEmbed(predText);
      const predId = db.createPrediction("test-store", predText, "user prefers errors first", predEmbed, model.name);
      db.createEdge(matcherId, predId, 1.0);

      // Step 2: query with matching context (same text as matcher -> cosine ~1.0).
      const result = await findTool("prediction_query").execute({ context: matcherText }, coreCtx);
      if (!result.includes(predText)) {
        console.log(`  FAIL: query result should contain prediction statement, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("you may prefer")) {
        console.log(`  FAIL: 0-evidence prediction should use "you may prefer", got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("0.50")) {
        console.log(`  FAIL: confidence should be ~0.50 for 0-evidence, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("0 tests")) {
        console.log(`  FAIL: evidence count should be 0, got: ${result}`);
        return "FAIL";
      }

      // Step 3: query with unrelated context -> "No matching predictions found."
      const noMatch = await findTool("prediction_query").execute(
        { context: "what is the weather like today" },
        coreCtx,
      );
      if (!noMatch.includes("No matching predictions found.")) {
        console.log(`  FAIL: unrelated query should return "No matching predictions found.", got: ${noMatch}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
