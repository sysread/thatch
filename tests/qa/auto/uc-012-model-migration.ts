import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../src/embeddings";

/**
 * UC-012: THATCH_MODEL migration (mixed embedding dimensions).
 *
 * Automatable: dimension-skip and data-intact assertions are pure DB calls.
 * Uses two MockEmbeddingModel instances with different dimensions (384 and
 * 128) — no network, no real model download. The search/recall path skips
 * entries whose embedding dimension differs from the query (silent skip,
 * not an error), so old memories stay intact but invisible to search until
 * re-saved.
 *
 * MockEmbeddingModel declares `readonly dims = 384` which TypeScript infers
 * as the literal type `384`, preventing a subclass from overriding it. Instead,
 * we use Object.defineProperty to change `dims` and `name` at runtime. The
 * private `#embed` method reads `this.dims`, so the vectors get the
 * overridden dimension.
 */

function mockModel(dims: number, name: string): MockEmbeddingModel {
  const m = new MockEmbeddingModel();
  Object.defineProperty(m, "dims", { value: dims, writable: false, configurable: true });
  Object.defineProperty(m, "name", { value: name, writable: false, configurable: true });
  return m;
}

const useCase: UseCase = {
  name: "UC-012-model-migration",
  preconditions: [
    "- A store with memories embedded by a model of dimension A (e.g. the default 384-dim `bge-small-en-v1.5`)",
    "- A second model available whose vectors have a **different** dimension",
  ].join("\n"),
  steps: [
    "1. `export THATCH_MODEL=<other-model>` (different vector dimension).",
    "2. Start a fresh session. `memory_list` and `memory_show` an old memory by label.",
    "3. `memory_recall` for a topic that matches an old memory.",
    "4. Save a new memory with the new model; `memory_recall` for it.",
    "5. `memory_show` an old memory and inspect its `model` tag.",
  ].join("\n"),
  expected: [
    "- `list` and `show` still return the old memories — the data is intact, **not corrupted and not deleted**.",
    "- `recall` returns **no matches** for the old memories: entries whose vector dimension differs from the query are skipped, not scored. This is a silent skip, not an error.",
    "- The new memory embeds at the new dimension and is recallable.",
    "- `show` reveals the old memories carry the old model tag while new ones carry the new tag. There is **no automatic re-embedding** — old memories stay invisible to search until re-saved.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const dbPath = ctx.env.THATCH_DB_PATH;
    const store = "migration-test";
    const model384 = new MockEmbeddingModel();
    const model128 = mockModel(128, "mock-128");

    const db = new ThatchDB(dbPath);

    // --- Seed two memories with the 384-dim model ---

    const oldContent1 = "the database runs on port 5432";
    const oldEmb1 = await model384.passageEmbed(oldContent1);
    db.remember(store, "db-port", oldContent1, oldEmb1, "mock");

    const oldContent2 = "redis cache expires after 300 seconds";
    const oldEmb2 = await model384.passageEmbed(oldContent2);
    db.remember(store, "redis-ttl", oldContent2, oldEmb2, "mock");

    // --- Step 2: list and show still return old memories (data intact) ---

    const entries = db.listEntries(store);
    if (entries.length !== 2) {
      console.log(`  FAIL: listEntries returned ${entries.length} entries (expected 2)`);
      db.close();
      return "FAIL";
    }

    const shown = db.showEntry(store, "db-port");
    if (!shown || shown.content !== oldContent1) {
      console.log(`  FAIL: showEntry for old memory missing or wrong content: ${shown?.content}`);
      db.close();
      return "FAIL";
    }

    // --- Step 3: recall with 128-dim query → old memories are skipped ---

    // The search method skips entries whose embedding length differs from
    // the query (silent skip via flatMap returning []). This is not an
    // error — it's a dimension-space guard against NaN scores.
    const query128 = await model128.queryEmbed(oldContent1);
    const recallOld = db.recall([store], query128);
    if (recallOld.length !== 0) {
      console.log(`  FAIL: recall with 128-dim query should skip 384-dim entries, got ${recallOld.length} matches`);
      db.close();
      return "FAIL";
    }

    // --- Step 4: save a new memory with the 128-dim model, then recall it ---

    const newContent = "the API gateway listens on port 8080";
    const newEmb = await model128.passageEmbed(newContent);
    db.remember(store, "api-gateway-port", newContent, newEmb, "mock-128");

    const recallNew = db.recall([store], await model128.queryEmbed(newContent));
    if (recallNew.length === 0) {
      console.log("  FAIL: new 128-dim memory not recallable");
      db.close();
      return "FAIL";
    }
    if (!recallNew.some((r) => r.label === "api-gateway-port")) {
      console.log(`  FAIL: recall didn't return the new memory: ${recallNew.map((r) => r.label)}`);
      db.close();
      return "FAIL";
    }

    // --- Step 5: model tags differ between old and new memories ---

    const oldEntry = db.showEntry(store, "db-port");
    if (!oldEntry || oldEntry.model !== "mock") {
      console.log(`  FAIL: old memory model tag should be 'mock', got: ${oldEntry?.model}`);
      db.close();
      return "FAIL";
    }

    const newEntry = db.showEntry(store, "api-gateway-port");
    if (!newEntry || newEntry.model !== "mock-128") {
      console.log(`  FAIL: new memory model tag should be 'mock-128', got: ${newEntry?.model}`);
      db.close();
      return "FAIL";
    }

    // --- Verify old memories are still visible to a 384-dim recall ---

    // No automatic re-embedding: old memories stay in their original vector
    // space and are recallable with a matching-dimension query.
    const recall384 = db.recall([store], oldEmb1);
    if (recall384.length === 0) {
      console.log("  FAIL: old 384-dim memory not recallable with a 384-dim query");
      db.close();
      return "FAIL";
    }

    db.close();
    return "PASS";
  },
};

registerUseCase(useCase);
