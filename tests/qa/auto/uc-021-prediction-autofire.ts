import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../src/embeddings";

/**
 * UC-021: Prediction auto-fire.
 *
 * Automatable: the auto-fire scoring pipeline (scorePredictionNudge) is a
 * pure DB+embedding operation. This test seeds a matcher and 0-evidence
 * prediction, then verifies that a matching context triggers the nudge and
 * an unrelated context does not.
 */

const useCase: UseCase = {
  name: "UC-021-prediction-autofire",
  preconditions: [
    "- An opencode session (or Claude Code / Cursor with the MCP server running and sideband socket live)",
    "- A clean DB (no existing matchers or predictions)",
  ].join("\n"),
  steps: [
    '1. Send a prompt expressing a preference, e.g. "I prefer to handle error cases before happy paths. Record this preference."',
    '2. Observe the agent calls `prediction_update` with `signal: "create"`.',
    "3. Start a new session (or send a fresh prompt in the same session).",
    '4. Send a prompt matching the matcher context, e.g. "Write a function to parse a JSON config file."',
    '5. Send an unrelated prompt, e.g. "What\'s the weather like?"',
  ].join("\n"),
  expected: [
    '- Step 2: Agent calls `thatch_prediction_update` with a matcher describing the context ("writing functions", "error handling") and a prediction describing the preference ("handle errors before happy paths"). The tool returns `[created]` and seeds confidence at 0.50 with 0 evidence.',
    '- Step 4: The `chat.message` hook embeds the prompt, finds matchers above the 0.45 threshold, scores linked predictions, and injects a `[thatch] User decision model` nudge. The 0-evidence prediction uses "you may prefer" (not "you tend to"). The agent may follow the prediction, surface it, or ignore it.',
    "- Step 5: No prediction nudge (cosine below threshold). No extra synthetic parts.",
    "- Claude Code / Cursor: The `flush-tools` hook fires predictions alongside the recall nudge via the sideband socket. The `flush-predictions` CLI subcommand provides standalone prediction-only output.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed a matcher and 0-evidence prediction linked by an edge.
      const matcherText = "writing functions that parse JSON config files";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createMatcher(store, matcherText, matcherEmbed, model.name);

      const predText = "handle error cases before happy paths";
      const predEmbed = await model.queryEmbed(predText);
      const predId = db.createPrediction(store, predText, "user prefers errors first", predEmbed, model.name);
      db.createEdge(matcherId, predId, 1.0);

      // Matching context (same text as matcher -> cosine ~1.0, above 0.45).
      const queryEmbed = await model.queryEmbed(matcherText);
      const items = db.scorePredictionNudge([store], queryEmbed, 0.45, 5);
      if (items.length === 0) {
        console.log("  FAIL: scorePredictionNudge returned no items for matching context");
        return "FAIL";
      }

      const item = items[0];
      if (item.statement !== predText) {
        console.log(`  FAIL: wrong prediction statement: ${item.statement}`);
        return "FAIL";
      }
      if (item.evidence_count !== 0) {
        console.log(`  FAIL: new prediction should have 0 evidence, got ${item.evidence_count}`);
        return "FAIL";
      }
      // 0-evidence prediction seeds at P0 (0.5).
      if (Math.abs(item.confidence - 0.5) > 0.01) {
        console.log(`  FAIL: new prediction confidence should be ~0.5, got ${item.confidence}`);
        return "FAIL";
      }
      if (item.matcher_description !== matcherText) {
        console.log(`  FAIL: wrong matcher description: ${item.matcher_description}`);
        return "FAIL";
      }

      // Unrelated context (different text -> cosine ~0, below 0.45).
      const unrelatedEmbed = await model.queryEmbed("what is the weather like today");
      const unrelatedItems = db.scorePredictionNudge([store], unrelatedEmbed, 0.45, 5);
      if (unrelatedItems.length > 0) {
        console.log("  FAIL: unrelated context should not trigger prediction nudge");
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
