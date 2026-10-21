import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";
import { z } from "zod";

/**
 * UC-126: Memory tool wrong-shape teaching.
 *
 * Automatable: the accept-then-teach guards are tool-level behavior. The
 * motivating audit (Oct 2026: 522 failed memory-tool calls in 30 days
 * across all classes, ~402 of them missing-or-misnamed keys) showed calls
 * like memory_remember with a misnamed content key ("text") and
 * memory_show/memory_forget with no label - both died at host schema
 * validation. With the keys schema-optional, validation strips unknown
 * keys and the executes return teaching guidance naming the right
 * parameter and how to find exact labels. Every step here simulates the
 * production shape by parsing the misnamed args through the real schema
 * (z.object strips unknown keys, exactly like the hosts) before execute.
 */

const useCase: UseCase = {
  name: "UC-126-memory-wrong-shape-teaching",
  preconditions: [
    "- A clean DB (no memories pre-saved in the teaching-test store)",
  ].join("\n"),
  steps: [
    '1. Call `memory_remember` with args `{ text: "hello" }` parsed through the tool schema (misnamed content key).',
    "2. Call `memory_remember` with an empty args object parsed through the tool schema.",
    '3. Call `memory_show` with args `{ id: "nope" }` parsed through the tool schema (misnamed label key).',
    "4. Call `memory_forget` with an empty args object parsed through the tool schema.",
    "5. Call `memory_forget` with a whitespace label.",
    "6. Call `memory_show` with a valid label after saving one memory, to confirm the guards did not break the happy path.",
  ].join("\n"),
  expected: [
    "- Steps 1-2: guidance naming the content parameter; nothing saved.",
    "- Steps 3-5: guidance naming memory_list/memory_recall as the way to find exact labels; nothing deleted.",
    "- Step 6: the memory is read normally.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "wrong-shape-test";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
    // The production shape: the host validates with z.object(def.args),
    // which strips unknown keys. Parsing the misnamed args through the
    // real schema reproduces exactly what execute receives.
    const parsed = (name: string, args: Record<string, unknown>) =>
      z.object(findTool(name).args).parse(args);

    try {
      // Step 1: misnamed content key ("text" instead of "content").
      const r1 = await findTool("memory_remember").execute(parsed("memory_remember", { text: "hello" }), coreCtx);
      if (!r1.includes("content parameter")) {
        console.log(`  FAIL: step 1 should teach the content parameter, got: ${r1.slice(0, 200)}`);
        return "FAIL";
      }

      // Step 2: everything missing.
      const r2 = await findTool("memory_remember").execute(parsed("memory_remember", {}), coreCtx);
      if (!r2.includes("content parameter")) {
        console.log(`  FAIL: step 2 should teach the content parameter, got: ${r2.slice(0, 200)}`);
        return "FAIL";
      }
      if (db.listEntries(store).length !== 0) {
        console.log("  FAIL: steps 1-2 should not save anything");
        return "FAIL";
      }

      // Step 3: misnamed label key ("id" instead of "label").
      const r3 = await findTool("memory_show").execute(parsed("memory_show", { id: "nope" }), coreCtx);
      if (!r3.includes("No label provided") || !r3.includes("memory_list")) {
        console.log(`  FAIL: step 3 should teach how to find labels, got: ${r3.slice(0, 200)}`);
        return "FAIL";
      }

      // Step 4: forget with no label teaches instead of deleting blindly.
      const r4 = await findTool("memory_forget").execute(parsed("memory_forget", {}), coreCtx);
      if (!r4.includes("No label provided") || !r4.includes("memory_recall")) {
        console.log(`  FAIL: step 4 should teach how to find labels, got: ${r4.slice(0, 200)}`);
        return "FAIL";
      }

      // Step 5: whitespace label is treated as missing.
      const r5 = await findTool("memory_forget").execute({ label: "   " }, coreCtx);
      if (!r5.includes("No label provided")) {
        console.log(`  FAIL: step 5 should treat whitespace as missing, got: ${r5.slice(0, 200)}`);
        return "FAIL";
      }

      // Step 6: the guards did not break the happy path.
      const r6 = await findTool("memory_remember")
        .execute({ label: "Happy path", content: "body" }, coreCtx);
      if (!r6.includes("[saved]")) {
        console.log(`  FAIL: step 6 save should succeed, got: ${r6.slice(0, 200)}`);
        return "FAIL";
      }
      const shown = await findTool("memory_show").execute({ label: "Happy path" }, coreCtx);
      if (!shown.includes("body")) {
        console.log(`  FAIL: step 6 show should read the memory, got: ${shown.slice(0, 200)}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
