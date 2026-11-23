import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { predictionNudge, recallNudge, opencodeToolName } from "../../../src/prompts";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-152: Nudge cap honesty - filter-then-cap ordering and truncation
 * disclosure.
 *
 * Automatable: the nudge scan (scorePredictionNudge / searchWithTotal) is a
 * pure DB+embedding operation and the disclosure is a pure formatting
 * function. The regression this pins: on a dense store the old top-5-then-
 * threshold ordering dropped everything the cap cut (measured on thog: 152
 * matchers fired, 147 silently dropped), and the nudge read as "this is
 * everything". Now the threshold decides relevance across ALL matchers, the
 * cap only bounds output, and a truncated list says "Top N of M".
 *
 * Seeding note: MockEmbeddingModel hashes the full text, so any wording
 * difference lands near-orthogonal. Every seeded row that must clear the
 * threshold therefore stores the query's own embedding; distinct slugs come
 * from distinct labels/statements, and distinct prediction embeddings keep
 * the semantic cross-store dedup from collapsing them.
 */

const useCase: UseCase = {
  name: "UC-152-nudge-truncation-disclosure",
  preconditions: [
    "- No live host needed: the scan runs against a seeded DB and the disclosure is a formatting function",
  ].join("\n"),
  steps: [
    "1. Seed 12 prediction matchers whose embeddings match the query above the auto-fire threshold, each linked to its own prediction.",
    "2. Call `scorePredictionNudge` with the default top-5 limit.",
    "3. Render `predictionNudge` with the scan's stats.",
    "4. Seed 8 memories above the recall threshold and call `searchWithTotal` with limit 5.",
    "5. Render `recallNudge` with the total.",
    "6. Seed 22 matcher/prediction pairs and call the `prediction_query` tool executor.",
  ].join("\n"),
  expected: [
    "- Step 2: `matchersFired` counts all 12 matchers; `itemsTotal` counts all 12 predictions; `items` holds at most 5.",
    "- Step 3: The block contains a 'Top 5 of 12 matching predictions shown (12 matchers fired)' line naming `thatch_prediction_query`.",
    "- Step 4: `rows` holds at most 5 entries; `totalAbove` counts all 8.",
    "- Step 5: The nudge says 'Top 5 of 8 memories relate to this prompt' - the truncated shape keeps the verb, so both recall forms read alike.",
    "- Step 6: The tool output caps at 20 items and includes 'Top 20 of 22 matching predictions shown (22 matchers fired)'.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";

    try {
      // Step 1: 12 matchers that all clear the threshold (each stores the
      // query's own embedding), linked to 12 predictions with distinct
      // embeddings so the semantic dedup cannot collapse them.
      const queryText = "reviewing a pull request diff before approving it";
      const queryEmbed = await model.queryEmbed(queryText);
      for (let i = 0; i < 12; i++) {
        const matcherText = `${queryText} - situation variant ${i}`;
        const matcherId = db.createMatcher(store, matcherText, queryEmbed, model.name);
        const statement = `preference number ${i}: state the finding before the fix`;
        const predEmbed = await model.queryEmbed(statement);
        const predId = db.createPrediction(store, statement, "seeded", predEmbed, model.name);
        db.createEdge(matcherId, predId, 1.0);
      }

      // Step 2: the scan - threshold filters all matchers, the limit caps items.
      const scan = db.scorePredictionNudge([store], queryEmbed, 0.45, 5);
      if (scan.matchersFired !== 12) {
        console.log(`  FAIL: matchersFired should be 12, got ${scan.matchersFired}`);
        return "FAIL";
      }
      if (scan.itemsTotal !== 12) {
        console.log(`  FAIL: itemsTotal should be 12, got ${scan.itemsTotal}`);
        return "FAIL";
      }
      if (scan.items.length !== 5) {
        console.log(`  FAIL: items should cap at 5, got ${scan.items.length}`);
        return "FAIL";
      }

      // Step 3: the disclosure line.
      const block = predictionNudge(scan.items, opencodeToolName, scan);
      if (!block.includes("Top 5 of 12 matching predictions shown (12 matchers fired)")) {
        console.log(`  FAIL: prediction truncation disclosure missing: ${block}`);
        return "FAIL";
      }
      if (!block.includes("thatch_prediction_query")) {
        console.log(`  FAIL: disclosure must name the query tool: ${block}`);
        return "FAIL";
      }

      // No truncation, no disclosure: an untruncated scan renders clean.
      const clean = predictionNudge(scan.items, opencodeToolName, {
        matchersFired: 1,
        itemsTotal: scan.items.length,
      });
      if (clean.includes("matching predictions shown")) {
        console.log(`  FAIL: disclosure rendered for an untruncated scan: ${clean}`);
        return "FAIL";
      }

      // Step 4: recall scan - minScore filters before the slice, total counts
      // all. Distinct labels give distinct slugs; all 8 store the query
      // embedding so all 8 clear the threshold.
      for (let i = 0; i < 8; i++) {
        const label = `recall memory ${i}: pull request review flow`;
        db.remember(store, label, `content ${i}`, queryEmbed, model.name);
      }
      const { rows, totalAbove } = db.searchWithTotal([store], queryEmbed, {
        limit: 5,
        minScore: 0.45,
      });
      if (rows.length !== 5) {
        console.log(`  FAIL: rows should cap at 5, got ${rows.length}`);
        return "FAIL";
      }
      if (totalAbove !== 8) {
        console.log(`  FAIL: totalAbove should be 8, got ${totalAbove}`);
        return "FAIL";
      }

      // Step 5: the recall nudge states the truncation.
      const matches = rows.map((r) => ({ label: r.label, score: Math.round(r._score * 1000) / 1000 }));
      const recall = recallNudge(matches, totalAbove);
      if (!recall.includes("Top 5 of 8 memories relate to this prompt")) {
        console.log(`  FAIL: recall truncation disclosure missing: ${recall}`);
        return "FAIL";
      }

      // Step 6: the prediction_query TOOL path - the same cap discipline on
      // the executor (20-item cap + disclosure), seeded past the cap.
      const toolStore = "test-store-tool-cap";
      const toolQuery = "deciding whether to run the full test suite before pushing";
      const toolEmbed = await model.queryEmbed(toolQuery);
      for (let i = 0; i < 22; i++) {
        const matcherId = db.createMatcher(toolStore, `${toolQuery} variant ${i}`, toolEmbed, model.name);
        const statement = `tool cap preference ${i}: run the fast suite first`;
        const predId = db.createPrediction(toolStore, statement, "seeded", await model.queryEmbed(statement), model.name);
        db.createEdge(matcherId, predId, 1.0);
      }
      const coreCtx: CoreContext = { db, model, defaultStore: toolStore };
      const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
      const toolResult = await findTool("prediction_query").execute(
        { context: toolQuery, store: toolStore },
        coreCtx,
      );
      if (!toolResult.includes("Top 20 of 22 matching predictions shown")) {
        console.log(`  FAIL: prediction_query tool-path cap disclosure missing: ${toolResult.slice(-400)}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
