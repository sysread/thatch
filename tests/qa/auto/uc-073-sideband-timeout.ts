import { $ } from "bun";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { sidebandMatch, sidebandSocketPath } from "../../../src/sideband";

/**
 * UC-073: Sideband timeout.
 *
 * Automatable: the timeout failure mode is a pure IPC test. A server that
 * accepts connections but never responds triggers the setTimeout timer in
 * the client. The client calls socket.destroy() and done(null). The socket
 * file is NOT removed (the server is still live, just slow).
 */

const useCase: UseCase = {
  name: "UC-073-sideband-timeout",
  preconditions: [
    "- A SidebandServer instance that accepts connections but does not respond",
    "- A hook process calling sidebandMatch with a short timeout",
  ].join("\n"),
  steps: [
    "1. Start a TCP server on the socket path that accepts connections but never writes a response.",
    "2. From a hook process, call sidebandMatch with timeoutMs=100.",
    "3. Wait for the timeout to fire.",
    "4. Run thatch flush-tools with an empty extraction queue and a prompt >= 10 chars.",
  ].join("\n"),
  expected: [
    "- Step 2–3: connect succeeds, the client writes the request, the setTimeout timer fires after timeoutMs. socket.destroy() and done(null).",
    "- The socket file is NOT removed — the timeout error is not ECONNREFUSED or ENOENT.",
    "- sidebandMatch resolves to null.",
    "- Step 4: flush-tools degrades to the write nudge. The agent is not blocked.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const dbDir = mkdtempSync(join(tmpdir(), "thatch-qa-uc073-"));
    const dbPath = join(dbDir, "test.db");
    const db = new ThatchDB(dbPath);
    const sockPath = sidebandSocketPath(dbPath);

    // Start a slow server: accepts connections but never responds.
    const slowServer = createServer(() => {
      // Accept but don't respond — let the client time out.
    });
    slowServer.listen(sockPath);

    try {
      // Verify the socket file exists (server is listening).
      if (!existsSync(sockPath)) {
        console.log("  FAIL: socket file should exist when slow server is listening");
        return "FAIL";
      }

      // Step 2: call sidebandMatch with 100ms timeout.
      const matches = await sidebandMatch(sockPath, "test", ["s"], 0.0, 5, 100);
      if (matches !== null) {
        console.log(`  FAIL: sidebandMatch should return null on timeout, got ${matches?.length} matches`);
        return "FAIL";
      }

      // Verify the socket file was NOT removed (timeout is not ECONNREFUSED/ENOENT).
      if (!existsSync(sockPath)) {
        console.log("  FAIL: socket file should NOT be removed on timeout (server is still live)");
        return "FAIL";
      }

      // Step 4: run flush-tools via CLI — should degrade to write nudge.
      const bin = `${ctx.repoRoot}/bin/thatch`;
      const env = { ...ctx.env, THATCH_MODEL: "mock", THATCH_DB_PATH: dbPath };
      const flushInput = JSON.stringify({ session_id: "uc073-test", prompt: "fix the bug in the parser code" });
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
      slowServer.close();
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
