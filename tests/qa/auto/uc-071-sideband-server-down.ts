import { $ } from "bun";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { sidebandMatch, sidebandPredictions, sidebandBehaviors, sidebandSocketPath } from "../../../src/sideband";

/**
 * UC-071: Sideband server down.
 *
 * Automatable: the "server not running" failure mode is a pure socket
 * connection test. With no SidebandServer listening, connect() emits
 * ECONNREFUSED or ENOENT, and all three client functions return null.
 * flush-tools degrades to the write nudge.
 */

const useCase: UseCase = {
  name: "UC-071-sideband-server-down",
  preconditions: [
    "- No SidebandServer running on the expected socket path",
    "- A hook process attempting to call sidebandMatch / sidebandPredictions / sidebandBehaviors",
  ].join("\n"),
  steps: [
    "1. Ensure the MCP server is not running (no process listening on the socket path).",
    "2. From a hook process, call sidebandMatch(socketPath, text, stores, threshold, limit).",
    "3. Run thatch flush-tools with an empty extraction queue and a prompt >= 10 chars.",
  ].join("\n"),
  expected: [
    "- Step 2: connect(socketPath) emits ECONNREFUSED or ENOENT. sidebandMatch resolves to null.",
    "- Step 3: flush-tools tier 1 is skipped (empty queue). Tier 2 attempts sideband — all three calls return null. Tier 3 fires: the write nudge.",
    "- The agent is never blocked by a sideband failure.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const dbDir = mkdtempSync(join(tmpdir(), "thatch-qa-uc071-"));
    const dbPath = join(dbDir, "test.db");
    const db = new ThatchDB(dbPath);
    const model = new MockEmbeddingModel();
    const sockPath = sidebandSocketPath(dbPath);

    // Ensure no server is running — just create the DB, don't start a server.
    // Store a memory so a recall nudge would fire if the server were up.
    db.remember("s", "test-memory", "content", await model.passageEmbed("test-memory"), "mock");

    try {
      // Step 2: call all three client functions with no server running.
      const matches = await sidebandMatch(sockPath, "test-memory", ["s", "global"], 0.0, 5);
      if (matches !== null) {
        console.log(`  FAIL: sidebandMatch should return null with no server, got ${matches.length} matches`);
        return "FAIL";
      }

      const predictions = await sidebandPredictions(sockPath, "test-memory", ["s", "global"], 0.0, 5);
      if (predictions !== null) {
        console.log(`  FAIL: sidebandPredictions should return null with no server, got ${predictions?.length} items`);
        return "FAIL";
      }

      const behaviors = await sidebandBehaviors(sockPath, "test-memory", ["s", "global"], 0.0, 5);
      if (behaviors !== null) {
        console.log(`  FAIL: sidebandBehaviors should return null with no server, got ${behaviors?.length} items`);
        return "FAIL";
      }

      // Step 3: run flush-tools via CLI — should degrade to write nudge.
      const bin = `${ctx.repoRoot}/bin/thatch`;
      const env = { ...ctx.env, THATCH_MODEL: "mock", THATCH_DB_PATH: dbPath };
      const flushInput = JSON.stringify({ session_id: "uc071-test", prompt: "fix the bug in the parser code" });
      const result = await $`echo ${flushInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
      if (result.exitCode !== 0) {
        console.log("  FAIL: flush-tools exited non-zero");
        return "FAIL";
      }
      const out = result.stdout.toString();
      if (!out.includes("did you learn")) {
        console.log(`  FAIL: flush-tools should degrade to write nudge, got: ${out.slice(0, 200)}`);
        return "FAIL";
      }

      // No socket file should be left behind (ENOENT case — file never existed).
      if (existsSync(sockPath)) {
        console.log("  FAIL: socket file should not exist when server was never started");
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
