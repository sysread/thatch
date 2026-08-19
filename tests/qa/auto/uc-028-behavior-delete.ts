import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-028: Behavior delete and provenance inspection.
 *
 * Automatable: deleteBehavior is a pure DB operation with FK cascade.
 * This test seeds two behaviors, deletes one via findNearestBehavior +
 * deleteBehavior, and verifies the cascade clears edges and provenance.
 * Also tests the not-found case.
 */

const useCase: UseCase = {
  name: "UC-028-behavior-delete",
  preconditions: [
    "- An opencode or Claude Code / Cursor session with behaviors in the model",
  ].join("\n"),
  steps: [
    "1. Seed two behaviors in the same store.",
    "2. `behavior_list` to see both behaviors with matchers, confidence, and provenance.",
    '3. `behavior_delete(statement="first behavior text")` to remove one.',
    "4. `behavior_list` to verify only one behavior remains.",
    '5. `behavior_delete(statement="nonexistent behavior")` to test not-found handling.',
  ].join("\n"),
  expected: [
    "- Step 2: Both behaviors listed with confidence, evidence count, matchers (with weights), and provenance entries (signal type, detail, date).",
    "- Step 3: Returns `[deleted]` with the matched behavior's statement. Matching is semantic (cosine >= 0.85). Edges and provenance are cascade-deleted via FK ON DELETE CASCADE.",
    "- Step 4: Only the remaining behavior is listed. No orphaned edges or provenance entries.",
    '- Step 5: Returns "No behavior matching ... found" for a statement with no semantic match above threshold.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Step 1: seed two behaviors linked to one matcher.
      const matcherText = "editing code";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createBehaviorMatcher(store, matcherText, matcherEmbed, model.name);

      const behavior1Text = "read the whole function before editing it";
      const behavior1Embed = await model.queryEmbed(behavior1Text);
      const behavior1Id = db.createBehavior(store, behavior1Text, "discipline", behavior1Embed, model.name);
      db.createBehaviorEdge(matcherId, behavior1Id, 1.0);
      db.addBehaviorProvenance(behavior1Id, "codify", "initial");

      const behavior2Text = "check for disabled tests before touching the area";
      const behavior2Embed = await model.queryEmbed(behavior2Text);
      const behavior2Id = db.createBehavior(store, behavior2Text, "discipline", behavior2Embed, model.name);
      db.createBehaviorEdge(matcherId, behavior2Id, 1.0);
      db.addBehaviorProvenance(behavior2Id, "codify", "initial");

      // Step 2: list both behaviors.
      let behaviors = db.listBehaviors(store);
      if (behaviors.length !== 2) {
        console.log(`  FAIL: expected 2 behaviors, got ${behaviors.length}`);
        return "FAIL";
      }

      // Step 3: delete the first behavior via semantic match.
      const found = db.findNearestBehavior(store, behavior1Embed, 0.85);
      if (!found) {
        console.log("  FAIL: findNearestBehavior could not find behavior to delete");
        return "FAIL";
      }
      const deleted = db.deleteBehavior(found.id);
      if (!deleted) {
        console.log("  FAIL: deleteBehavior returned false");
        return "FAIL";
      }

      // Step 4: only one behavior remains.
      behaviors = db.listBehaviors(store);
      if (behaviors.length !== 1) {
        console.log(`  FAIL: expected 1 behavior after delete, got ${behaviors.length}`);
        return "FAIL";
      }
      if (behaviors[0].statement !== behavior2Text) {
        console.log(`  FAIL: remaining behavior should be behavior2, got ${behaviors[0].statement}`);
        return "FAIL";
      }

      // Cascade: no orphaned provenance for the deleted behavior.
      const orphanedProv = db.getBehaviorProvenance(behavior1Id);
      if (orphanedProv.length !== 0) {
        console.log(`  FAIL: orphaned provenance entries: ${orphanedProv.length}`);
        return "FAIL";
      }

      // Cascade: scoring no longer returns the deleted behavior.
      const matchers = [{ id: matcherId, description: matcherText, score: 1.0 }];
      const scored = db.scoreBehaviors(matchers);
      if (scored.length !== 1 || scored[0].behavior_id !== behavior2Id) {
        console.log(`  FAIL: scoring should only return behavior2, got ${scored.length} items`);
        return "FAIL";
      }

      // Step 5: not-found case.
      const notFound = db.findNearestBehavior(
        store,
        await model.queryEmbed("completely unrelated text that doesn't match anything"),
        0.85,
      );
      if (notFound) {
        console.log("  FAIL: findNearestBehavior should return null for nonexistent behavior");
        return "FAIL";
      }

      // deleteBehavior returns false for a nonexistent ID.
      if (db.deleteBehavior("nonexistent-id")) {
        console.log("  FAIL: deleteBehavior should return false for nonexistent ID");
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
