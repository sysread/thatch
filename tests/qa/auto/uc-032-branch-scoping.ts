import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-032: Branch scoping in recall.
 *
 * Automatable: the branch filter is a SQL-level WHERE clause in search().
 * This test seeds three memories (two branch-scoped, one unscoped), then
 * verifies that recall with a branch filter includes branch-matched plus
 * unscoped entries, while recall without a filter returns all entries.
 */

const useCase: UseCase = {
  name: "UC-032-branch-scoping",
  preconditions: [
    "- A store with at least three memories: one scoped to feature-a, one scoped to feature-b, and one unscoped (project-wide)",
  ].join("\n"),
  steps: [
    "1. Save memory A with branch: \"feature-a\".",
    "2. Save memory B with branch: \"feature-b\".",
    "3. Save memory C with no branch param (project-wide).",
    "4. Run thatch_memory_recall with branch: \"feature-a\".",
    "5. Run thatch_memory_recall with branch: \"feature-b\".",
    "6. Run thatch_memory_recall without a branch param.",
  ].join("\n"),
  expected: [
    "- Step 4: results include memory A (branch-scoped to feature-a) and memory C (unscoped). Memory B is excluded.",
    "- Step 5: results include memory B and memory C. Memory A is excluded.",
    "- Step 6: results include all three memories — no branch filter means no branch restriction.",
    "- The SQL adds AND (branch IS NULL OR branch = ?) when a branch filter is present, so unscoped entries always appear alongside branch-matched entries.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed three memories with distinct texts so embeddings differ.
      const embA = await model.passageEmbed("feature A database schema design");
      db.remember(store, "memory-a", "feature A database schema design", embA, "mock", { branch: "feature-a" });

      const embB = await model.passageEmbed("feature B API endpoint routing");
      db.remember(store, "memory-b", "feature B API endpoint routing", embB, "mock", { branch: "feature-b" });

      const embC = await model.passageEmbed("project-wide coding conventions");
      db.remember(store, "memory-c", "project-wide coding conventions", embC, "mock");

      // Step 4: recall with branch "feature-a" → A and C, not B.
      const queryA = await model.queryEmbed("feature A database schema design");
      const resultsA = db.search([store], queryA, { branch: "feature-a", limit: 10 });
      const labelsA = resultsA.map((r) => r.label);

      if (!labelsA.includes("memory-a")) {
        console.log(`  FAIL: feature-a recall should include memory-a, got ${JSON.stringify(labelsA)}`);
        return "FAIL";
      }
      if (!labelsA.includes("memory-c")) {
        console.log(`  FAIL: feature-a recall should include unscoped memory-c, got ${JSON.stringify(labelsA)}`);
        return "FAIL";
      }
      if (labelsA.includes("memory-b")) {
        console.log(`  FAIL: feature-a recall should exclude memory-b, got ${JSON.stringify(labelsA)}`);
        return "FAIL";
      }

      // Step 5: recall with branch "feature-b" → B and C, not A.
      const queryB = await model.queryEmbed("feature B API endpoint routing");
      const resultsB = db.search([store], queryB, { branch: "feature-b", limit: 10 });
      const labelsB = resultsB.map((r) => r.label);

      if (!labelsB.includes("memory-b")) {
        console.log(`  FAIL: feature-b recall should include memory-b, got ${JSON.stringify(labelsB)}`);
        return "FAIL";
      }
      if (!labelsB.includes("memory-c")) {
        console.log(`  FAIL: feature-b recall should include unscoped memory-c, got ${JSON.stringify(labelsB)}`);
        return "FAIL";
      }
      if (labelsB.includes("memory-a")) {
        console.log(`  FAIL: feature-b recall should exclude memory-a, got ${JSON.stringify(labelsB)}`);
        return "FAIL";
      }

      // Step 6: recall without branch → all three.
      const queryAll = await model.queryEmbed("project conventions and features");
      const resultsAll = db.search([store], queryAll, { limit: 10 });
      const labelsAll = resultsAll.map((r) => r.label);

      if (!labelsAll.includes("memory-a") || !labelsAll.includes("memory-b") || !labelsAll.includes("memory-c")) {
        console.log(`  FAIL: unfiltered recall should include all three, got ${JSON.stringify(labelsAll)}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
