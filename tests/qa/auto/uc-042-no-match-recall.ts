import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-042: No-match recall.
 *
 * Automatable: the recall threshold check is a pure DB+embedding operation.
 * This test stores a memory about database connections, then searches with
 * an unrelated prompt (below threshold) and a related prompt (above
 * threshold) using MockEmbeddingModel's deterministic hash-based vectors.
 */

const useCase: UseCase = {
  name: "UC-042-no-match-recall",
  preconditions: [
    "- Thatch active in a session (opencode or MCP host)",
    "- A store with memories that are semantically unrelated to the test prompt",
  ].join("\n"),
  steps: [
    '1. Send a prompt that is semantically unrelated to all stored memories (e.g. "what color is the sky?").',
    "2. Verify the agent's context does not contain a recall nudge.",
    "3. Send a prompt that IS related to a stored memory.",
    "4. Verify the recall nudge fires for the matching prompt.",
  ].join("\n"),
  expected: [
    "- Step 1–2: the prompt passes the MIN_PROMPT_LEN gate. The embedding is computed. db.search returns results, but all _score values are below RECALL_THRESHOLD (0.55). No recall nudge fires.",
    "- Step 3–4: the matching prompt produces at least one result with _score >= 0.55. The recall nudge fires with labels and scores.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const RECALL_THRESHOLD = 0.55;

    try {
      // Store a memory about database connections.
      const label = "db-connection-details";
      const content = "database connection string and pool configuration";
      const embed = await model.passageEmbed(label);
      db.remember(store, label, content, embed, model.name);

      // Step 1: search with an unrelated prompt.
      // MockEmbeddingModel produces near-orthogonal vectors for different texts,
      // so "what color is the sky" will score near 0 against "db-connection-details".
      const unrelatedQuery = "what color is the sky";
      const unrelatedEmbed = await model.queryEmbed(unrelatedQuery);
      const unrelatedResults = db.search([store, "global"], unrelatedEmbed, { limit: 5 });
      const unrelatedMatches = unrelatedResults.filter((r) => r._score >= RECALL_THRESHOLD);

      if (unrelatedMatches.length > 0) {
        console.log(`  FAIL: unrelated prompt should not match above threshold, got ${unrelatedMatches.length} matches`);
        return "FAIL";
      }

      // Verify the result exists but is below threshold (cosine is computed but low).
      if (unrelatedResults.length > 0 && unrelatedResults[0]._score >= RECALL_THRESHOLD) {
        console.log(`  FAIL: unrelated result score ${unrelatedResults[0]._score} should be below ${RECALL_THRESHOLD}`);
        return "FAIL";
      }

      // Step 3: search with a related prompt.
      // Use the same text as the stored memory's label to guarantee a high score
      // (MockEmbeddingModel is deterministic — same text produces same vector).
      const relatedQuery = label;
      const relatedEmbed = await model.queryEmbed(relatedQuery);
      const relatedResults = db.search([store, "global"], relatedEmbed, { limit: 5 });
      const relatedMatches = relatedResults.filter((r) => r._score >= RECALL_THRESHOLD);

      if (relatedMatches.length === 0) {
        console.log("  FAIL: related prompt should match above threshold");
        return "FAIL";
      }

      if (relatedMatches[0].label !== label) {
        console.log(`  FAIL: wrong label matched, expected "${label}", got "${relatedMatches[0].label}"`);
        return "FAIL";
      }

      if (relatedMatches[0]._score < RECALL_THRESHOLD) {
        console.log(`  FAIL: match score ${relatedMatches[0]._score} should be >= ${RECALL_THRESHOLD}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
