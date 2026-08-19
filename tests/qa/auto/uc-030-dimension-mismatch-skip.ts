import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-030: Dimension mismatch silently skipped.
 *
 * Automatable: the skip is a pure length check in search() —
 * if (emb.length !== queryEmbedding.length) return []. This test seeds
 * entries at two different vector dimensions and verifies that each query
 * only returns entries matching its dimension.
 */

/** Produces a deterministic vector of the given dimension, same algorithm as MockEmbeddingModel. */
function makeVec(text: string, dims: number): Float32Array {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h |= 0;
  }
  h ^= 0x9e3779b9;
  const vec = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
    vec[i] = h / 0x80000000;
  }
  return vec;
}

const useCase: UseCase = {
  name: "UC-030-dimension-mismatch-skip",
  preconditions: [
    "- A store containing entries embedded at two different dimensions (e.g. 384-dim and 128-dim)",
  ].join("\n"),
  steps: [
    "1. Embed a query at dimension A (384).",
    "2. Run recall against the store with the dimension-A query.",
    "3. Embed a query at dimension B (128).",
    "4. Run recall against the store with the dimension-B query.",
    "5. Inspect all entries via listEntries.",
  ].join("\n"),
  expected: [
    "- The dimension-A query returns only dimension-A entries. Dimension-B entries are skipped.",
    "- The dimension-B query returns only dimension-B entries. Same skip logic.",
    "- Both entry sets are intact in the database — list returns all entries regardless of dimension.",
    "- The model column differs between the two sets but is never consulted by the search path. Dimension is the sole discriminator.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed 384-dim entries (using MockEmbeddingModel, which defaults to 384).
      const emb384a = await model.passageEmbed("api rate limit configuration");
      db.remember(store, "rate-limit-384", "api rate limit configuration", emb384a, "mock-384");

      const emb384b = await model.passageEmbed("database connection pool settings");
      db.remember(store, "db-pool-384", "database connection pool settings", emb384b, "mock-384");

      // Seed 128-dim entries (using the inline helper).
      const emb128a = makeVec("api rate limit configuration", 128);
      db.remember(store, "rate-limit-128", "api rate limit configuration", emb128a, "mock-128");

      const emb128b = makeVec("database connection pool settings", 128);
      db.remember(store, "db-pool-128", "database connection pool settings", emb128b, "mock-128");

      // All 4 entries should be visible via listEntries, regardless of dimension.
      const allEntries = db.listEntries(store);
      if (allEntries.length !== 4) {
        console.log(`  FAIL: expected 4 entries in list, got ${allEntries.length}`);
        return "FAIL";
      }

      // Step 1-2: query at 384 dims → only 384-dim entries returned.
      const query384 = await model.queryEmbed("api rate limit configuration");
      const results384 = db.search([store], query384, { limit: 10 });

      if (results384.length === 0) {
        console.log("  FAIL: 384-dim query returned no results");
        return "FAIL";
      }
      for (const r of results384) {
        if (r.model !== "mock-384") {
          console.log(`  FAIL: 384-dim query returned entry from model ${r.model} (expected mock-384)`);
          return "FAIL";
        }
      }
      // Should find both 384-dim entries (identical text → cosine 1.0, plus the other).
      if (results384.length !== 2) {
        console.log(`  FAIL: expected 2 results from 384-dim query, got ${results384.length}`);
        return "FAIL";
      }

      // Step 3-4: query at 128 dims → only 128-dim entries returned.
      const query128 = makeVec("api rate limit configuration", 128);
      const results128 = db.search([store], query128, { limit: 10 });

      if (results128.length === 0) {
        console.log("  FAIL: 128-dim query returned no results");
        return "FAIL";
      }
      for (const r of results128) {
        if (r.model !== "mock-128") {
          console.log(`  FAIL: 128-dim query returned entry from model ${r.model} (expected mock-128)`);
          return "FAIL";
        }
      }
      if (results128.length !== 2) {
        console.log(`  FAIL: expected 2 results from 128-dim query, got ${results128.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
