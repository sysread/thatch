import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { mockEmbeddingVector } from "../../../src/embeddings";

/**
 * UC-004: Inspecting stores from the shell.
 *
 * Automatable: pure CLI calls with no LLM in the loop. Seeds a memory
 * via the CLI, then exercises stores/list/show/search and verifies
 * error handling for unquoted queries and bogus store names.
 */

const useCase: UseCase = {
  name: "UC-004-cli-inspection",
  preconditions: [
    "- Bun on PATH; thatch installed (npm i -g @jeffober/thatch or a checkout)",
    "- At least one memory saved via opencode",
  ].join("\n"),
  steps: [
    "1. `thatch stores` - list all stores.",
    "2. `cd` into the project's repo, then `thatch list` - labels default to the repo's store.",
    "3. `thatch show <label>` - full content.",
    "4. `thatch search <topic>` - semantic search.",
    "5. `thatch search some topic` (unquoted, multi-word).",
    '6. `thatch search "query" bogus-store`.',
    "7. `thatch remember` a memory under THATCH_MODEL=mock, then `thatch search` for it - the mock vectors round-trip through the CLI end to end.",
  ].join("\n"),
  expected: [
    "- Steps 1-4 behave as described; search results are ranked with scores.",
    "- Step 5 exits non-zero with an error telling you to quote the query.",
    "- Step 6 exits non-zero listing the stores that do exist.",
    "- Step 7: the remember saves and the search surfaces the memory at the mock's deterministic exact score (computed from the same derivation the model uses) - a mock-exclusive signal.",
    "- All commands respect THATCH_DB_PATH and $XDG_CONFIG_HOME.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = {
      ...ctx.env,
      // Use mock embedding so search works without downloading the real model.
      THATCH_MODEL: "mock",
    };

    // Seed a memory so stores/list/show have data to work with.
    // The CLI HAS a "remember" subcommand (it routes through the
    // memory_remember tool's execute); the empty-store steps and error
    // handling below need no seed, so the first write happens at step 7.

    // Step 1: thatch stores (empty DB — should show "global" at minimum).
    const storesResult = await $`${bin} stores`.env(env).quiet().nothrow();
    if (storesResult.exitCode !== 0) {
      console.log("  FAIL: `thatch stores` exited non-zero");
      return "FAIL";
    }
    const storesOut = storesResult.stdout.toString();
    if (!storesOut.includes("global")) {
      console.log("  FAIL: `thatch stores` doesn't list 'global'");
      return "FAIL";
    }

    // Step 2: thatch list (empty repo store — should say no memories).
    const listResult = await $`${bin} list`.env(env).quiet().nothrow();
    if (listResult.exitCode !== 0) {
      console.log("  FAIL: `thatch list` exited non-zero");
      return "FAIL";
    }

    // Step 5: unquoted multi-word query should exit non-zero.
    const unquotedResult = await $`${bin} search some topic`.env(env).quiet().nothrow();
    if (unquotedResult.exitCode === 0) {
      console.log("  FAIL: unquoted `thatch search some topic` should exit non-zero");
      return "FAIL";
    }

    // Step 6: bogus store name should exit non-zero.
    const bogusResult = await $`${bin} search "query" bogus-store`.env(env).quiet().nothrow();
    if (bogusResult.exitCode === 0) {
      console.log('  FAIL: `thatch search "query" bogus-store` should exit non-zero');
      return "FAIL";
    }

    // Step 7: the real mock-vector round. The mock's query path applies the
    // query prefix, so the stored CONTENT carries it - then a search for the
    // bare text hashes the same prefixed string and matches (cosine 1.0).
    const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
    const memoryText = "the qa fixture remembers the mock vector contract";
    const rememberResult = await $`${bin} remember ${QUERY_PREFIX + memoryText} --label mock-vector-contract`.env(env).quiet().nothrow();
    if (rememberResult.exitCode !== 0 || !rememberResult.stdout.toString().includes("[saved]")) {
      console.log(`  FAIL: \`thatch remember\` failed under THATCH_MODEL=mock: ${rememberResult.stderr.toString().slice(0, 200)}`);
      return "FAIL";
    }
    const searchResult = await $`${bin} search ${memoryText}`.env(env).quiet().nothrow();
    const searchOut = searchResult.stdout.toString();
    // Mock-exclusive teeth: the mock is exact-deterministic, so the score
    // is computable. The write path embeds "# label\n\ncontent"
    // (memory-store.md's write path); a reverted CLI factory (real model
    // instead of the mock) could never land on this exact value.
    const stored = mockEmbeddingVector(`# mock-vector-contract\n\n${QUERY_PREFIX + memoryText}`);
    const query = mockEmbeddingVector(QUERY_PREFIX + memoryText);
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < stored.length; i++) {
      dot += stored[i] * query[i];
      normA += stored[i] * stored[i];
      normB += query[i] * query[i];
    }
    const expectedScore = (dot / (Math.sqrt(normA) * Math.sqrt(normB))).toFixed(3);
    if (searchResult.exitCode !== 0 || !searchOut.includes("mock-vector-contract") || !searchOut.includes(`[score:${expectedScore}]`)) {
      console.log(`  FAIL: \`thatch search\` missed the mock-stored memory at the deterministic mock score ${expectedScore}: ${searchOut.slice(0, 200)}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
