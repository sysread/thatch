import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-035: Verdict clearing on overwrite and forget.
 *
 * Automatable: both remember() (overwrite path) and forgetEntry() run
 * DELETE FROM dedup_pairs. This test seeds a similar pair, marks it checked,
 * then exercises both clearing paths: overwrite re-flags the pair, and
 * forget removes one entry so the pair can no longer form.
 */

const useCase: UseCase = {
  name: "UC-035-verdict-clearing-on-overwrite",
  preconditions: [
    "- A store with two similar memories whose pair has been marked checked via dedup_mark_checked",
    "- The pair is currently suppressed in find_duplicates",
  ].join("\n"),
  steps: [
    "1. Confirm find_duplicates does not report the checked pair.",
    "2. Overwrite one memory with new, still-similar content via thatch_memory_remember with overwrite: true.",
    "3. Run find_duplicates — the pair should re-appear.",
    "4. Mark the pair checked again via dedup_mark_checked.",
    "5. Forget the other memory via thatch_memory_forget.",
    "6. Run find_duplicates — the pair should not appear (one memory is gone).",
  ].join("\n"),
  expected: [
    "- Step 2: the overwrite triggers DELETE FROM dedup_pairs, clearing all verdicts involving the overwritten slug.",
    "- Step 3: the pair re-appears because the verdict was cleared and the new content still exceeds the threshold.",
    "- Step 5: forgetEntry runs the same DELETE FROM dedup_pairs statement, clearing all verdicts involving the forgotten slug. The entry itself is also deleted.",
    "- Step 6: the pair does not appear because one of the two memories no longer exists. findDuplicates only queries entries, so a deleted entry cannot form a pair.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed two identical memories: same text → cosine 1.0.
      const emb = await model.passageEmbed("redis cache eviction policy is set to LRU");
      db.remember(store, "cache-policy", "redis cache eviction policy is set to LRU", emb, "mock");
      db.remember(store, "cache-policy-v2", "redis cache eviction policy is set to LRU", emb, "mock");

      // Mark the pair as checked.
      db.markPairChecked(store, db.slugify("cache-policy"), db.slugify("cache-policy-v2"), "unrelated");

      // Step 1: find_duplicates should not report the checked pair.
      let candidates = db.findDuplicates(store, 0.85);
      if (candidates.length > 0) {
        console.log(`  FAIL: checked pair should be suppressed, got ${candidates.length} candidates`);
        return "FAIL";
      }

      // Step 2: overwrite one memory with new, still-similar content.
      const newEmb = await model.passageEmbed("redis cache eviction policy is set to LRU");
      const result = db.remember(store, "cache-policy", "redis cache eviction policy is set to LRU", newEmb, "mock", { overwrite: true });
      if (!result.ok) {
        console.log(`  FAIL: overwrite failed: ${(result as { ok: false; error: string }).error}`);
        return "FAIL";
      }

      // Step 3: pair should re-appear.
      candidates = db.findDuplicates(store, 0.85);
      if (candidates.length === 0) {
        console.log("  FAIL: pair should re-appear after overwrite cleared the verdict");
        return "FAIL";
      }

      // Step 4: mark the pair as checked again.
      db.markPairChecked(store, db.slugify("cache-policy"), db.slugify("cache-policy-v2"), "duplicate");

      // Verify suppression.
      candidates = db.findDuplicates(store, 0.85);
      if (candidates.length > 0) {
        console.log("  FAIL: pair should be suppressed after re-marking as checked");
        return "FAIL";
      }

      // Step 5: forget the other memory.
      const forgotten = db.forgetEntry(store, "cache-policy-v2");
      if (!forgotten) {
        console.log("  FAIL: forgetEntry returned false (entry not found)");
        return "FAIL";
      }

      // Verify the entry is gone.
      const entries = db.listEntries(store);
      if (entries.some((e) => e.label === "cache-policy-v2")) {
        console.log("  FAIL: forgotten entry should not appear in listEntries");
        return "FAIL";
      }

      // Step 6: find_duplicates should not report the pair (one memory gone).
      candidates = db.findDuplicates(store, 0.85);
      if (candidates.length > 0) {
        console.log(`  FAIL: pair should not appear after forget, got ${candidates.length} candidates`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
