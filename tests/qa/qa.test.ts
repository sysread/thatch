import { describe, test, beforeAll, afterAll } from "bun:test";
import {
  ensureMaster,
  createUcFixture,
  runOpencode,
  buildPrompt,
  parseResult,
  discoverUseCases,
  QA_ROOT,
} from "./fixture";

/**
 * QA use-case suite. Each use case in docs/qa/use-cases/ gets its own
 * isolated repo copy, env vars, and opencode run session. Results are
 * parsed from the session output.
 *
 * Run with: mise run qa
 * Concurrency: bun test --concurrency N (default 5 via mise.toml)
 *
 * Requires VENICE_API_KEY in the environment.
 */

const DRY_RUN = process.env.QA_DRY_RUN === "1";

const useCases = discoverUseCases();

beforeAll(async () => {
  if (!process.env.VENICE_API_KEY) {
    throw new Error("VENICE_API_KEY is not set in the environment");
  }
  if (!DRY_RUN) {
    await ensureMaster();
  }
});

afterAll(() => {
  if (!DRY_RUN) {
    // Leave artifacts for inspection; user cleans up with rm -rf /tmp/thatch-qa
    console.log(`\nQA artifacts left in ${QA_ROOT}`);
    console.log(`Remove with: rm -rf ${QA_ROOT}`);
  }
});

describe("QA use cases", () => {
  for (const uc of useCases) {
    test.concurrent(uc.name, async () => {
      if (DRY_RUN) {
        console.log(`  [DRY RUN] ${uc.name} — skipped`);
        return;
      }

      const { dir, env } = await createUcFixture(uc.name);
      const prompt = buildPrompt(uc.content);
      const { stdout, exitCode } = await runOpencode(dir, env, prompt);
      const result = parseResult(stdout);

      // Print the result for the aggregation summary.
      console.log(`  ${uc.name}: ${result}`);

      if (exitCode !== 0 && result === "UNKNOWN") {
        // opencode itself failed, not a use-case failure.
        console.log(`  ERROR: opencode run exited ${exitCode}`);
        console.log(`  Output: ${stdout.slice(0, 500)}`);
        throw new Error(`${uc.name}: opencode run failed (exit ${exitCode})`);
      }

      // PASS and MANUAL-ONLY don't throw. FAIL and PARTIAL throw so bun's
      // reporter shows them as failures. UNKNOWN throws too — it means the
      // LLM didn't follow the output format.
      if (result === "FAIL" || result === "PARTIAL") {
        throw new Error(`${uc.name}: ${result}\n${stdout.slice(0, 1000)}`);
      }
      if (result === "UNKNOWN") {
        throw new Error(`${uc.name}: could not parse result from output\n${stdout.slice(0, 1000)}`);
      }
    }, { timeout: 300_000 }); // 5 min per use case
  }
});
