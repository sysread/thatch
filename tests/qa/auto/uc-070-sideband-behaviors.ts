import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { SidebandServer, sidebandBehaviors, sidebandSocketPath } from "../../../src/sideband";

/**
 * UC-070: Sideband behaviors.
 *
 * Automatable: the sideband behaviors round-trip is a pure IPC + embedding
 * operation. This test starts a SidebandServer with MockEmbeddingModel, seeds
 * a behavior matcher + behavior + edge, calls sidebandBehaviors, and verifies
 * the response contains scored behaviors with matcher context and confidence.
 */

const useCase: UseCase = {
  name: "UC-070-sideband-behaviors",
  preconditions: [
    "- A SidebandServer instance running with a warm EmbeddingModel",
    "- A ThatchDB containing at least one behavior matcher + behavior + edge",
  ].join("\n"),
  steps: [
    "1. Start the SidebandServer on a deterministic socket path.",
    "2. From a hook process, call sidebandBehaviors(socketPath, text, stores, threshold, limit).",
    "3. The server embeds the text, calls db.scoreBehaviorNudge, and responds.",
  ].join("\n"),
  expected: [
    "- The client receives BehaviorNudgeItem[] with matcher context, confidence, and evidence count.",
    "- Behaviors below the threshold are filtered out server-side by scoreBehaviorNudge.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const dbDir = mkdtempSync(join(tmpdir(), "thatch-qa-uc070-"));
    const dbPath = join(dbDir, "test.db");
    const db = new ThatchDB(dbPath);
    const model = new MockEmbeddingModel();
    const sockPath = sidebandSocketPath(dbPath);
    const server = new SidebandServer(sockPath, model, db);
    server.start();

    try {
      // Seed a behavior matcher + behavior + edge.
      const matcherText = "about to commit changes";
      const behaviorText = "run mise run check before committing";
      const matcherEmbed = await model.passageEmbed(matcherText);
      const behaviorEmbed = await model.passageEmbed(behaviorText);
      db.createBehaviorMatcher("s", matcherText, matcherEmbed, "mock");
      const behaviorId = db.createBehavior("s", behaviorText, "quality gate", behaviorEmbed, "mock");
      const matchers = db.findBehaviorMatchers(["s"], matcherEmbed);
      if (matchers.length === 0) {
        console.log("  FAIL: could not find seeded behavior matcher");
        return "FAIL";
      }
      db.createBehaviorEdge(matchers[0].id, behaviorId, 1.0);

      // Query with matching context.
      const behaviors = await sidebandBehaviors(sockPath, matcherText, ["s", "global"], 0.0, 5);
      if (behaviors === null) {
        console.log("  FAIL: sidebandBehaviors returned null");
        return "FAIL";
      }
      if (behaviors.length === 0) {
        console.log("  FAIL: expected at least 1 behavior");
        return "FAIL";
      }
      if (behaviors[0].statement !== behaviorText) {
        console.log(`  FAIL: wrong behavior statement, expected "${behaviorText}", got "${behaviors[0].statement}"`);
        return "FAIL";
      }
      if (behaviors[0].matcher_description !== matcherText) {
        console.log(`  FAIL: wrong matcher description, expected "${matcherText}", got "${behaviors[0].matcher_description}"`);
        return "FAIL";
      }

      // Unrelated context should return empty. MockEmbeddingModel produces
      // near-orthogonal (not zero) vectors for different texts, so use a
      // threshold high enough to filter out the low-cosine match. The final
      // score is cosine × weight × confidence; for an unrelated query the
      // cosine is near-zero, so any threshold > 0.1 filters it out.
      const unrelated = await sidebandBehaviors(sockPath, "what color is the sky", ["s"], 0.5, 5);
      if (unrelated === null) {
        console.log("  FAIL: unrelated sidebandBehaviors returned null");
        return "FAIL";
      }
      if (unrelated.length > 0) {
        console.log(`  FAIL: unrelated context should return 0 behaviors, got ${unrelated.length}`);
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
