import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-051: Behavior codify.
 *
 * Automatable: the codify tool's execute function is a pure DB+embedding
 * operation. This test calls behavior_codify via the tool execute function
 * and verifies the created behavior via behavior_list.
 */

const useCase: UseCase = {
  name: "UC-051-behavior-codify",
  preconditions: [
    "- A clean DB (no existing behavior matchers or behaviors matching the new ones)",
  ].join("\n"),
  steps: [
    '1. Call `behavior_codify(situation="importing a new library into a project", behavior="check the whole codebase for an existing import of that library first", rationale="avoiding duplicate imports")`.',
    "2. Call `behavior_list` to inspect the created behavior.",
  ].join("\n"),
  expected: [
    '- Step 1: Returns `[codified] <store> :: "<behavior>" for "<situation>"`. A new behavior matcher row and behavior row are created. An edge links them with weight 1.0. A provenance entry with signal "codify" is recorded.',
    "- Step 2: `behavior_list` shows one behavior with confidence=0.50, evidence count=0, one matcher, and one provenance entry (codify).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Step 1: behavior_codify.
      const result = await findTool("behavior_codify").execute({
        situation: "importing a new library into a project",
        behavior: "check the whole codebase for an existing import of that library first",
        rationale: "avoiding duplicate imports",
      }, coreCtx);

      if (!result.includes("[codified]")) {
        console.log(`  FAIL: expected [codified], got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("check the whole codebase")) {
        console.log(`  FAIL: result should contain behavior text, got: ${result}`);
        return "FAIL";
      }
      if (!result.includes("importing a new library")) {
        console.log(`  FAIL: result should contain situation text, got: ${result}`);
        return "FAIL";
      }

      // Step 2: behavior_list shows the created behavior.
      const list = await findTool("behavior_list").execute({}, coreCtx);
      if (!list.includes("check the whole codebase")) {
        console.log(`  FAIL: behavior_list should contain the behavior, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("0.50")) {
        console.log(`  FAIL: behavior_list should show confidence 0.50, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("0 tests")) {
        console.log(`  FAIL: behavior_list should show 0 tests, got: ${list}`);
        return "FAIL";
      }
      if (!list.includes("codify:")) {
        console.log(`  FAIL: behavior_list should show codify provenance, got: ${list}`);
        return "FAIL";
      }

      // Verify only one behavior was created.
      const behaviors = db.listBehaviors(store);
      if (behaviors.length !== 1) {
        console.log(`  FAIL: expected 1 behavior, got ${behaviors.length}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
