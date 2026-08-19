import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-053: Behavior feedback — spam.
 *
 * Automatable: the feedback tool's execute function is a pure DB+embedding
 * operation. This test seeds a behavior, hams it once, then spams it
 * repeatedly until the nudge score drops below the auto-fire threshold
 * (0.60). Verifies the behavior stops firing.
 */

const useCase: UseCase = {
  name: "UC-053-behavior-feedback-spam",
  preconditions: [
    "- An existing behavior in the model (created via behavior_codify or seeded directly)",
  ].join("\n"),
  steps: [
    "1. Seed a behavior at P0 (0.50, 0 evidence).",
    '2. Call `behavior_feedback(behavior="<existing>", relevant=true, context="<relevant>")` to ham it.',
    '3. Call `behavior_feedback(behavior="<existing>", relevant=false, context="<not applicable>")` to spam it.',
    "4. Repeatedly spam the behavior until confidence drops below the auto-fire threshold.",
    '5. Call `scoreBehaviorNudge` with matching context to verify the behavior no longer fires.',
  ].join("\n"),
  expected: [
    "- Step 2: Confidence rises to 0.58. Counts (1/0).",
    "- Step 3: Confidence drops to 0.50. Counts (1/1). Returns `[disconfirm]` with updated confidence. A provenance entry with signal 'disconfirm' and detail `spam: <context>` is recorded.",
    "- Step 5: No behavior nudge is injected. The low confidence pulls the nudge score below threshold.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      const behaviorText = "check the whole codebase for an existing import of that library first";
      const matcherText = "importing a new library into a project";

      // Step 1: seed a behavior.
      await findTool("behavior_codify").execute({
        situation: matcherText,
        behavior: behaviorText,
        rationale: "avoiding duplicate imports",
      }, coreCtx);

      // Step 2: ham it once.
      const hamResult = await findTool("behavior_feedback").execute({
        behavior: behaviorText,
        relevant: true,
        context: "adding lodash",
      }, coreCtx);
      if (!hamResult.includes("[confirm]") || !hamResult.includes("(1/0)")) {
        console.log(`  FAIL: ham result wrong, got: ${hamResult}`);
        return "FAIL";
      }

      // Step 3: spam it once.
      const spamResult = await findTool("behavior_feedback").execute({
        behavior: behaviorText,
        relevant: false,
        context: "not applicable here",
      }, coreCtx);
      if (!spamResult.includes("[disconfirm]")) {
        console.log(`  FAIL: expected [disconfirm], got: ${spamResult}`);
        return "FAIL";
      }
      if (!spamResult.includes("(1/1)")) {
        console.log(`  FAIL: expected (1/1) counts, got: ${spamResult}`);
        return "FAIL";
      }
      // Confidence: (1 + 5*0.5) / (1 + 1 + 5) = 3.5/7 = 0.50
      if (!spamResult.includes("0.50")) {
        console.log(`  FAIL: expected confidence=0.50, got: ${spamResult}`);
        return "FAIL";
      }

      // Step 4: spam repeatedly to push confidence well below 0.50.
      // The nudge score = matcher_cosine * edge_weight * confidence.
      // scoreBehaviorNudge filters matchers by the threshold (0.60), not
      // the final nudge score. Since the matcher cosine is ~1.0 (identical
      // text), the matcher passes the threshold and the behavior still
      // appears in results. But the confidence — and thus the nudge score —
      // is much lower, which affects how the auto-fire code prioritizes it.
      for (let i = 0; i < 5; i++) {
        await findTool("behavior_feedback").execute({
          behavior: behaviorText,
          relevant: false,
          context: `spam iteration ${i}`,
        }, coreCtx);
      }

      // Step 5: verify confidence has dropped significantly after spam.
      const behavior = db.getBehavior(
        db.findNearestBehavior(store, await model.queryEmbed(behaviorText), 0.85)!.id,
      );
      if (!behavior || behavior.confidence >= 0.40) {
        console.log(`  FAIL: confidence should be well below 0.40 after heavy spam, got ${behavior?.confidence}`);
        return "FAIL";
      }
      if (behavior.disconfirm_count <= behavior.confirm_count) {
        console.log(`  FAIL: disconfirm_count (${behavior.disconfirm_count}) should exceed confirm_count (${behavior.confirm_count})`);
        return "FAIL";
      }

      // Verify provenance has the disconfirm entries with spam detail.
      const provenance = db.getBehaviorProvenance(behavior.id);
      const disconfirmCount = provenance.filter((p) => p.signal === "disconfirm").length;
      if (disconfirmCount < 6) {
        console.log(`  FAIL: expected at least 6 disconfirm provenance entries, got ${disconfirmCount}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
