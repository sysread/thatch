import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { SidebandServer, sidebandPredictions, sidebandSocketPath } from "../../../src/sideband";

/**
 * UC-069: Sideband predictions.
 *
 * Automatable: the sideband predictions round-trip is a pure IPC + embedding
 * operation. This test starts a SidebandServer with MockEmbeddingModel, seeds
 * a matcher + prediction + edge, calls sidebandPredictions, and verifies the
 * response contains scored predictions with matcher context and confidence.
 */

const useCase: UseCase = {
  name: "UC-069-sideband-predictions",
  preconditions: [
    "- A SidebandServer instance running with a warm EmbeddingModel",
    "- A ThatchDB containing at least one prediction matcher + prediction + edge",
  ].join("\n"),
  steps: [
    "1. Start the SidebandServer on a deterministic socket path.",
    "2. From a hook process, call sidebandPredictions(socketPath, text, stores, threshold, limit).",
    "3. The server embeds the text, calls db.scorePredictionNudge, and responds.",
  ].join("\n"),
  expected: [
    "- The client receives PredictionNudgeItem[] with matcher context, confidence, and evidence count.",
    "- Predictions below the threshold are filtered out server-side by scorePredictionNudge.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const dbDir = mkdtempSync(join(tmpdir(), "thatch-qa-uc069-"));
    const dbPath = join(dbDir, "test.db");
    const db = new ThatchDB(dbPath);
    const model = new MockEmbeddingModel();
    const sockPath = sidebandSocketPath(dbPath);
    const server = new SidebandServer(sockPath, model, db);
    server.start();

    try {
      // Seed a matcher + prediction + edge.
      const matcherText = "deciding on test coverage";
      const predText = "aim for 90 percent coverage";
      const matcherEmbed = await model.passageEmbed(matcherText);
      const predEmbed = await model.passageEmbed(predText);
      db.createMatcher("s", matcherText, matcherEmbed, "mock");
      const predId = db.createPrediction("s", predText, "user stated", predEmbed, "mock");
      const matchers = db.findMatchers(["s"], matcherEmbed);
      if (matchers.length === 0) {
        console.log("  FAIL: could not find seeded matcher");
        return "FAIL";
      }
      db.createEdge(matchers[0].id, predId, 1.0);

      // Query with matching context.
      const predictions = await sidebandPredictions(sockPath, matcherText, ["s", "global"], 0.0, 5);
      if (predictions === null) {
        console.log("  FAIL: sidebandPredictions returned null");
        return "FAIL";
      }
      if (predictions.length === 0) {
        console.log("  FAIL: expected at least 1 prediction");
        return "FAIL";
      }
      if (predictions[0].statement !== predText) {
        console.log(`  FAIL: wrong prediction statement, expected "${predText}", got "${predictions[0].statement}"`);
        return "FAIL";
      }
      if (predictions[0].matcher_description !== matcherText) {
        console.log(`  FAIL: wrong matcher description, expected "${matcherText}", got "${predictions[0].matcher_description}"`);
        return "FAIL";
      }
      // New prediction seeds at P0 (0.5) with 0 evidence.
      if (Math.abs(predictions[0].confidence - 0.5) > 0.01) {
        console.log(`  FAIL: confidence should be ~0.5, got ${predictions[0].confidence}`);
        return "FAIL";
      }

      // Unrelated context should return empty.
      const unrelated = await sidebandPredictions(sockPath, "what color is the sky", ["s"], 0.0, 5);
      if (unrelated === null) {
        console.log("  FAIL: unrelated sidebandPredictions returned null");
        return "FAIL";
      }
      if (unrelated.length > 0) {
        console.log(`  FAIL: unrelated context should return 0 predictions, got ${unrelated.length}`);
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
