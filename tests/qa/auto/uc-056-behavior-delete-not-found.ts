import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-056: Behavior delete — not found.
 *
 * Automatable: the delete tool's semantic matching is a pure DB+embedding
 * operation. This test seeds a behavior, then calls behavior_delete with
 * an unrelated statement and verifies the not-found message.
 */

const useCase: UseCase = {
  name: "UC-056-behavior-delete-not-found",
  preconditions: [
    "- A DB with at least one behavior",
    "- The delete statement is semantically unrelated to all stored behaviors",
  ].join("\n"),
  steps: [
    "1. Seed a behavior in a store.",
    '2. Call `behavior_delete(statement="<text completely unrelated to any behavior>")`.',
  ].join("\n"),
  expected: [
    '- Step 2: Returns `No behavior matching "<statement>" found in "<store>".` No behavior rows, edges, or provenance entries are deleted.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Seed a behavior.
      const matcherText = "editing code";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createBehaviorMatcher(store, matcherText, matcherEmbed, model.name);

      const behaviorText = "read the whole function before editing it";
      const behaviorEmbed = await model.queryEmbed(behaviorText);
      const behaviorId = db.createBehavior(store, behaviorText, "discipline", behaviorEmbed, model.name);
      db.createBehaviorEdge(matcherId, behaviorId, 1.0);

      // Delete with unrelated statement.
      const unrelatedText = "this behavior does not exist at all";
      const result = await findTool("behavior_delete").execute({
        statement: unrelatedText,
      }, coreCtx);

      if (!result.includes("No behavior matching")) {
        console.log(`  FAIL: expected not-found message, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes(unrelatedText)) {
        console.log(`  FAIL: not-found message should contain the statement, got: ${result}`);
        return "FAIL";
      }

      // Verify the behavior still exists (nothing was deleted).
      const behaviors = db.listBehaviors(store);
      if (behaviors.length !== 1) {
        console.log(`  FAIL: behavior should still exist after failed delete, got ${behaviors.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
