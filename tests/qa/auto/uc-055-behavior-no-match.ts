import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-055: Behavior no match.
 *
 * Automatable: the auto-fire scoring pipeline (scoreBehaviorNudge) is a
 * pure DB+embedding operation. This test seeds a behavior matcher and
 * linked behavior, then calls scoreBehaviorNudge with unrelated text
 * and verifies an empty result.
 */

const useCase: UseCase = {
  name: "UC-055-behavior-no-match",
  preconditions: [
    "- A DB with at least one behavior matcher and linked behavior",
    "- The query prompt is semantically unrelated to all stored behavior matchers",
  ].join("\n"),
  steps: [
    "1. Seed a behavior matcher and a linked behavior in a store.",
    '2. Call `scoreBehaviorNudge` with text completely unrelated to any behavior matcher.',
  ].join("\n"),
  expected: [
    "- Step 2: No behavior nudge is injected. `scoreBehaviorNudge` returns an empty array. No `[thatch] Situational behaviors` synthetic part appears in the conversation.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed a behavior matcher and linked behavior.
      const matcherText = "importing a new library into a project";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createBehaviorMatcher(store, matcherText, matcherEmbed, model.name);

      const behaviorText = "check the whole codebase for an existing import of that library first";
      const behaviorEmbed = await model.queryEmbed(behaviorText);
      const behaviorId = db.createBehavior(store, behaviorText, "avoiding duplicates", behaviorEmbed, model.name);
      db.createBehaviorEdge(matcherId, behaviorId, 1.0);

      // Query with completely unrelated text at the 0.60 auto-fire threshold.
      const unrelatedEmbed = await model.queryEmbed("what is the weather like today");
      const items = db.scoreBehaviorNudge([store], unrelatedEmbed, 0.60, 5);
      if (items.length > 0) {
        console.log(`  FAIL: unrelated context should not trigger behavior nudge, got ${items.length} items`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
