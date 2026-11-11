import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { hygieneReport } from "../../../src/hygiene";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-113: Prediction dedup — the hygiene report surfaces reworded duplicate
 * predictions, the agent merges (fold the loser's matcher onto the winner,
 * mark the pair, delete the loser), and prediction_mark_checked records the
 * verdict so adjudicated pairs stop resurfacing. Automatable: pure
 * DB+embedding operations, no model tokens.
 *
 * The verdict is recorded BEFORE the loser is deleted (mark_checked
 * validates that both ids are live predictions), and the loser is removed
 * through prediction_delete's exact id path - the statement path's 0.85
 * semantic match cannot safely target a [0.70, 0.85) rewording.
 */

const useCase: UseCase = {
  name: "UC-113-prediction-dedup",
  preconditions: [
    "- A DB whose prediction store holds two rewordings of one preference plus one unrelated prediction",
  ].join("\n"),
  steps: [
    "1. Seed two reworded copies of one preference and one unrelated prediction.",
    "2. Run the hygiene report.",
    '3. Merge the pair: `prediction_update` with the winner\'s statement against the loser\'s matcher text, `prediction_mark_checked(id_a, id_b, status="duplicate")`, then `prediction_delete(id=<loser id>)`.',
    "4. Re-run the hygiene report and the dedup scan.",
  ].join("\n"),
  expected: [
    "- Step 2: The report contains `1 prediction duplicate pair pending review`.",
    "- Step 3: The fold links the shared matcher to the winner; the mark echoes `[marked duplicate]` while both ids are live; the id-path delete removes exactly the loser.",
    "- Step 4: No candidates remain and the prediction-dedup line is gone from the report.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
    const worktree = mkdtempSync(join(tmpdir(), "uc-113-"));

    try {
      // Seed: two rewordings sharing one embedding (cosine 1.0, the mock
      // hashes text, so both rows get the same vector) with a shared
      // matcher, plus one unrelated prediction.
      const winnerText = "prefer minimal dependencies";
      const loserText = "keep the dependency list small";
      const embed = await model.passageEmbed(winnerText);
      const matcherId = db.createMatcher(store, "choosing a framework", await model.passageEmbed("choosing a framework"), model.name);
      const idA = db.createPrediction(store, winnerText, "user said", embed, model.name);
      const idB = db.createPrediction(store, loserText, "reworded later", embed, model.name);
      db.createEdge(matcherId, idA, 1.0);
      db.createEdge(matcherId, idB, 1.0);
      db.createPrediction(store, "prefer tabs for indentation", "user said", await model.passageEmbed("prefer tabs for indentation"), model.name);

      // Step 2: hygiene surfaces the pair.
      const report = await hygieneReport(db, store, worktree);
      if (!report || !report.includes("1 prediction duplicate pair pending review")) {
        console.log(`  FAIL: hygiene report missing prediction dedup line, got: ${report}`);
        return "FAIL";
      }

      // Step 3: merge. Fold the loser's matcher onto the winner (the
      // near-identical winner is found by the write-time dedup and the edge
      // links to it), record the verdict while both ids are live, then
      // delete the loser through the exact id path.
      const fold = await findTool("prediction_update").execute({
        matcher: "choosing a framework",
        prediction: winnerText,
        signal: "create",
        rationale: "folding the duplicate's matcher into the winner",
      }, coreCtx);
      if (!fold.includes("[linked")) {
        console.log(`  FAIL: fold should link the matcher to the existing winner, got: ${fold}`);
        return "FAIL";
      }

      const mark = await findTool("prediction_mark_checked").execute({
        id_a: idA,
        id_b: idB,
        status: "duplicate",
      }, coreCtx);
      if (!mark.includes("[marked duplicate]")) {
        console.log(`  FAIL: expected [marked duplicate], got: ${mark}`);
        return "FAIL";
      }

      const del = await findTool("prediction_delete").execute({ id: idB }, coreCtx);
      if (!del.includes("[deleted]") || !del.includes(loserText)) {
        console.log(`  FAIL: id-path delete should remove the loser, got: ${del}`);
        return "FAIL";
      }

      // Step 4: the pair is gone (destroyed by the merge) and the scan is
      // clean; the hygiene line disappears.
      if (db.findPredictionDuplicates(store).length !== 0) {
        console.log("  FAIL: no dedup candidates should remain after the merge");
        return "FAIL";
      }
      const after = await hygieneReport(db, store, worktree);
      if (after && after.includes("prediction duplicate pair")) {
        console.log(`  FAIL: prediction dedup line should be gone, got: ${after}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
