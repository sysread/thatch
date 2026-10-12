import { registerUseCase, type UseCase } from "../runner";
import { predictionNudge, behaviorNudge, opencodeToolName, mcpToolName } from "../../../src/prompts";

/**
 * UC-121: Prediction and behavior nudges carry a snapshot footer naming the
 * live re-check tool with the host's spelling.
 *
 * Automatable: both footers are rendered at nudge-formatting time (the
 * shared snapshotFooter helper in src/prompts.ts) with no LLM in the loop.
 * The footer exists because the block is computed once at submission and
 * never refreshed mid-turn (the Oct 2026 staleness report) - the consumer
 * must re-check the live store instead of trusting the labels. The same
 * renderers serve the opencode plugin path and the MCP flush-tools path,
 * so the footer's tool name must follow the caller's ToolNamer.
 */

const useCase: UseCase = {
  name: "UC-121-nudge-snapshot-footer",
  preconditions: [
    "- No live host needed: the footer is a pure formatting function",
  ].join("\n"),
  steps: [
    '1. Render `predictionNudge(items)` with one item (opencode default spelling).',
    '2. Render `behaviorNudge(items)` with one item (opencode default spelling).',
    '3. Render both with `mcpToolName` (the MCP flush-tools path spelling).',
  ].join("\n"),
  expected: [
    "- Steps 1 and 2: Each block ends with a snapshot footer stating the labels reflect the store as of the message's submission, that later updates (including during this turn) do not refresh it, and pointing at the live re-check tool.",
    "- Step 1: The footer names `thatch_prediction_query` (opencode spelling).",
    "- Step 2: The footer names `thatch_behavior_list` (opencode spelling).",
    "- Step 3: The footers name `mcp__thatch__prediction_query` and `mcp__thatch__behavior_list`.",
  ].join("\n"),

  async run() {
    const predItems = [
      {
        matcher_description: "when deciding something",
        statement: "a preference statement",
        confidence: 0.72,
        evidence_count: 4,
      },
    ];
    const behaviorItems = [
      {
        matcher_description: "when doing something",
        statement: "a discipline rule",
        confidence: 0.58,
        evidence_count: 1,
      },
    ];

    // Step 1: prediction nudge footer, opencode spelling.
    const predBlock = predictionNudge(predItems as any);
    if (!predBlock.includes("[thatch] User decision model")) {
      console.log(`  FAIL: prediction block missing header: ${predBlock}`);
      return "FAIL";
    }
    if (!predBlock.includes("Snapshot: these labels reflect the prediction store as of this message's submission")) {
      console.log(`  FAIL: prediction footer missing snapshot basis: ${predBlock}`);
      return "FAIL";
    }
    if (!predBlock.includes("do not refresh it; re-check with thatch_prediction_query before relying on them.")) {
      console.log(`  FAIL: prediction footer missing opencode re-check tool: ${predBlock}`);
      return "FAIL";
    }

    // Step 2: behavior nudge footer, opencode spelling.
    const behaviorBlock = behaviorNudge(behaviorItems as any);
    if (!behaviorBlock.includes("[thatch] Situational behaviors")) {
      console.log(`  FAIL: behavior block missing header: ${behaviorBlock}`);
      return "FAIL";
    }
    if (!behaviorBlock.includes("Snapshot: these labels reflect the behavior store as of this message's submission")) {
      console.log(`  FAIL: behavior footer missing snapshot basis: ${behaviorBlock}`);
      return "FAIL";
    }
    if (!behaviorBlock.includes("do not refresh it; re-check with thatch_behavior_list before relying on them.")) {
      console.log(`  FAIL: behavior footer missing opencode re-check tool: ${behaviorBlock}`);
      return "FAIL";
    }

    // Step 3: both footers follow the MCP spelling on the MCP path.
    const predMcp = predictionNudge(predItems as any, mcpToolName);
    const behaviorMcp = behaviorNudge(behaviorItems as any, mcpToolName);
    if (!predMcp.includes("re-check with mcp__thatch__prediction_query before relying on them.")) {
      console.log(`  FAIL: prediction footer missing MCP spelling: ${predMcp}`);
      return "FAIL";
    }
    if (!behaviorMcp.includes("re-check with mcp__thatch__behavior_list before relying on them.")) {
      console.log(`  FAIL: behavior footer missing MCP spelling: ${behaviorMcp}`);
      return "FAIL";
    }
    if (predMcp.includes("with thatch_") || behaviorMcp.includes("with thatch_")) {
      console.log(`  FAIL: MCP footer leaked the bare opencode spelling: ${predMcp} ${behaviorMcp}`);
      return "FAIL";
    }

    // The default spellings are the opencode ones (the opencode plugin path
    // calls without a ToolNamer).
    if (!predictionNudge(predItems as any, opencodeToolName).includes("thatch_prediction_query")) {
      console.log("  FAIL: opencodeToolName should resolve to the thatch_ spelling");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
