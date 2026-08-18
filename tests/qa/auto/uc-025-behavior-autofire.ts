import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../src/embeddings";

/**
 * UC-025: Behavior auto-fire.
 *
 * Automatable: the auto-fire scoring pipeline (scoreBehaviorNudge) is a
 * pure DB+embedding operation. This test seeds a behavior matcher and
 * 0-evidence behavior, then verifies that a matching context triggers
 * the nudge and an unrelated context does not.
 */

const useCase: UseCase = {
  name: "UC-025-behavior-autofire",
  preconditions: [
    "- An opencode session (or Claude Code / Cursor with the MCP server running and sideband socket live)",
    "- A clean DB (no existing behavior matchers or behaviors)",
  ].join("\n"),
  steps: [
    '1. Send a prompt that triggers the agent to codify a behavior, e.g. "I notice you keep forgetting to check for existing imports before adding new ones. Codify a rule for that."',
    '2. Observe the agent calls `behavior_codify` with a situation and behavior description.',
    "3. Start a new session (or send a fresh prompt in the same session).",
    '4. Send a prompt matching the behavior matcher context, e.g. "Add a new import for lodash to this file."',
    '5. Send an unrelated prompt, e.g. "What\'s the weather like?"',
  ].join("\n"),
  expected: [
    '- Step 2: Agent calls `thatch_behavior_codify` with a situation describing the context ("importing a new library") and a behavior describing the rule ("check the whole codebase for an existing import first"). The tool returns `[codified]` and seeds confidence at 0.50 with 0 evidence.',
    '- Step 4: The `chat.message` hook embeds the prompt, finds behavior matchers above the 0.45 threshold, scores linked behaviors, and injects a `[thatch] Situational behaviors` nudge. The 0-evidence behavior uses "consider" (not "do"). The agent evaluates the rule for relevance and calls `behavior_feedback`.',
    "- Step 5: No behavior nudge (cosine below threshold). No extra synthetic parts.",
    "- Claude Code / Cursor: The `flush-tools` hook fires behaviors alongside recall and predictions via the sideband socket's `behaviors` method.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Seed a matcher and 0-evidence behavior linked by an edge.
      const matcherText = "importing a new library into a project";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createBehaviorMatcher(store, matcherText, matcherEmbed, model.name);

      const behaviorText = "check the whole codebase for an existing import of that library first";
      const behaviorEmbed = await model.queryEmbed(behaviorText);
      const behaviorId = db.createBehavior(store, behaviorText, "avoiding duplicate imports", behaviorEmbed, model.name);
      db.createBehaviorEdge(matcherId, behaviorId, 1.0);

      // Matching context (same text as matcher -> cosine ~1.0, above 0.45).
      const queryEmbed = await model.queryEmbed(matcherText);
      const items = db.scoreBehaviorNudge([store], queryEmbed, 0.45, 5);
      if (items.length === 0) {
        console.log("  FAIL: scoreBehaviorNudge returned no items for matching context");
        return "FAIL";
      }

      const item = items[0];
      if (item.statement !== behaviorText) {
        console.log(`  FAIL: wrong behavior statement: ${item.statement}`);
        return "FAIL";
      }
      if (item.evidence_count !== 0) {
        console.log(`  FAIL: new behavior should have 0 evidence, got ${item.evidence_count}`);
        return "FAIL";
      }
      // 0-evidence behavior seeds at P0 (0.5).
      if (Math.abs(item.confidence - 0.5) > 0.01) {
        console.log(`  FAIL: new behavior confidence should be ~0.5, got ${item.confidence}`);
        return "FAIL";
      }
      if (item.matcher_description !== matcherText) {
        console.log(`  FAIL: wrong matcher description: ${item.matcher_description}`);
        return "FAIL";
      }

      // Unrelated context (different text -> cosine ~0, below 0.45).
      const unrelatedEmbed = await model.queryEmbed("what is the weather like today");
      const unrelatedItems = db.scoreBehaviorNudge([store], unrelatedEmbed, 0.45, 5);
      if (unrelatedItems.length > 0) {
        console.log("  FAIL: unrelated context should not trigger behavior nudge");
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
