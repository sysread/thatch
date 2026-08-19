import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase } from "../runner";
import { ThatchDB } from "../../../src/db";

/**
 * UC-090: Dimension mismatch.
 *
 * Automatable: entries embedded with a different vector dimension are
 * silently skipped during cosine search. Seeds entries with 384-dim and
 * 128-dim embeddings, then verifies search only returns matching dims.
 */

/** Creates a deterministic Float32Array of the given dimension. */
function makeVector(dims: number, seed: number): Float32Array {
  const vec = new Float32Array(dims);
  let h = seed;
  for (let i = 0; i < dims; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h |= 0;
    vec[i] = h / 0x80000000;
  }
  return vec;
}

const useCase: UseCase = {
  name: "UC-090-dimension-mismatch",
  preconditions: [
    "- A temp DB with entries embedded by a mock model producing 384-dimension vectors",
    "- A second set of entries embedded by a mock model producing a different dimension (e.g., 128)",
    "- The search function available via ThatchDB",
  ].join("\n"),
  steps: [
    "1. Create a temp DB and insert several entries embedded with 384-dimension vectors.",
    "2. Insert additional entries embedded with 128-dimension vectors (different model).",
    "3. Run a cosine search with a 384-dimension query vector.",
    "4. Verify only 384-dimension entries appear in the results.",
    "5. Verify 128-dimension entries are absent from the results (silently skipped).",
    "6. Run a cosine search with a 128-dimension query vector.",
    "7. Verify only 128-dimension entries appear in the results.",
    "8. Verify no error or warning is produced for the mismatch.",
  ].join("\n"),
  expected: [
    "- Search results contain only entries whose embedding dimension matches the query vector's dimension.",
    "- Mismatched entries are silently excluded — no error, no warning, no partial result.",
    "- Both dimension groups coexist in the same store without interfering with each other's search results.",
  ].join("\n"),

  async run() {
    const tmpDir = mkdtempSync(join(tmpdir(), "thatch-uc-090-"));
    const dbPath = join(tmpDir, "thatch.db");
    const store = "test-dims";

    const db = new ThatchDB(dbPath);

    try {
      // Step 1: insert 384-dim entries
      const vec384a = makeVector(384, 1);
      const vec384b = makeVector(384, 2);
      db.remember(store, "entry-384-a", "content for 384-dim entry A", vec384a, "model-384");
      db.remember(store, "entry-384-b", "content for 384-dim entry B", vec384b, "model-384");

      // Step 2: insert 128-dim entries
      const vec128a = makeVector(128, 3);
      const vec128b = makeVector(128, 4);
      db.remember(store, "entry-128-a", "content for 128-dim entry A", vec128a, "model-128");
      db.remember(store, "entry-128-b", "content for 128-dim entry B", vec128b, "model-128");

      // Step 3: search with 384-dim query
      const query384 = makeVector(384, 1); // same seed as entry-384-a → highest similarity
      const results384 = db.search([store], query384, { limit: 10 });

      // Step 4: verify only 384-dim entries
      if (results384.length === 0) {
        console.log("  FAIL: 384-dim search returned no results");
        return "FAIL";
      }
      for (const r of results384) {
        if (r.label.includes("128")) {
          console.log(`  FAIL: 128-dim entry '${r.label}' appeared in 384-dim search results`);
          return "FAIL";
        }
      }
      if (results384.length > 2) {
        console.log(`  FAIL: expected at most 2 results for 384-dim, got ${results384.length}`);
        return "FAIL";
      }

      // Step 5: verify 128-dim entries are absent (already checked above, but explicit)
      const labels384 = results384.map((r) => r.label);
      if (labels384.includes("entry-128-a") || labels384.includes("entry-128-b")) {
        console.log("  FAIL: 128-dim entries should be absent from 384-dim search");
        return "FAIL";
      }

      // Step 6: search with 128-dim query
      const query128 = makeVector(128, 3); // same seed as entry-128-a
      const results128 = db.search([store], query128, { limit: 10 });

      // Step 7: verify only 128-dim entries
      if (results128.length === 0) {
        console.log("  FAIL: 128-dim search returned no results");
        return "FAIL";
      }
      for (const r of results128) {
        if (r.label.includes("384")) {
          console.log(`  FAIL: 384-dim entry '${r.label}' appeared in 128-dim search results`);
          return "FAIL";
        }
      }

      // Step 8: no errors thrown (if we got here without exceptions, that's verified)
      // Both dimension groups coexist without interfering
      if (results384.length > 0 && results128.length > 0) {
        // Both searches returned results — coexistence verified
      } else {
        console.log("  FAIL: both dimension groups should produce search results");
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
