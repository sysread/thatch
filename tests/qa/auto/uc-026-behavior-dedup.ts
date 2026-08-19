import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-026: Behavior codify-on-existing (dedup + link).
 *
 * Automatable: the dedup path (findNearestBehavior + createBehaviorEdge)
 * is a pure DB operation. This test seeds a behavior, then simulates a
 * second behavior_codify with the same behavior text but a new matcher.
 * The existing behavior should be found and linked, not duplicated.
 */

const useCase: UseCase = {
  name: "UC-026-behavior-dedup",
  preconditions: [
    "- An opencode session with at least one existing behavior (from UC-025 or seeded directly)",
    "- The existing behavior's matcher context is semantically similar to a new observation",
  ].join("\n"),
  steps: [
    '1. Seed a behavior: `behavior_codify(situation="editing a large function", behavior="read the whole function before editing it", rationale="discipline")`.',
    '2. In the same or a new session, call `behavior_codify(situation="refactoring a complex module", behavior="read the whole function before editing it", rationale="same rule, new context")`.',
    '3. Call `behavior_feedback(behavior="read the whole function before editing it", relevant=true, context="editing auth.ts")` to ham the behavior.',
    "4. Call `behavior_list` to inspect the model.",
  ].join("\n"),
  expected: [
    '- Step 2: `findNearestBehavior` finds the existing behavior (cosine > 0.85). The tool returns `[linked]` (not `[codified]`). The new matcher is linked via an edge. No duplicate behavior is created. Confidence is unchanged (codify is confidence-neutral).',
    "- Step 3: Same behavior is found. The matcher edge already exists (ON CONFLICT DO NOTHING). Confidence is adjusted upward by the confirm signal (ham). Returns `[confirm]` with updated confidence.",
    '- Step 4: `behavior_list` shows one behavior with two matchers ("editing a large function" and "refactoring a complex module"), confidence reflecting one confirm, and provenance entries for both the codify and feedback signals.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Step 1: seed a behavior with matcher "editing a large function".
      const matcher1Text = "editing a large function";
      const matcher1Embed = await model.queryEmbed(matcher1Text);
      const matcher1Id = db.createBehaviorMatcher(store, matcher1Text, matcher1Embed, model.name);

      const behaviorText = "read the whole function before editing it";
      const behaviorEmbed = await model.queryEmbed(behaviorText);
      const behaviorId = db.createBehavior(store, behaviorText, "discipline", behaviorEmbed, model.name);
      db.createBehaviorEdge(matcher1Id, behaviorId, 1.0);
      db.addBehaviorProvenance(behaviorId, "codify", "initial codification");

      // Step 2: new matcher "refactoring a complex module", same behavior text.
      const matcher2Text = "refactoring a complex module";
      const matcher2Embed = await model.queryEmbed(matcher2Text);
      const existingMatcher = db.findNearestBehaviorMatcher(store, matcher2Embed, 0.85);
      const matcher2Id = existingMatcher ? existingMatcher.id : db.createBehaviorMatcher(store, matcher2Text, matcher2Embed, model.name);

      const existingBehavior = db.findNearestBehavior(store, behaviorEmbed, 0.85);
      if (!existingBehavior) {
        console.log("  FAIL: findNearestBehavior should have found the existing behavior");
        return "FAIL";
      }
      db.createBehaviorEdge(matcher2Id, existingBehavior.id, 1.0);
      db.addBehaviorProvenance(existingBehavior.id, "codify", "linked from new matcher");

      // Verify: only one behavior (no duplicate).
      let behaviors = db.listBehaviors(store);
      if (behaviors.length !== 1) {
        console.log(`  FAIL: expected 1 behavior, got ${behaviors.length}`);
        return "FAIL";
      }

      // Verify: behavior has two matchers.
      if (behaviors[0].matchers.length !== 2) {
        console.log(`  FAIL: expected 2 matchers, got ${behaviors[0].matchers.length}`);
        return "FAIL";
      }

      // Verify: confidence unchanged (codify is confidence-neutral).
      if (Math.abs(behaviors[0].confidence - 0.5) > 0.01) {
        console.log(`  FAIL: confidence should still be ~0.5 after codify, got ${behaviors[0].confidence}`);
        return "FAIL";
      }

      // Step 3: ham (confirm) signal on the same behavior.
      db.adjustBehaviorConfidence(existingBehavior.id, "confirm");
      db.addBehaviorProvenance(existingBehavior.id, "confirm", "ham: editing auth.ts");

      const confirmed = db.getBehavior(existingBehavior.id);
      if (!confirmed || confirmed.confirm_count !== 1) {
        console.log(`  FAIL: expected confirm_count=1, got ${confirmed?.confirm_count}`);
        return "FAIL";
      }
      if (confirmed.confidence <= 0.5) {
        console.log(`  FAIL: confidence should increase after confirm, got ${confirmed.confidence}`);
        return "FAIL";
      }

      // Verify: provenance has 3 entries (codify, codify-link, confirm).
      const provenance = db.getBehaviorProvenance(existingBehavior.id);
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
