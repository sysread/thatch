import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../src/embeddings";

/**
 * UC-011: Write-time similarity warning.
 *
 * Automatable: the "save proceeds + warning lists similar entries" contract
 * and both reconciliation paths are pure DB calls with no LLM in the loop.
 * Uses MockEmbeddingModel for deterministic vectors (identical text produces
 * identical embeddings, cosine similarity 1.0).
 */

const useCase: UseCase = {
  name: "UC-011-write-time-similarity-warning",
  preconditions: [
    '- A store with a memory, e.g. `API rate limit` -> "the API rate limit is 100 req/min"',
    "- A second, similar memory not yet saved",
  ].join("\n"),
  steps: [
    "1. Save the second memory under a different label with similar content, without `overwrite: true`.",
    "2. Read the tool's response.",
  ].join("\n"),
  expected: [
    "- The save **succeeds** (`[saved] ...`) — the warning never blocks. The response also carries a warning listing the existing memory with a similarity score and instructions to reconcile.",
    "- Two reconciliation paths both work:",
    "  - Merge: `memory_remember` the merged content with `overwrite: true` on the better label, then `memory_forget` the other. The survivor has the combined content; the deleted label is gone.",
    "  - Mark distinct: `dedup_mark_checked` the pair as `unrelated`. A subsequent `find_duplicates` no longer reports the pair.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const dbPath = ctx.env.THATCH_DB_PATH;
    const model = new MockEmbeddingModel();
    const db = new ThatchDB(dbPath);

    // --- Seed: save memory A, then check findSimilar before saving B ---

    const store = "merge-test";
    const content = "the API rate limit is 100 req/min";
    const emb = await model.passageEmbed(content);

    const resultA = db.remember(store, "api-rate-limit", content, emb, "mock");
    if (!resultA.ok) {
      console.log(`  FAIL: seeding memory A failed: ${resultA.error}`);
      db.close();
      return "FAIL";
    }

    // findSimilar is the write-time collision check. The plugin calls it
    // before saving a new memory to warn about existing similar entries.
    // With identical text, the embedding is the same, so cosine = 1.0.
    const similar = db.findSimilar(store, emb);
    if (similar.length === 0) {
      console.log("  FAIL: findSimilar returned no matches (expected a warning)");
      db.close();
      return "FAIL";
    }
    if (!similar.some((s) => s.label === "api-rate-limit")) {
      console.log(`  FAIL: findSimilar didn't list the existing memory: ${JSON.stringify(similar)}`);
      db.close();
      return "FAIL";
    }

    // Save B: same content, different label. The save must succeed even
    // though a similar memory exists — the warning never blocks.
    const resultB = db.remember(store, "api-rate-limit-v2", content, emb, "mock");
    if (!resultB.ok) {
      console.log(`  FAIL: save with similar content should succeed: ${resultB.error}`);
      db.close();
      return "FAIL";
    }

    // --- Reconciliation path 1: Merge (overwrite + forget) ---

    const mergedContent = "the API rate limit is 100 req/min (confirmed by ops)";
    const mergedEmb = await model.passageEmbed(mergedContent);
    const overwriteResult = db.remember(store, "api-rate-limit", mergedContent, mergedEmb, "mock", { overwrite: true });
    if (!overwriteResult.ok) {
      console.log(`  FAIL: overwrite for merge failed: ${(overwriteResult as { ok: false; error: string }).error}`);
      db.close();
      return "FAIL";
    }

    const forgot = db.forgetEntry(store, "api-rate-limit-v2");
    if (!forgot) {
      console.log("  FAIL: forgetEntry for merge failed (label not found)");
      db.close();
      return "FAIL";
    }

    // Verify B is gone and A has the merged content.
    if (db.showEntry(store, "api-rate-limit-v2") !== null) {
      console.log("  FAIL: forgotten label still exists after merge");
      db.close();
      return "FAIL";
    }
    const survivor = db.showEntry(store, "api-rate-limit");
    if (!survivor || survivor.content !== mergedContent) {
      console.log(`  FAIL: survivor doesn't have merged content: ${survivor?.content}`);
      db.close();
      return "FAIL";
    }

    // --- Reconciliation path 2: Mark distinct (dedup_mark_checked) ---

    // Seed two fresh similar memories in a separate store.
    const store2 = "mark-test";
    const content2 = "database connection pool size is 20";
    const emb2 = await model.passageEmbed(content2);
    db.remember(store2, "db-pool-size", content2, emb2, "mock");
    db.remember(store2, "db-pool-size-v2", content2, emb2, "mock");

    // findDuplicates should report the pair before marking.
    const dupsBefore = db.findDuplicates(store2);
    if (dupsBefore.length === 0) {
      console.log("  FAIL: findDuplicates didn't report the similar pair before marking");
      db.close();
      return "FAIL";
    }

    // Mark the pair as "unrelated" — same as the dedup_mark_checked tool.
    const slugC = db.slugify("db-pool-size");
    const slugD = db.slugify("db-pool-size-v2");
    db.markPairChecked(store2, slugC, slugD, "unrelated");

    // findDuplicates should no longer report the checked pair.
    const dupsAfter = db.findDuplicates(store2);
    if (dupsAfter.some((d) => d.labelA === "db-pool-size" || d.labelB === "db-pool-size")) {
      console.log("  FAIL: findDuplicates still reports the pair after markPairChecked");
      db.close();
      return "FAIL";
    }

    db.close();
    return "PASS";
  },
};

registerUseCase(useCase);
