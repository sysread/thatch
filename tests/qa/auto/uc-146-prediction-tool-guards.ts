import { Database } from "bun:sqlite";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-146: Prediction tool guard rails — the write and verdict paths refuse
 * the shapes that minted garbage into the live store (November 2026):
 * signal values as matcher/statement, short statements on the destructive
 * semantic delete, unknown or wrong-store ids on prediction_mark_checked,
 * and phantom pair rows (swept at every DB open). Automatable: pure
 * DB+embedding operations, no model tokens.
 */

const useCase: UseCase = {
  name: "UC-146-prediction-tool-guards",
  preconditions: [
    "- An empty DB (the runner provisions a throwaway one)",
    "- The prediction tools available through TOOL_DEFS",
  ].join("\n"),
  steps: [
    "1. `prediction_update` with the signal value in the prediction field, then in the matcher field.",
    "2. `prediction_delete` with a two-word statement, then with the row's id.",
    "3. `prediction_list` and check the output shows the row id.",
    "4. Seed a duplicate pair, then `prediction_mark_checked` with a fabricated id, then with the pair's real ids.",
    "5. Delete one member of the marked pair, close the DB, reopen it.",
  ].join("\n"),
  expected: [
    "- Step 1: Both calls are refused with teaching that names the signal parameter; no prediction rows are written.",
    "- Step 2: The short statement is refused (under three words, pass the id); the id delete removes exactly that row.",
    "- Step 3: The list line contains `(id: <uuid>)`.",
    "- Step 4: The fabricated id is refused and the pair still surfaces; the real-ids call echoes `[marked distinct]` and the pair stops surfacing.",
    "- Step 5: The reopened DB holds no pair-verdict row: the sweep at open removed the row whose loser id is gone.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Step 1: signal values must not land in the matcher or statement
      // fields (the live store held one-word "confirm"/"disconfirm"
      // prediction rows minted by exactly this slip).
      const asStatement = await findTool("prediction_update").execute({
        matcher: "the user corrected a prediction",
        prediction: "confirm",
        signal: "confirm",
        rationale: "user agreed",
      }, coreCtx);
      const asMatcher = await findTool("prediction_update").execute({
        matcher: "disconfirm",
        prediction: "prefer minimal dependencies",
        signal: "create",
        rationale: "user said",
      }, coreCtx);
      if (!asStatement.includes("not the signal value") || !asMatcher.includes("not the signal value")) {
        console.log(`  FAIL: signal-value writes should be refused, got: ${asStatement} / ${asMatcher}`);
        return "FAIL";
      }
      if (db.listPredictions(store).length !== 0) {
        console.log("  FAIL: refused prediction_update calls must write nothing");
        return "FAIL";
      }

      // Step 2: short statements refuse; the id path deletes exactly.
      const created = await findTool("prediction_update").execute({
        matcher: "choosing a framework",
        prediction: "prefer minimal dependencies",
        signal: "create",
        rationale: "user said",
      }, coreCtx);
      if (!created.includes("[created]")) {
        console.log(`  FAIL: setup create failed, got: ${created}`);
        return "FAIL";
      }
      const id = db.listPredictions(store)[0].id;

      const shortDelete = await findTool("prediction_delete").execute({
        statement: "prefer tabs",
      }, coreCtx);
      if (!shortDelete.includes("under three words")) {
        console.log(`  FAIL: two-word statement should be refused, got: ${shortDelete}`);
        return "FAIL";
      }
      if (db.listPredictions(store).length !== 1) {
        console.log("  FAIL: refused delete must leave the row in place");
        return "FAIL";
      }

      const idDelete = await findTool("prediction_delete").execute({ id }, coreCtx);
      if (!idDelete.includes("[deleted]") || !idDelete.includes("prefer minimal dependencies")) {
        console.log(`  FAIL: id-path delete should remove the row, got: ${idDelete}`);
        return "FAIL";
      }
      if (db.listPredictions(store).length !== 0) {
        console.log("  FAIL: id-path delete should leave no rows");
        return "FAIL";
      }

      // Step 3: the list shows ids (the discovery path for every id-based
      // call; before this, no surface exposed prediction ids and agents
      // fabricated them).
      await findTool("prediction_update").execute({
        matcher: "choosing a framework",
        prediction: "prefer minimal dependencies",
        signal: "create",
        rationale: "user said",
      }, coreCtx);
      const listId = db.listPredictions(store)[0].id;
      const list = await findTool("prediction_list").execute({}, coreCtx);
      if (!list.includes(`(id: ${listId})`)) {
        console.log(`  FAIL: prediction_list should show the row id, got: ${list}`);
        return "FAIL";
      }

      // Leave the store empty so the pair seeded next is the only
      // candidate source (three rows sharing one embedding would surface
      // three pairs, not one).
      await findTool("prediction_delete").execute({ id: listId }, coreCtx);

      // Step 4: unknown ids refuse (no verdict written, pair still
      // surfaces); real ids record the verdict.
      const embed = await model.passageEmbed("prefer minimal dependencies");
      const idA = db.createPrediction(store, "prefer minimal dependencies", "first wording", embed, model.name);
      const idB = db.createPrediction(store, "keep the dependency list small", "reworded later", embed, model.name);
      if (db.findPredictionDuplicates(store).length !== 1) {
        console.log("  FAIL: seeded pair should surface as one candidate");
        return "FAIL";
      }

      const fabricated = await findTool("prediction_mark_checked").execute({
        id_a: idA,
        id_b: "33333333-3333-4333-8333-333333333333",
        status: "distinct",
      }, coreCtx);
      if (!fabricated.includes("Verdict not recorded")) {
        console.log(`  FAIL: fabricated id should be refused, got: ${fabricated}`);
        return "FAIL";
      }
      if (db.findPredictionDuplicates(store).length !== 1) {
        console.log("  FAIL: refused verdict must not suppress the pair");
        return "FAIL";
      }

      const mark = await findTool("prediction_mark_checked").execute({
        id_a: idA,
        id_b: idB,
        status: "distinct",
      }, coreCtx);
      if (!mark.includes("[marked distinct]")) {
        console.log(`  FAIL: real-ids mark should succeed, got: ${mark}`);
        return "FAIL";
      }
      if (db.findPredictionDuplicates(store).length !== 0) {
        console.log("  FAIL: recorded verdict should suppress the pair");
        return "FAIL";
      }

      // Step 5: the merge flow's residue. Delete one member; the verdict
      // row survives the delete (no FK) and suppresses nothing; the next
      // DB open sweeps it.
      const delLoser = await findTool("prediction_delete").execute({ id: idB }, coreCtx);
      if (!delLoser.includes("[deleted]")) {
        console.log(`  FAIL: loser delete failed, got: ${delLoser}`);
        return "FAIL";
      }
      db.close();
      const reopened = new ThatchDB(ctx.env.THATCH_DB_PATH);
      try {
        const raw = new Database(ctx.env.THATCH_DB_PATH, { readonly: true });
        try {
          const rows = raw.query("SELECT COUNT(*) c FROM prediction_dedup_pairs").get() as { c: number };
          if (rows.c !== 0) {
            console.log(`  FAIL: reopen sweep should have removed the orphaned verdict row, ${rows.c} remain`);
            return "FAIL";
          }
        } finally {
          raw.close();
        }
      } finally {
        reopened.close();
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
