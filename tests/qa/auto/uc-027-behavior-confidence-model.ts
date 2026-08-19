import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-027: Behavior confidence and ham/spam signal model.
 *
 * Automatable: the Bayesian confidence math and signal mapping are pure DB
 * operations. This test seeds a behavior, applies confirm (ham) / soft /
 * disconfirm (spam) signals in sequence, and verifies the confidence and
 * evidence counts at each step against the formula:
 *   confidence = (confirm_count + K*P0) / (confirm_count + disconfirm_count + K)
 * with K=5, P0=0.5, W_SOFT=0.25. Same formula as the prediction engine.
 */

const useCase: UseCase = {
  name: "UC-027-behavior-confidence-model",
  preconditions: [
    "- An opencode or Claude Code / Cursor session with the behavior model seeded",
  ].join("\n"),
  steps: [
    '1. `behavior_codify(situation="X", behavior="Y", rationale="Z")` -- seeds at p0 (0.50, 0 evidence).',
    '2. `behavior_feedback(behavior="Y", relevant=true, context="X")` -- ham (confirm).',
    '3. `behavior_feedback(behavior="Y", relevant=false, context="partial match")` with a soft signal -- spam (partial).',
    '4. `behavior_feedback(behavior="Y", relevant=false, context="not applicable")` -- spam (disconfirm).',
    "5. `behavior_list` to inspect confidence and evidence counts.",
  ].join("\n"),
  expected: [
    "- Step 1: Returns `[codified]`, confidence=0.50, counts (0/0).",
    "- Step 2: Returns `[confirm]`, confidence > 0.50. Formula: (1 + 5*0.5) / (1 + 0 + 5) = 0.583. Counts (1/0).",
    "- Step 3: Returns `[soft]` (if applicable), confidence drops slightly. Soft adds 0.25 to disconfirm_count. Formula: (1 + 2.5) / (1 + 0.25 + 5) = 0.571. Counts (1/0.25).",
    "- Step 4: Returns `[disconfirm]`, confidence drops further. Formula: (1 + 2.5) / (1 + 1.25 + 5) = 0.524. Counts (1/1.25).",
    "- Step 5: `behavior_list` shows the behavior with accumulated provenance entries sorted newest-first.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    const K = 5, P0 = 0.5;

    try {
      const matcherText = "about to import a new library";
      const matcherEmbed = await model.queryEmbed(matcherText);
      const matcherId = db.createBehaviorMatcher(store, matcherText, matcherEmbed, model.name);

      const behaviorText = "check the whole codebase for an existing import first";
      const behaviorEmbed = await model.queryEmbed(behaviorText);
      const behaviorId = db.createBehavior(store, behaviorText, "discipline", behaviorEmbed, model.name);
      db.createBehaviorEdge(matcherId, behaviorId, 1.0);

      // Step 1: codify -> confidence=0.50, counts (0, 0).
      let behavior = db.getBehavior(behaviorId);
      if (Math.abs(behavior!.confidence - 0.5) > 0.001) {
        console.log(`  FAIL: initial confidence should be 0.5, got ${behavior!.confidence}`);
        return "FAIL";
      }
      if (behavior!.confirm_count !== 0 || behavior!.disconfirm_count !== 0) {
        console.log(`  FAIL: initial counts should be (0, 0), got (${behavior!.confirm_count}, ${behavior!.disconfirm_count})`);
        return "FAIL";
      }

      // Step 2: ham (confirm) -> (1 + K*P0) / (1 + 0 + K) = 3.5/6.
      db.adjustBehaviorConfidence(behaviorId, "confirm");
      db.addBehaviorProvenance(behaviorId, "confirm", "ham: relevant to this import");
      behavior = db.getBehavior(behaviorId);
      if (behavior!.confirm_count !== 1) {
        console.log(`  FAIL: confirm_count should be 1, got ${behavior!.confirm_count}`);
        return "FAIL";
      }
      const expectedAfterConfirm = (1 + K * P0) / (1 + 0 + K);
      if (Math.abs(behavior!.confidence - expectedAfterConfirm) > 0.001) {
        console.log(`  FAIL: after confirm confidence should be ${expectedAfterConfirm.toFixed(4)}, got ${behavior!.confidence}`);
        return "FAIL";
      }

      // Step 3: soft -> adds 0.25 to disconfirm_count.
      db.adjustBehaviorConfidence(behaviorId, "soft");
      db.addBehaviorProvenance(behaviorId, "soft", "spam: partially relevant");
      behavior = db.getBehavior(behaviorId);
      if (Math.abs(behavior!.disconfirm_count - 0.25) > 0.001) {
        console.log(`  FAIL: disconfirm_count should be 0.25, got ${behavior!.disconfirm_count}`);
        return "FAIL";
      }
      const expectedAfterSoft = (1 + K * P0) / (1 + 0.25 + K);
      if (Math.abs(behavior!.confidence - expectedAfterSoft) > 0.001) {
        console.log(`  FAIL: after soft confidence should be ${expectedAfterSoft.toFixed(4)}, got ${behavior!.confidence}`);
        return "FAIL";
      }

      // Step 4: disconfirm (spam) -> adds 1 to disconfirm_count (now 1.25).
      db.adjustBehaviorConfidence(behaviorId, "disconfirm");
      db.addBehaviorProvenance(behaviorId, "disconfirm", "spam: not applicable here");
      behavior = db.getBehavior(behaviorId);
      if (Math.abs(behavior!.disconfirm_count - 1.25) > 0.001) {
        console.log(`  FAIL: disconfirm_count should be 1.25, got ${behavior!.disconfirm_count}`);
        return "FAIL";
      }
      const expectedAfterDisconfirm = (1 + K * P0) / (1 + 1.25 + K);
      if (Math.abs(behavior!.confidence - expectedAfterDisconfirm) > 0.001) {
        console.log(`  FAIL: after disconfirm confidence should be ${expectedAfterDisconfirm.toFixed(4)}, got ${behavior!.confidence}`);
        return "FAIL";
      }

      // Step 5: provenance has 3 entries (confirm, soft, disconfirm), newest first.
      const provenance = db.getBehaviorProvenance(behaviorId);
      if (provenance.length !== 3) {
        console.log(`  FAIL: expected 3 provenance entries, got ${provenance.length}`);
        return "FAIL";
      }
      if (provenance[0].signal !== "disconfirm" || provenance[1].signal !== "soft" || provenance[2].signal !== "confirm") {
        console.log(`  FAIL: provenance order wrong: ${provenance.map((p: { signal: string }) => p.signal).join(", ")}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
