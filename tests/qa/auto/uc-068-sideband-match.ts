import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { SidebandServer, sidebandMatch, sidebandSocketPath } from "../../../src/sideband";

/**
 * UC-068: Sideband match.
 *
 * Automatable: the sideband match round-trip is a pure IPC + embedding
 * operation. This test starts a SidebandServer with MockEmbeddingModel,
 * stores a memory, calls sidebandMatch, and verifies the response contains
 * labels, scores, and store names.
 */

const useCase: UseCase = {
  name: "UC-068-sideband-match",
  preconditions: [
    "- A SidebandServer instance running on a Unix domain socket with a warm EmbeddingModel",
    "- A ThatchDB containing at least one memory",
  ].join("\n"),
  steps: [
    "1. Start the SidebandServer on a deterministic socket path.",
    "2. From a hook process, call sidebandMatch(socketPath, text, stores, threshold, limit).",
    "3. The server embeds the text, calls searchWithTotal (threshold filters before the limit slice), and returns matches plus totalAbove.",
    "4. The server responds with matches.",
  ].join("\n"),
  expected: [
    "- The client receives a { matches, totalAbove } result: SidebandMatch entries with labels, cosine scores (rounded to 3 decimal places), and store names, plus totalAbove counting everything above threshold before the limit slice.",
    "- Matches below the threshold are filtered out server-side.",
    "- The limit controls the maximum number of results returned.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const dbDir = mkdtempSync(join(tmpdir(), "thatch-qa-uc068-"));
    const dbPath = join(dbDir, "test.db");
    const db = new ThatchDB(dbPath);
    const model = new MockEmbeddingModel();
    const sockPath = sidebandSocketPath(dbPath);
    const server = new SidebandServer(sockPath, model, db);
    server.start();

    try {
      // Store two memories.
      db.remember("s", "architecture", "content about architecture", await model.passageEmbed("architecture"), "mock");
      db.remember("s", "cooking", "content about cooking", await model.passageEmbed("cooking"), "mock");

      // Match: same text as a stored memory → high cosine.
      const res = await sidebandMatch(sockPath, "architecture", ["s", "global"], 0.0, 5);
      if (res === null) {
        console.log("  FAIL: sidebandMatch returned null");
        return "FAIL";
      }
      const matches = res.matches;
      if (matches.length === 0) {
        console.log("  FAIL: expected at least 1 match");
        return "FAIL";
      }
      if (matches[0].label !== "architecture") {
        console.log(`  FAIL: wrong label, expected "architecture", got "${matches[0].label}"`);
        return "FAIL";
      }
      if (matches[0].score <= 0) {
        console.log(`  FAIL: score should be positive, got ${matches[0].score}`);
        return "FAIL";
      }
      if (!matches[0].store) {
        console.log("  FAIL: match should have a store name");
        return "FAIL";
      }
      if (res.totalAbove < matches.length) {
        console.log(`  FAIL: totalAbove (${res.totalAbove}) must be >= shown (${matches.length})`);
        return "FAIL";
      }

      // Threshold filtering: 0.99 threshold → only exact-match text scores ~1.0.
      const filtered = await sidebandMatch(sockPath, "architecture", ["s"], 0.99, 5);
      if (filtered === null) {
        console.log("  FAIL: filtered sidebandMatch returned null");
        return "FAIL";
      }
      if (filtered.matches.length !== 1 || filtered.matches[0].label !== "architecture") {
        console.log(`  FAIL: threshold filter should leave only "architecture", got ${filtered.matches.length} matches`);
        return "FAIL";
      }

      // Limit: store 10 entries, limit to 3.
      for (let i = 0; i < 10; i++) {
        db.remember("s", `entry-${i}`, `content-${i}`, await model.passageEmbed(`entry-${i}`), "mock");
      }
      const limited = await sidebandMatch(sockPath, "entry-0", ["s"], 0.0, 3);
      if (limited === null) {
        console.log("  FAIL: limited sidebandMatch returned null");
        return "FAIL";
      }
      if (limited.matches.length > 3) {
        console.log(`  FAIL: limit should cap at 3, got ${limited.matches.length}`);
        return "FAIL";
      }

      // Cross-store search.
      db.remember("global", "global-mem", "content", await model.passageEmbed("global-mem"), "mock");
      const crossStore = await sidebandMatch(sockPath, "global-mem", ["s", "global"], 0.99, 5);
      if (crossStore === null) {
        console.log("  FAIL: cross-store sidebandMatch returned null");
        return "FAIL";
      }
      if (!crossStore.matches.some((m) => m.label === "global-mem" && m.store === "global")) {
        console.log("  FAIL: cross-store search should find global-mem in global store");
        return "FAIL";
      }

      return "PASS";
    } finally {
      server.stop();
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
