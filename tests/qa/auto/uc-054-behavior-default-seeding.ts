import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { seedDefaultBehaviors } from "../../../src/seed-behaviors";

/**
 * UC-054: Behavior default seeding.
 *
 * Automatable: seedDefaultBehaviors is a pure DB+embedding function.
 * This test calls it with a clean DB and MockEmbeddingModel, verifies
 * behaviors are seeded in the global store, then calls it again to
 * verify idempotence (no duplicates).
 */

const useCase: UseCase = {
  name: "UC-054-behavior-default-seeding",
  preconditions: [
    "- A clean DB (no existing behaviors in the global store)",
    "- The seedDefaultBehaviors function available (called by both the opencode plugin and the MCP server at startup)",
  ].join("\n"),
  steps: [
    "1. Start thatch with a clean DB. The seedDefaultBehaviors function runs after DB and model initialization.",
    "2. Call `behavior_list(store='global')` to inspect the seeded behaviors.",
    "3. Restart thatch (or call seedDefaultBehaviors again) with the same DB.",
    "4. Call `behavior_list(store='global')` to verify no duplicates.",
  ].join("\n"),
  expected: [
    "- Step 2: behavior_list shows all default behaviors in the global store. Each has confidence=0.50, evidence count=0, one matcher, and one provenance entry (codify). The rationale for each carries a version stamp.",
    "- Step 4: Same set of behaviors — no duplicates. The idempotence check uses findNearestBehaviorMatcher with cosine >= 0.85. If a matcher already exists, the seed skips.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();

    try {
      // Step 1: seed default behaviors into a clean DB.
      await seedDefaultBehaviors(db, model);

      // Step 2: verify behaviors were seeded in the global store.
      let behaviors = db.listBehaviors("global");
      if (behaviors.length === 0) {
        console.log("  FAIL: no default behaviors seeded");
        return "FAIL";
      }

      // Each behavior should have confidence=0.50, 0 evidence, 1 matcher, 1 provenance.
      for (const b of behaviors) {
        if (Math.abs(b.confidence - 0.5) > 0.01) {
          console.log(`  FAIL: behavior "${b.statement.slice(0, 40)}..." confidence should be ~0.5, got ${b.confidence}`);
          return "FAIL";
        }
        if (b.evidence_count !== 0) {
          console.log(`  FAIL: behavior "${b.statement.slice(0, 40)}..." should have 0 evidence, got ${b.evidence_count}`);
          return "FAIL";
        }
        if (b.matchers.length !== 1) {
          console.log(`  FAIL: behavior "${b.statement.slice(0, 40)}..." should have 1 matcher, got ${b.matchers.length}`);
          return "FAIL";
        }
        // Verify version stamp in rationale.
        if (!b.rationale || !b.rationale.includes("seed-version:")) {
          console.log(`  FAIL: behavior "${b.statement.slice(0, 40)}..." rationale should have version stamp`);
          return "FAIL";
        }
      }

      const firstCount = behaviors.length;

      // Step 3: call seedDefaultBehaviors again (idempotence).
      await seedDefaultBehaviors(db, model);

      // Step 4: verify no duplicates.
      behaviors = db.listBehaviors("global");
      if (behaviors.length !== firstCount) {
        console.log(`  FAIL: expected ${firstCount} behaviors after re-seed, got ${behaviors.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
