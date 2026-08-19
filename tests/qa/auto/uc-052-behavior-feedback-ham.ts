import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-052: Behavior feedback — ham.
 *
 * Automatable: the feedback tool's execute function is a pure DB+embedding
 * operation. This test seeds a behavior, calls behavior_feedback with
 * relevant: true via the tool execute function, and verifies confidence
 * rises and confirm_count increases.
 */

const useCase: UseCase = {
  name: "UC-052-behavior-feedback-ham",
  preconditions: [
    "- An existing behavior in the model (created via behavior_codify or seeded directly)",
  ].join("\n"),
  steps: [
    "1. Seed a behavior at P0 (0.50, 0 evidence).",
    '2. Call `behavior_feedback(behavior="<existing behavior>", relevant=true, context="<situation where the rule applied>")`.',
    "3. Call `behavior_list` to inspect updated confidence and counts.",
  ].join("\n"),
  expected: [
    '- Step 2: Returns `[confirm] "<statement>" confidence=0.58 (1/0)`. `confirm_count` increases by 1. Confidence rises from 0.50 to 0.583. A provenance entry with signal "confirm" and detail `ham: <context>` is recorded.',
    "- Step 3: `behavior_list` shows the behavior with confidence=0.58, evidence count=1, and provenance entries for both the codify and confirm signals (newest-first).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Step 1: seed a behavior via behavior_codify.
      const behaviorText = "check the whole codebase for an existing import of that library first";
      await findTool("behavior_codify").execute({
        situation: "importing a new library into a project",
        behavior: behaviorText,
        rationale: "avoiding duplicate imports",
      }, coreCtx);

      // Verify it starts at P0.
      let behaviors = db.listBehaviors(store);
      if (behaviors.length !== 1 || Math.abs(behaviors[0].confidence - 0.5) > 0.01) {
        console.log(`  FAIL: initial behavior should have confidence ~0.5, got ${behaviors[0]?.confidence}`);
        return "FAIL";
      }

      // Step 2: ham (relevant: true) feedback.
      const result = await findTool("behavior_feedback").execute({
        behavior: behaviorText,
        relevant: true,
        context: "adding lodash to the project",
      }, coreCtx);

      if (!result.includes("[confirm]")) {
        console.log(`  FAIL: expected [confirm], got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("0.58")) {
        console.log(`  FAIL: expected confidence=0.58, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("(1/0)")) {
        console.log(`  FAIL: expected (1/0) counts, got: ${result}`);
        return "FAIL";
      }

      // Step 3: behavior_list shows updated confidence and evidence.
      const list = await findTool("behavior_list").execute({}, coreCtx);
      if (!list.includes("0.58")) {
        console.log(`  FAIL: behavior_list should show confidence 0.58, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("1 tests")) {
        console.log(`  FAIL: behavior_list should show 1 test, got: ${list}`);
        return "FAIL";
      }
      // Provenance should have both codify and confirm entries.
      if (!list.includes("codify:")) {
        console.log(`  FAIL: behavior_list should show codify provenance, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("confirm:")) {
        console.log(`  FAIL: behavior_list should show confirm provenance, got: ${list}`);
        return "FAIL";
      }

      // Verify via DB directly.
      behaviors = db.listBehaviors(store);
      const expectedConf = (1 + 5 * 0.5) / (1 + 0 + 5);
      if (Math.abs(behaviors[0].confidence - expectedConf) > 0.01) {
        console.log(`  FAIL: confidence should be ~${expectedConf.toFixed(3)}, got ${behaviors[0].confidence}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
