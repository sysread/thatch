import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { hygieneReport } from "../../../src/hygiene";

/**
 * UC-058: Hygiene outside a git repo.
 *
 * Automatable: listBranches() returns [] outside a git repo, and
 * hygieneReport() checks if (live.length > 0) before computing orphaned
 * branches. This test seeds duplicates, a stale memory, and a branch-scoped
 * memory, then verifies that from a non-git directory the report includes
 * dedup and stale signals but NOT the orphaned-branch signal.
 */

const useCase: UseCase = {
  name: "UC-058-hygiene-outside-git",
  preconditions: [
    "- A store with: two near-duplicate memories, one stale memory (not updated or recalled in 90+ days), and one memory scoped to a branch",
    "- The working directory is not a git repo (no .git directory)",
  ].join("\n"),
  steps: [
    "1. Run thatch hygiene from a non-git directory.",
    "2. Call hygieneReport() directly with the store and a non-git worktree path.",
    "3. Inspect the report.",
  ].join("\n"),
  expected: [
    "- The report includes the duplicate-candidate signal and the stale-memory signal.",
    "- The report does NOT include an orphaned-branch signal. listBranches() returns [] outside a git repo, and hygieneReport checks if (live.length > 0) before computing orphaned branches. When live is empty, the check is skipped.",
    "- No false-positive memories scoped to deleted branches line appears.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed two identical memories (duplicate signal).
      const dupEmb = await model.passageEmbed("the CI pipeline runs on every push to main");
      db.remember(store, "ci-pipeline-a", "the CI pipeline runs on every push to main", dupEmb, "mock");
      db.remember(store, "ci-pipeline-b", "the CI pipeline runs on every push to main", dupEmb, "mock");

      // Seed a stale memory (will be backdated below).
      const staleEmb = await model.passageEmbed("legacy configuration from the old system");
      db.remember(store, "legacy-config", "legacy configuration from the old system", staleEmb, "mock");

      // Seed a branch-scoped memory.
      const branchEmb = await model.passageEmbed("feature branch work in progress");
      db.remember(store, "branch-work", "feature branch work in progress", branchEmb, "mock", { branch: "feature/gone" });

      db.close();

      // Backdate the stale memory to 100 days ago.
      const { Database } = await import("bun:sqlite");
      const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
      const rawDb = new Database(ctx.env.THATCH_DB_PATH);
      rawDb.run(
        "UPDATE entries SET updated_at = ?, last_recalled_at = ? WHERE store = ? AND label = ?",
        [oldDate, oldDate, store, "legacy-config"],
      );
      rawDb.close();

      // ctx.dir is a git archive extract (no .git directory).
      // listBranches returns [], so hygieneReport skips the orphaned-branch
      // check. Dedup and stale signals should still appear.
      const db2 = new ThatchDB(ctx.env.THATCH_DB_PATH);
      const report = await hygieneReport(db2, store, ctx.dir);
      db2.close();

      if (!report) {
        console.log("  FAIL: report should be non-null (dedup + stale signals expected)");
        return "FAIL";
      }

      // Verify dedup signal present.
      if (!report.includes("duplicate-candidate")) {
        console.log(`  FAIL: report should include dedup signal: ${report}`);
        return "FAIL";
      }

      // Verify stale signal present.
      if (!report.includes("days")) {
        console.log(`  FAIL: report should include stale signal: ${report}`);
        return "FAIL";
      }

      // Verify orphaned-branch signal is NOT present.
      if (report.includes("deleted branches")) {
        console.log(`  FAIL: non-git report should NOT contain orphaned-branch signal: ${report}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
