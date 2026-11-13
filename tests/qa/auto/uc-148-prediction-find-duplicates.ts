import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { hygieneReport } from "../../../src/hygiene";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-148: Prediction pair enumeration. prediction_find_duplicates lists
 * the pending dedup pairs with both ids (the enumeration the hygiene
 * nudge's count-only line never provided), the hygiene line names the
 * pair ids inline while the count is small, and a verdict closes the
 * loop: the pair leaves both surfaces. Automatable: pure DB+embedding
 * operations, no model tokens.
 */

const useCase: UseCase = {
  name: "UC-148-prediction-find-duplicates",
  preconditions: [
    "- An empty DB (the runner provisions a throwaway one)",
    "- The prediction tools available through TOOL_DEFS",
  ].join("\n"),
  steps: [
    "1. Seed two rewordings of one preference (shared embedding) plus one unrelated prediction.",
    "2. Run the hygiene report.",
    "3. `prediction_find_duplicates` with no store argument.",
    "4. Mark the pair `distinct` with `prediction_mark_checked`, then re-run the tool and the hygiene report.",
    "5. Seed a second pair in the global store; scan the project store, then scan with `store: \"global\"`.",
    "6. Seed four rows sharing one embedding (six pairs) and run the hygiene report.",
  ].join("\n"),
  expected: [
    "- Step 2: The report line is `1 prediction duplicate pair pending review: (<idA>, <idB>)` with both real ids.",
    "- Step 3: The tool lists the pair with both ids, both statements, and a score; the unrelated prediction appears in no pair line.",
    "- Step 4: The tool reports no pairs; the prediction-dedup line is gone from the hygiene report.",
    "- Step 5: The project-store scan reports none; the global scan lists the pair with its ids.",
    "- Step 6: The report line carries the count only (six pairs, past the inline-id cap).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
    const worktree = mkdtempSync(join(tmpdir(), "uc-148-"));

    try {
      // Step 1: two rewordings sharing one embedding (cosine 1.0 under the
      // hash-seeded mock) plus an unrelated prediction.
      const embed = await model.passageEmbed("prefer minimal dependencies");
      const idA = db.createPrediction(store, "prefer minimal dependencies", "first wording", embed, model.name);
      const idB = db.createPrediction(store, "keep the dependency list small", "reworded later", embed, model.name);
      db.createPrediction(store, "prefer tabs for indentation", "unrelated", await model.passageEmbed("prefer tabs for indentation"), model.name);

      // Step 2: the hygiene line names the pair ids inline. The scan
      // orders rows by id, so the pair renders sorted, not in creation
      // order.
      const pairInline = [idA, idB].sort().join(", ");
      const report = await hygieneReport(db, store, worktree);
      if (!report || !report.includes(`1 prediction duplicate pair pending review: (${pairInline})`)) {
        console.log(`  FAIL: hygiene line should name the pair ids inline, got: ${report}`);
        return "FAIL";
      }

      // Step 3: the listing tool carries the same pair with ids.
      const listing = await findTool("prediction_find_duplicates").execute({}, coreCtx);
      if (!listing.includes(`"prefer minimal dependencies" (id: ${idA})`)) {
        console.log(`  FAIL: listing should show statement A with its id, got: ${listing}`);
        return "FAIL";
      }
      if (!listing.includes(`"keep the dependency list small" (id: ${idB})`)) {
        console.log(`  FAIL: listing should show statement B with its id, got: ${listing}`);
        return "FAIL";
      }
      if (!listing.includes("[score:1]")) {
        console.log(`  FAIL: listing should show the pair score, got: ${listing}`);
        return "FAIL";
      }
      if (listing.includes("prefer tabs for indentation")) {
        console.log(`  FAIL: unrelated prediction must not appear in a pair line, got: ${listing}`);
        return "FAIL";
      }

      // Step 4: a verdict empties both surfaces - the nudge stops firing
      // on a pair the agent has adjudicated.
      const verdict = await findTool("prediction_mark_checked").execute({
        id_a: idA,
        id_b: idB,
        status: "distinct",
      }, coreCtx);
      if (!verdict.includes("[marked distinct]")) {
        console.log(`  FAIL: verdict call should succeed, got: ${verdict}`);
        return "FAIL";
      }
      const after = await findTool("prediction_find_duplicates").execute({}, coreCtx);
      if (!after.includes("No prediction duplicate pairs found")) {
        console.log(`  FAIL: verdicted pair should leave the listing, got: ${after}`);
        return "FAIL";
      }
      const reportAfter = await hygieneReport(db, store, worktree);
      if (reportAfter && reportAfter.includes("prediction duplicate pair")) {
        console.log(`  FAIL: hygiene line should be gone after the verdict, got: ${reportAfter}`);
        return "FAIL";
      }

      // Step 5: store scoping - a global-only pair is invisible to the
      // project scan and listed by the explicit store argument.
      const gA = db.createPrediction("global", "prefer minimal dependencies", "first wording", embed, model.name);
      const gB = db.createPrediction("global", "keep the dependency list small", "reworded later", embed, model.name);
      const projectScan = await findTool("prediction_find_duplicates").execute({}, coreCtx);
      if (!projectScan.includes("No prediction duplicate pairs found")) {
        console.log(`  FAIL: project scan should be clean, got: ${projectScan}`);
        return "FAIL";
      }
      const globalScan = await findTool("prediction_find_duplicates").execute({ store: "global" }, coreCtx);
      if (!globalScan.includes(`(id: ${gA})`) || !globalScan.includes(`(id: ${gB})`)) {
        console.log(`  FAIL: global scan should list the global pair with ids, got: ${globalScan}`);
        return "FAIL";
      }

      // Step 6: past the cap the hygiene line keeps the count only - the
      // ids would crowd out the line, and the listing tool carries them.
      // The cap seeds get their own embedding so the four rows pair six
      // ways among themselves (the step-1 rows no longer share it).
      const capEmbed = await model.passageEmbed("prefer wide line wraps");
      const capIds = ["a", "b", "c", "d"].map((s) =>
        db.createPrediction(store, `prefer ${s} line wraps`, "cap seed", capEmbed, model.name));
      if (db.findPredictionDuplicates(store).length !== 6) {
        console.log(`  FAIL: four shared-embedding rows should pair six ways, got ${db.findPredictionDuplicates(store).length}`);
        return "FAIL";
      }
      const capped = await hygieneReport(db, store, worktree);
      if (!capped || !capped.includes("6 prediction duplicate pairs pending review")) {
        console.log(`  FAIL: capped line should carry the count, got: ${capped}`);
        return "FAIL";
      }
      for (const id of capIds) {
        if (capped.includes(id)) {
          console.log(`  FAIL: capped line should not carry ids, got: ${capped}`);
          return "FAIL";
        }
      }

      return "PASS";
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      db.close();
    }
  },
};

registerUseCase(useCase);
