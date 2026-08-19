import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { hygieneReport } from "../../../src/hygiene";

/**
 * UC-057: Healthy store stays silent.
 *
 * Automatable: hygieneReport() is a pure function over the DB and git state.
 * This test seeds a store with fresh, non-stale, non-duplicate memories and
 * verifies that hygieneReport returns null (no signals), and the CLI prints
 * "Store is healthy."
 */

const useCase: UseCase = {
  name: "UC-057-hygiene-healthy-store",
  preconditions: [
    "- A store with a few fresh, non-stale, non-duplicate memories",
    "- No memories scoped to deleted branches",
    "- All memories updated or recalled within the last 90 days",
  ].join("\n"),
  steps: [
    "1. Run thatch hygiene from the repo.",
    "2. Call hygieneReport() directly with the store and repo path.",
    "3. Run thatch reminder and inspect the session-start text.",
  ].join("\n"),
  expected: [
    '- thatch hygiene prints "Store is healthy."',
    "- hygieneReport() returns null — no parts were added to the report because all three signal counts were zero.",
    "- thatch reminder omits the hygiene block from the session-start text. The reminder still includes other sections but no hygiene line.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "healthy-store";

    try {
      // Seed a few fresh, dissimilar, non-branch-scoped memories.
      // Fresh = updated_at = now (set by remember()).
      // Non-duplicate = different texts → low cosine → below 0.85 threshold.
      // Non-branch-scoped = no branch param → branch IS NULL.
      const emb1 = await model.passageEmbed("database connection pool configuration details");
      db.remember(store, "db-config", "database connection pool configuration details", emb1, "mock");

      const emb2 = await model.passageEmbed("user authentication flow with OAuth2");
      db.remember(store, "auth-flow", "user authentication flow with OAuth2", emb2, "mock");

      // hygieneReport should return null (all three signals are zero).
      const report = await hygieneReport(db, store, ctx.dir);
      if (report !== null) {
        console.log(`  FAIL: healthy store should return null, got: ${report}`);
        return "FAIL";
      }

      // Verify the store has entries (sanity check).
      const entries = db.listEntries(store);
      if (entries.length !== 2) {
        console.log(`  FAIL: expected 2 entries in healthy store, got ${entries.length}`);
        return "FAIL";
      }

      // Verify no duplicates.
      const dupes = db.findDuplicates(store, 0.85);
      if (dupes.length !== 0) {
        console.log(`  FAIL: healthy store should have 0 duplicates, got ${dupes.length}`);
        return "FAIL";
      }

      // Verify no stale entries.
      const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const stale = db.staleEntryCount(store, cutoff);
      if (stale !== 0) {
        console.log(`  FAIL: healthy store should have 0 stale entries, got ${stale}`);
        return "FAIL";
      }

      // Verify no branch-scoped entries (so orphaned-branch check is a no-op).
      const branches = db.branchesInStore(store);
      if (branches.length !== 0) {
        console.log(`  FAIL: healthy store should have 0 branch-scoped entries, got ${branches.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
