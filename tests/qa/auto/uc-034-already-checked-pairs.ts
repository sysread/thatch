import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-034: Already-checked pairs suppressed.
 *
 * Automatable: checked pairs are suppressed via a Set lookup in
 * findDuplicates(). This test seeds a similar pair, marks it checked,
 * verifies it stays suppressed across multiple calls, then overwrites one
 * memory and verifies the pair re-appears.
 */

const useCase: UseCase = {
  name: "UC-034-already-checked-pairs",
  preconditions: [
    "- A store with two similar memories (cosine similarity above 0.85) whose pair has been marked checked via dedup_mark_checked",
    "- The verdict is recorded in the dedup_pairs table",
  ].join("\n"),
  steps: [
    "1. Run thatch_find_duplicates on the store.",
    "2. Confirm the checked pair is absent from the results.",
    "3. Run thatch_find_duplicates again — the pair should still be absent.",
    "4. Overwrite one of the two memories with new content (still similar) via thatch_memory_remember with overwrite: true.",
    "5. Run thatch_find_duplicates again.",
  ].join("\n"),
  expected: [
    "- Steps 1-3: the checked pair is absent from find_duplicates output. The checkedPairs set is built from dedup_pairs rows, and the main loop skips any pair whose key is in the set.",
    "- Step 4: the overwrite clears the verdict — DELETE FROM dedup_pairs WHERE the overwritten slug appears.",
    "- Step 5: the pair re-appears in find_duplicates because the verdict was cleared and the new content is still similar enough to exceed the threshold.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed two identical memories: same text → cosine 1.0.
      const emb = await model.passageEmbed("the deployment pipeline uses blue-green strategy");
      db.remember(store, "deploy-strategy", "the deployment pipeline uses blue-green strategy", emb, "mock");
      db.remember(store, "deploy-strategy-v2", "the deployment pipeline uses blue-green strategy", emb, "mock");

      // Mark the pair as checked.
      db.markPairChecked(store, db.slugify("deploy-strategy"), db.slugify("deploy-strategy-v2"), "unrelated");

      // Steps 1-3: pair should be absent across multiple calls.
      for (let i = 0; i < 3; i++) {
        const candidates = db.findDuplicates(store, 0.85);
        if (candidates.length > 0) {
          console.log(`  FAIL: call ${i + 1}: checked pair should be suppressed, got ${candidates.length} candidates`);
          return "FAIL";
        }
      }

      // Step 4: overwrite one memory with new, still-similar content.
      // Same text → same embedding → still cosine 1.0 with the other entry.
      const newEmb = await model.passageEmbed("the deployment pipeline uses blue-green strategy");
      const result = db.remember(store, "deploy-strategy", "the deployment pipeline uses blue-green strategy", newEmb, "mock", { overwrite: true });
      if (!result.ok) {
        console.log(`  FAIL: overwrite failed: ${(result as { ok: false; error: string }).error}`);
        return "FAIL";
      }

      // Step 5: pair should re-appear.
      const candidates = db.findDuplicates(store, 0.85);
      if (candidates.length === 0) {
        console.log("  FAIL: pair should re-appear after overwrite cleared the verdict");
        return "FAIL";
      }

      // Verify it's the right pair.
      const pair = candidates[0];
      if (pair.labelA !== "deploy-strategy" && pair.labelB !== "deploy-strategy") {
        console.log(`  FAIL: re-appeared pair should involve deploy-strategy, got ${pair.labelA} ↔ ${pair.labelB}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
