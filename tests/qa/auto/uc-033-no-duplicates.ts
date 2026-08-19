import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-033: No duplicates found.
 *
 * Automatable: findDuplicates() is a pure DB operation. This test seeds two
 * dissimilar memories and verifies that find_duplicates returns an empty
 * array — the "No duplicates found" condition.
 */

const useCase: UseCase = {
  name: "UC-033-no-duplicates",
  preconditions: [
    "- A store with at least two memories whose content is dissimilar (cosine similarity below 0.85)",
  ].join("\n"),
  steps: [
    "1. Run thatch_find_duplicates on the store.",
    "2. Read the tool's response.",
  ].join("\n"),
  expected: [
    "- The tool returns a No duplicates found message (or equivalent empty result).",
    "- No pairs are listed.",
    "- The tool does not error — an empty result is a valid state, not a failure.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed two dissimilar memories. MockEmbeddingModel produces
      // near-orthogonal vectors for different texts, so cosine < 0.85.
      const emb1 = await model.passageEmbed("database connection pool tuning for high throughput");
      db.remember(store, "db-tuning", "database connection pool tuning for high throughput", emb1, "mock");

      const emb2 = await model.passageEmbed("user interface color palette and typography choices");
      db.remember(store, "ui-design", "user interface color palette and typography choices", emb2, "mock");

      // find_duplicates should return no candidates.
      const candidates = db.findDuplicates(store, 0.85);
      if (candidates.length !== 0) {
        console.log(`  FAIL: expected 0 candidates for dissimilar memories, got ${candidates.length}`);
        return "FAIL";
      }

      // Verify both entries exist — they're just not similar to each other.
      const entries = db.listEntries(store);
      if (entries.length !== 2) {
        console.log(`  FAIL: expected 2 entries in store, got ${entries.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
