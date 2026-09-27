import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-109: Behavior feedback and delete via the SITUATION line.
 *
 * Automatable: pure DB+embedding operations. The behavior nudge renders
 * "When <matcher description>: do <statement>" - and models copy back the
 * situation half (observed live three times: statement search failed with
 * verbatim nudge text). The tools now resolve the situation half through
 * the matcher's edge to the linked behavior; this pins that both
 * behavior_feedback and behavior_delete accept it.
 */

const useCase: UseCase = {
  name: "UC-109-behavior-feedback-via-situation",
  preconditions: [
    "- An isolated THATCH_DB_PATH (tempdir); no real stores are touched.",
  ].join("\n"),
  steps: [
    "1. Codify a behavior with a known situation and statement.",
    '2. Call behavior_feedback passing the SITUATION text (not the statement) with relevant: true.',
    "3. Verify the confirm landed on the linked behavior (statement echoed, confidence 0.58, 1/0).",
    "4. Codify a second behavior sharing the situation; call behavior_feedback with the situation again and expect an ambiguity listing both statements.",
    "5. Call behavior_delete with the exact statement (the situation is now ambiguous) and verify deletion reports the right store.",
  ].join("\n"),
  expected: [
    "- Step 2: `[confirm]` with the behavior STATEMENT (not the situation text), confidence=0.58, (1/0).",
    "- Step 4: an ambiguity message naming both exact statements.",
    "- Step 5: `[deleted]` with the statement and the store it lived in.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
    const situation = "the agent hits a snag during investigation";
    const statement = "before moving on, save a memory about the dead end";

    try {
      // Step 1: codify.
      await findTool("behavior_codify").execute(
        { situation, behavior: statement, rationale: "class lessons should resurface" },
        coreCtx,
      );

      // Step 2: feedback via the SITUATION half - the live failure mode.
      const result = await findTool("behavior_feedback").execute(
        { behavior: situation, relevant: true, context: "situation-line feedback" },
        coreCtx,
      );
      if (!result.includes("[confirm]")) {
        console.log(`  FAIL: situation-line feedback did not resolve: ${result}`);
        return "FAIL";
      }
      if (!result.includes(statement) || !result.includes("0.58") || !result.includes("(1/0)")) {
        console.log(`  FAIL: confirm landed on the wrong behavior or counts: ${result}`);
        return "FAIL";
      }

      // Step 4: a second behavior sharing the situation makes it ambiguous.
      await findTool("behavior_codify").execute(
        { situation, behavior: "write the memory with the widest matcher surface", rationale: "sibling rule" },
        coreCtx,
      );
      const ambiguous = await findTool("behavior_feedback").execute(
        { behavior: situation, relevant: true, context: "ambiguity check" },
        coreCtx,
      );
      if (!ambiguous.includes("multiple behaviors") || !ambiguous.includes(statement)) {
        console.log(`  FAIL: ambiguity not reported: ${ambiguous}`);
        return "FAIL";
      }

      // Step 5: delete - the situation is ambiguous (two behaviors share
      // it), so the statement disambiguates; deletion reports the store.
      const deleted = await findTool("behavior_delete").execute({ statement }, coreCtx);
      if (!deleted.includes("[deleted]") || !deleted.includes("test-store")) {
        console.log(`  FAIL: delete via situation failed: ${deleted}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
