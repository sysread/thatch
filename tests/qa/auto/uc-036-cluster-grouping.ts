import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-036: Cluster grouping in find_duplicates.
 *
 * Automatable: findDuplicates() returns flat pairs, and renderClusters()
 * groups them into connected components via union-find. This test seeds
 * three pairwise-similar memories, verifies that findDuplicates returns
 * 3 candidate pairs forming one connected component, and that the unique
 * slug count is 3 (a cluster of 3).
 */

const useCase: UseCase = {
  name: "UC-036-cluster-grouping",
  preconditions: [
    "- A store with at least three memories that are pairwise similar (each pair's cosine similarity exceeds the 0.85 threshold)",
  ].join("\n"),
  steps: [
    "1. Run thatch_find_duplicates on the store.",
    "2. Read the tool's output.",
  ].join("\n"),
  expected: [
    "- The output groups the pairs into a single cluster, not three separate pairs. The cluster header reads Cluster of N: where N is the number of distinct labels.",
    "- Each pair within the cluster is listed with its similarity score.",
    "- A cluster of 3+ labels is the signal that one topic was fragmented across multiple entries.",
    "- Verdicts stay pairwise — markPairChecked marks one pair at a time, not a whole cluster.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed three identical memories: same text → same embedding → all
      // pairwise cosine 1.0, which is above the 0.85 threshold.
      const emb = await model.passageEmbed("the API gateway enforces a rate limit of 100 requests per second");
      db.remember(store, "rate-limit-a", "the API gateway enforces a rate limit of 100 requests per second", emb, "mock");
      db.remember(store, "rate-limit-b", "the API gateway enforces a rate limit of 100 requests per second", emb, "mock");
      db.remember(store, "rate-limit-c", "the API gateway enforces a rate limit of 100 requests per second", emb, "mock");

      // findDuplicates should return 3 pairs: A-B, A-C, B-C.
      const candidates = db.findDuplicates(store, 0.85);
      if (candidates.length !== 3) {
        console.log(`  FAIL: expected 3 candidate pairs, got ${candidates.length}`);
        return "FAIL";
      }

      // Verify all 3 unique slugs are present (one connected component).
      const slugSet = new Set<string>();
      for (const c of candidates) {
        slugSet.add(c.slugA);
        slugSet.add(c.slugB);
      }
      if (slugSet.size !== 3) {
        console.log(`  FAIL: expected 3 unique slugs in cluster, got ${slugSet.size}`);
        return "FAIL";
      }

      // Verify all scores are 1.0 (identical embeddings).
      for (const c of candidates) {
        if (c.score !== 1.0) {
          console.log(`  FAIL: expected score 1.0 for identical embeddings, got ${c.score}`);
          return "FAIL";
        }
      }

      // Simulate the connected-component grouping that renderClusters does.
      // Union-Find: each candidate pair unions its two slugs. After all
      // unions, all 3 slugs should share one root (one cluster of 3).
      const parent = new Map<string, string>();
      const find = (x: string): string => {
        let root = parent.get(x) ?? x;
        while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
        parent.set(x, root);
        return root;
      };
      for (const c of candidates) {
        parent.set(find(c.slugA), find(c.slugB));
      }
      const roots = new Set(candidates.map((c) => find(c.slugA)));
      if (roots.size !== 1) {
        console.log(`  FAIL: expected 1 cluster (connected component), got ${roots.size}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
