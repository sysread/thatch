import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-110: Memory label derivation.
 *
 * Automatable: label optionality is a tool-level behavior. This test calls
 * memory_remember without a label via the tool execute function against a
 * real temp DB and verifies the derived label, the heading strip, the
 * 80-char cap, the overwrite upsert on a derived slug, and the no-content
 * guidance.
 */

const useCase: UseCase = {
  name: "UC-110-memory-label-derivation",
  preconditions: [
    "- A clean DB (no memories with the labels the derivation will produce)",
  ].join("\n"),
  steps: [
    '1. Call `memory_remember(content="# Derived heading\\n\\nbody text")` with no label.',
    '2. Call `memory_remember(content="plain first line stands as the label\\n\\nbody")` with no label.',
    "3. Call `memory_remember` with no label and a first line longer than 80 characters.",
    "4. Repeat step 1's call with `overwrite: true`.",
    "5. Call `memory_remember` with a label but no content.",
  ].join("\n"),
  expected: [
    "- Step 1: saved under the label `Derived heading`; the stored body is `body text` (the heading is not duplicated).",
    "- Step 2: saved under the label `plain first line stands as the label`.",
    "- Step 3: saved under the first 80 characters of the first line.",
    "- Step 4: no duplicate - the derived slug upserts the step-1 entry.",
    "- Step 5: returns guidance naming the content parameter; nothing saved.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "derive-test";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      // Step 1: leading heading becomes the label and is stripped from the body.
      const r1 = await findTool("memory_remember").execute(
        { content: "# Derived heading\n\nbody text" },
        coreCtx,
      );
      if (!r1.includes("[saved]") || !r1.includes("Derived heading")) {
        console.log(`  FAIL: step 1 should save under the derived heading, got: ${r1.slice(0, 200)}`);
        return "FAIL";
      }
      const shown1 = await findTool("memory_show").execute({ label: "Derived heading" }, coreCtx);
      if (!shown1.includes("body text") || shown1.includes("# Derived heading\n\n# Derived heading")) {
        console.log(`  FAIL: step 1 body should hold the text once, got: ${shown1.slice(0, 300)}`);
        return "FAIL";
      }

      // Step 2: plain first line becomes the label.
      const r2 = await findTool("memory_remember").execute(
        { content: "plain first line stands as the label\n\nbody" },
        coreCtx,
      );
      if (!r2.includes("plain first line stands as the label")) {
        console.log(`  FAIL: step 2 should save under the first line, got: ${r2.slice(0, 200)}`);
        return "FAIL";
      }

      // Step 3: first line longer than 80 chars truncates to 80.
      const longLine = "x".repeat(120);
      const r3 = await findTool("memory_remember").execute({ content: longLine }, coreCtx);
      if (!r3.includes("[saved]")) {
        console.log(`  FAIL: step 3 should save, got: ${r3.slice(0, 200)}`);
        return "FAIL";
      }
      const shown3 = await findTool("memory_show").execute({ label: "x".repeat(80) }, coreCtx);
      if (!shown3.includes("x".repeat(80))) {
        console.log("  FAIL: step 3 label should be the first 80 characters");
        return "FAIL";
      }

      // Step 4: overwrite with a derived label upserts, no duplicate.
      const r4 = await findTool("memory_remember").execute(
        { content: "# Derived heading\n\nbody text", overwrite: true },
        coreCtx,
      );
      if (!r4.includes("[saved]")) {
        console.log(`  FAIL: step 4 overwrite should succeed, got: ${r4.slice(0, 200)}`);
        return "FAIL";
      }
      const entries = db.listEntries(store).filter((e) => e.label === "Derived heading");
      if (entries.length !== 1) {
        console.log(`  FAIL: step 4 should keep exactly one entry, found ${entries.length}`);
        return "FAIL";
      }

      // Step 5: no content returns guidance, saves nothing.
      const r5 = await findTool("memory_remember").execute({ label: "orphan" }, coreCtx);
      if (!r5.includes("content parameter")) {
        console.log(`  FAIL: step 5 should return content guidance, got: ${r5.slice(0, 200)}`);
        return "FAIL";
      }
      if (db.listEntries(store).some((e) => e.label === "orphan")) {
        console.log("  FAIL: step 5 should not save anything");
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
