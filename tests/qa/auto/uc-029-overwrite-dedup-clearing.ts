import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-029: Overwrite clears dedup verdicts.
 *
 * Automatable: the verdict clearing happens in remember()'s overwrite path —
 * a DELETE FROM dedup_pairs statement. This test seeds a similar pair, marks
 * it checked, verifies suppression, then overwrites one memory and verifies
 * the pair re-flags.
 */

const useCase: UseCase = {
  name: "UC-029-overwrite-dedup-clearing",
  preconditions: [
    "- A store with two similar memories (cosine similarity above 0.85) whose pair has been marked checked via dedup_mark_checked",
    "- The pair is suppressed in find_duplicates output",
  ].join("\n"),
  steps: [
    "1. Confirm find_duplicates does not report the checked pair.",
    "2. Overwrite one of the two memories with new, still-similar content via thatch_memory_remember with overwrite: true.",
    "3. Run find_duplicates again.",
  ].join("\n"),
  expected: [
    "- Step 1: the checked pair is absent from find_duplicates output.",
    "- Step 2: the overwrite succeeds. The DELETE FROM dedup_pairs removes all verdicts where the overwritten slug appears as either slug_a or slug_b.",
    "- Step 3: the pair re-appears in find_duplicates because the verdict was cleared and the new content is still similar enough to exceed the threshold.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed two identical memories: same text -> same embedding -> cosine 1.0.
      const emb = await model.passageEmbed("the API rate limit is 100 requests per minute");
      db.remember(store, "api-rate-limit", "the API rate limit is 100 req/min", emb, "mock");
      db.remember(store, "api-rate-limit-v2", "the API rate limit is 100 req/min", emb, "mock");

      // Mark the pair as checked.
      db.markPairChecked(store, db.slugify("api-rate-limit"), db.slugify("api-rate-limit-v2"), "unrelated");

      // Step 1: find_duplicates should not report the checked pair.
      let candidates = db.findDuplicates(store, 0.85);
      if (candidates.length > 0) {
        console.log(`  FAIL: checked pair should be suppressed, got ${candidates.length} candidates`);
        return "FAIL";
      }

      // Step 2: overwrite one memory with new, still-similar content.
      // Same text -> same embedding -> still cosine 1.0 with the other entry.
      // The overwrite path runs DELETE FROM dedup_pairs, clearing the verdict.
      const newEmb = await model.passageEmbed("the API rate limit is 100 requests per minute");
      const result = db.remember(store, "api-rate-limit", "the API rate limit is 100 req/min", newEmb, "mock", { overwrite: true });
      if (!result.ok) {
        console.log(`  FAIL: overwrite failed: ${(result as { ok: false; error: string }).error}`);
        return "FAIL";
      }

      // Step 3: find_duplicates should now report the pair again.
      candidates = db.findDuplicates(store, 0.85);
      if (candidates.length === 0) {
        console.log("  FAIL: pair should re-appear after overwrite cleared the verdict");
        return "FAIL";
      }

      // Verify the pair involves the overwritten slug.
      const pair = candidates[0];
      const slugs = [pair.slugA, pair.slugB].sort();
      const expectedSlugs = [db.slugify("api-rate-limit"), db.slugify("api-rate-limit-v2")].sort();
      if (slugs[0] !== expectedSlugs[0] || slugs[1] !== expectedSlugs[1]) {
        console.log(`  FAIL: wrong pair re-appeared: ${pair.labelA} ↔ ${pair.labelB}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
