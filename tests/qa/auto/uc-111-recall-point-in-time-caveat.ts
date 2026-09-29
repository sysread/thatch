import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-111: Recall output carries the point-in-time caveat and age prose.
 *
 * Automatable: the caveat and "last updated N ago" sentence are rendered
 * at tool-output time (memory_recall, memory_show) with no LLM in the
 * loop. This is the read-side counterpart of the prompt layer's
 * "Memories Are Pointers, Not Truth" section: memories must be treated
 * as a guide to where to look, not a source of truth. The unit tests in
 * tests/tool-defs.test.ts pin the same contract; this use case runs it
 * through the qa-auto runner so the contract is exercised outside
 * `mise run check`, which does not execute tests/qa/.
 */

const useCase: UseCase = {
  name: "UC-111-recall-point-in-time-caveat",
  preconditions: [
    '- A store with one memory, e.g. `auth-token-refresh` -> "the token refresh logic lives in src/auth.ts and uses the interceptor pattern"',
  ].join("\n"),
  steps: [
    '1. Call `memory_recall(query="token refresh")`.',
    '2. Call `memory_show(label="auth-token-refresh")`.',
    "3. Call `memory_list`.",
  ].join("\n"),
  expected: [
    "- Steps 1 and 2: Output is prefixed with the point-in-time caveat - memories are a guide to where to look, not a source of truth - and names the correction path (`memory_remember` with `overwrite: true`, or `memory_forget`).",
    "- Steps 1 and 2: Output states the memory's age in human-readable prose (\"This memory was last updated N ... ago\"), keyed on last content change, not last recall.",
    '- Step 3: `memory_list` returns labels only - no caveat, no content.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();
    const store = "test-store";
    const coreCtx: CoreContext = { db, model, defaultStore: store };
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

    try {
      const content =
        "the token refresh logic lives in src/auth.ts and uses the interceptor pattern";
      const emb = await model.passageEmbed(content);
      const saved = db.remember(store, "auth-token-refresh", content, emb, "mock");
      if (!saved.ok) {
        console.log(`  FAIL: seeding memory failed: ${saved.error}`);
        return "FAIL";
      }

      // Step 1: memory_recall output carries caveat + age prose.
      const recalled = await findTool("memory_recall").execute(
        { query: "token refresh" }, coreCtx,
      );
      if (!recalled.includes("point-in-time record")) {
        console.log(`  FAIL: recall output missing point-in-time caveat, got: ${recalled}`);
        return "FAIL";
      }
      if (!recalled.includes("not a source of truth")) {
        console.log(`  FAIL: recall caveat should say memories are not a source of truth, got: ${recalled}`);
        return "FAIL";
      }
      if (!recalled.includes("memory_remember")) {
        console.log(`  FAIL: recall caveat should name the correction path, got: ${recalled}`);
        return "FAIL";
      }
      if (!recalled.includes("memory_forget")) {
        console.log(`  FAIL: recall caveat should name memory_forget as a correction path, got: ${recalled}`);
        return "FAIL";
      }
      if (!recalled.includes("This memory was last updated")) {
        console.log(`  FAIL: recall output missing age prose, got: ${recalled}`);
        return "FAIL";
      }

      // Step 2: memory_show output carries the same caveat + age prose.
      const shown = await findTool("memory_show").execute(
        { label: "auth-token-refresh" }, coreCtx,
      );
      if (!shown.includes("point-in-time record")) {
        console.log(`  FAIL: show output missing point-in-time caveat, got: ${shown}`);
        return "FAIL";
      }
      if (!shown.includes("This memory was last updated")) {
        console.log(`  FAIL: show output missing age prose, got: ${shown}`);
        return "FAIL";
      }

      // Step 3: memory_list is labels-only - no caveat, no age prose, no
      // memory content.
      const listed = await findTool("memory_list").execute({}, coreCtx);
      if (listed.includes("point-in-time record")) {
        console.log(`  FAIL: memory_list should not carry the caveat, got: ${listed}`);
        return "FAIL";
      }
      if (listed.includes("This memory was last updated")) {
        console.log(`  FAIL: memory_list should not carry age prose, got: ${listed}`);
        return "FAIL";
      }
      if (listed.includes("interceptor pattern")) {
        console.log(`  FAIL: memory_list should not include memory content, got: ${listed}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
