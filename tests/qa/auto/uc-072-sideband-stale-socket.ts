import { $ } from "bun";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { sidebandMatch, sidebandSocketPath } from "../../../src/sideband";

/**
 * UC-072: Sideband stale socket.
 *
 * Automatable: the stale-socket cleanup is a pure filesystem + socket test.
 * A stale socket file (left by a crashed server) causes ECONNREFUSED, which
 * triggers unlinkSync(socketPath) in the error handler. The client returns
 * null, and flush-tools degrades to the write nudge.
 */

const useCase: UseCase = {
  name: "UC-072-sideband-stale-socket",
  preconditions: [
    "- A stale socket file at the expected socket path (left by a crashed MCP server)",
    "- No live server listening on that socket",
  ].join("\n"),
  steps: [
    "1. Create a socket file at the sideband socket path without starting a server.",
    "2. From a hook process, call sidebandMatch(socketPath, text, stores, threshold, limit).",
    "3. Verify the stale socket file is removed after the call.",
    "4. Run thatch flush-tools with an empty extraction queue and a prompt >= 10 chars.",
  ].join("\n"),
  expected: [
    "- Step 2: connect(socketPath) emits ECONNREFUSED. The error handler calls unlinkSync(socketPath) and done(null).",
    "- Step 3: the stale socket file is gone.",
    "- Step 4: flush-tools degrades to the write nudge. The agent is not blocked.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const dbDir = mkdtempSync(join(tmpdir(), "thatch-qa-uc072-"));
    const dbPath = join(dbDir, "test.db");
    const db = new ThatchDB(dbPath);
    const sockPath = sidebandSocketPath(dbPath);

    try {
      // Step 1: create a stale socket file (simulating a crashed server).
      writeFileSync(sockPath, "stale");

      // Verify the file exists before the call.
      if (!existsSync(sockPath)) {
        console.log("  FAIL: stale socket file should exist before the call");
        return "FAIL";
      }

      // Step 2: call sidebandMatch — should get ECONNREFUSED and return null.
      const matches = await sidebandMatch(sockPath, "test", ["s"], 0.0, 5);
      if (matches !== null) {
        console.log(`  FAIL: sidebandMatch should return null on stale socket, got ${matches?.length} matches`);
        return "FAIL";
      }

      // Step 3: verify the stale socket file was cleaned up.
      if (existsSync(sockPath)) {
        console.log("  FAIL: stale socket file should have been removed by error handler");
        return "FAIL";
      }

      // Step 4: run flush-tools via CLI — should degrade to write nudge.
      const bin = `${ctx.repoRoot}/bin/thatch`;
      const env = { ...ctx.env, THATCH_MODEL: "mock", THATCH_DB_PATH: dbPath };
      const flushInput = JSON.stringify({ session_id: "uc072-test", prompt: "fix the bug in the parser code" });
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

      return "PASS";
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
