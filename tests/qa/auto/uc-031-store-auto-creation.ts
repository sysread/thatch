import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-031: Store auto-creation on first save.
 *
 * Automatable: ensureStore() is an idempotent INSERT OR IGNORE called inside
 * remember(). This test verifies that a new store appears in listStores after
 * the first save, with no explicit store-creation call.
 */

const useCase: UseCase = {
  name: "UC-031-store-auto-creation",
  preconditions: [
    "- A clean database with only the default global store",
    "- A thatch tool or CLI capable of calling thatch_memory_remember with a custom store name",
  ].join("\n"),
  steps: [
    "1. List current stores via thatch_store_list. Confirm only global appears.",
    "2. Save a memory to a new store name, e.g. thatch_memory_remember with store: \"my-new-store\".",
    "3. List stores again via thatch_store_list.",
  ].join("\n"),
  expected: [
    "- Step 1: thatch_store_list returns only global.",
    "- Step 2: the save succeeds with [saved] my-new-store :: <label>.",
    "- Step 3: thatch_store_list now returns both global and my-new-store.",
    "- No explicit store-creation call was needed. The ensureStore() call created the store row as a side effect of the first save.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();

    try {
      // Step 1: only "global" should exist in a fresh DB.
      const storesBefore = db.listStores();
      if (storesBefore.length !== 1 || storesBefore[0] !== "global") {
        console.log(`  FAIL: expected only [global], got ${JSON.stringify(storesBefore)}`);
        return "FAIL";
      }

      // Step 2: save a memory to a new store — no explicit create call.
      const emb = await model.passageEmbed("test memory for store auto-creation");
      const newStore = "my-new-store";
      const result = db.remember(newStore, "auto-create-test", "test memory for store auto-creation", emb, "mock");
      if (!result.ok) {
        console.log(`  FAIL: save to new store failed: ${(result as { ok: false; error: string }).error}`);
        return "FAIL";
      }

      // Step 3: the new store should now appear alongside global.
      const storesAfter = db.listStores();
      if (!storesAfter.includes("global") || !storesAfter.includes(newStore)) {
        console.log(`  FAIL: expected [global, my-new-store], got ${JSON.stringify(storesAfter)}`);
        return "FAIL";
      }
      if (storesAfter.length !== 2) {
        console.log(`  FAIL: expected exactly 2 stores, got ${storesAfter.length}: ${JSON.stringify(storesAfter)}`);
        return "FAIL";
      }

      // Verify the entry was actually saved in the new store.
      const entries = db.listEntries(newStore);
      if (entries.length !== 1) {
        console.log(`  FAIL: expected 1 entry in new store, got ${entries.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
