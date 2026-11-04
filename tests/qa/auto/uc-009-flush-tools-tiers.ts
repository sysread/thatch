import { join } from "node:path";
import { $ } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-009: flush-tools tier priority and sideband degradation.
 *
 * Automatable: `flush-tools` is a deterministic CLI contract and sideband
 * failure modes (server down, stale socket, timeout) plus tier ordering are
 * filesystem/IPC only, with no LLM in the loop. This test exercises the three
 * priority tiers via the CLI: extraction (queue non-empty), write (fallback
 * when queue empty and no sideband server), and --json wrapping.
 */

const useCase: UseCase = {
  name: "UC-009-flush-tools-tiers",
  preconditions: [
    "- A Claude Code / Cursor session; `.mcp.json` and hooks installed",
    "- At least one memory for the recall tier to match",
    "- For the failure modes: a way to stop the MCP server and to leave a stale socket file",
  ].join("\n"),
  steps: [
    "1. Put buffered non-thatch tool interactions in the queue (via `buffer-tool` / `buffer-batch`), then run `thatch flush-tools --json`.",
    "2. With the queue empty and the MCP server running, send a prompt matching a memory (recall tier), then a prompt below threshold.",
    "3. Stop the MCP server; run `flush-tools` with an empty queue.",
    "4. Leave a stale socket file from a crashed MCP server; run `flush-tools`.",
    "5. Make the sideband server hang (> 2 s); run `flush-tools`.",
  ].join("\n"),
  expected: [
    "- Tiers fire in strict priority — **extraction > recall > write** — at most one nudge per call:",
    "  - extraction: queue non-empty -> nudge. Claude Code (session_id): the",
    "    INLINE nudge - processing instructions + the full payload printed",
    "    with the session ID, no sub-agent, no fetch tool. Cursor",
    "    (conversation_id): the DISPATCH nudge - session ID and fetch tool",
    "    name for the dispatched extractor. The queue is peeked, not deleted;",
    "    it persists until a memory write or the host's ack (drains via",
    "    `consumeQueue` in `appendBatch`).",
    "  - recall: queue empty, socket live, match at or above `THATCH_RECALL_THRESHOLD` (default 0.55) -> nudge with match labels; below threshold -> no nudge.",
    '  - write: socket unavailable, no matches, or socket error -> static "did you learn anything worth persisting?" nudge.',
    "- Sideband failure **never blocks** the agent: server down, a stale socket file, and a > 2 s timeout all degrade to the write nudge. A stale socket file left by a crash is cleaned up on connection error.",
    "- `--json` wraps whichever nudge fires for Cursor's `additional_context`; plain stdout for Claude Code.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env, THATCH_MODEL: "mock" };

    // Tier 3: empty queue, no sideband server, prompt >= 10 chars.
    // sidebandMatch/sidebandPredictions return null on connection failure,
    // so the code falls through to the static write nudge.
    const writeInput = JSON.stringify({ session_id: "uc009-write", prompt: "What is the meaning of life?" });
    const writeResult = await $`echo ${writeInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (writeResult.exitCode !== 0) {
      console.log("  FAIL: write nudge tier exited non-zero");
      return "FAIL";
    }
    const writeOut = writeResult.stdout.toString();
    if (!writeOut.includes("did you learn")) {
      console.log(`  FAIL: write nudge tier output unexpected: ${writeOut.slice(0, 200)}`);
      return "FAIL";
    }

    // Tier 1 (Claude Code, inline): seed the queue via buffer-batch, then
    // flush-tools. The extraction nudge should fire (priority over
    // recall/write) with the PAYLOAD printed inline - no sub-agent, no
    // fetch tool.
    const batchInput = JSON.stringify({
      session_id: "uc009-extract",
      tool_calls: [{
        tool_name: "Read",
        tool_input: { path: "/foo/bar" },
        tool_response: "file contents here",
      }],
    });
    await $`echo ${batchInput} | ${bin} buffer-batch`.env(env).quiet().nothrow();

    const flushInput = JSON.stringify({ session_id: "uc009-extract", prompt: "What is the meaning of life?" });
    const extractResult = await $`echo ${flushInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (extractResult.exitCode !== 0) {
      console.log("  FAIL: extraction tier exited non-zero");
      return "FAIL";
    }
    const extractOut = extractResult.stdout.toString();
    if (!extractOut.includes("fact-extractor") || !extractOut.includes("queued tool interaction")) {
      console.log(`  FAIL: extraction tier output unexpected: ${extractOut.slice(0, 200)}`);
      return "FAIL";
    }
    if (!extractOut.includes("uc009-extract") || !extractOut.includes('"interactions"')) {
      console.log(`  FAIL: the inline nudge should carry the session ID and the payload: ${extractOut.slice(0, 200)}`);
      return "FAIL";
    }
    if (extractOut.includes("Spawn a background sub-agent") || extractOut.includes("get_extraction_payload")) {
      console.log("  FAIL: the inline nudge must not dispatch or name a fetch tool");
      return "FAIL";
    }

    // Tier 1 (Cursor, dispatched): same queue contract, different delivery
    // shape - the nudge carries the session ID and fetch tool name for the
    // dispatched extractor (Cursor's hooks have no inline-payload delivery).
    const cursorBatch = JSON.stringify({
      conversation_id: "uc009-cursor",
      tool_name: "Read",
      tool_input: { path: "/foo/bar" },
      tool_response: "file contents here",
    });
    await $`echo ${cursorBatch} | ${bin} buffer-tool`.env(env).quiet().nothrow();
    const cursorFlush = JSON.stringify({ conversation_id: "uc009-cursor", prompt: "What is the meaning of life?" });
    const cursorResult = await $`echo ${cursorFlush} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (cursorResult.exitCode !== 0) {
      console.log("  FAIL: Cursor extraction tier exited non-zero");
      return "FAIL";
    }
    const cursorOut = cursorResult.stdout.toString();
    if (!cursorOut.includes("uc009-cursor") || !cursorOut.includes("get_extraction_payload") || !cursorOut.includes("Spawn a background sub-agent")) {
      console.log(`  FAIL: Cursor's dispatch nudge should name the session, the sub-agent, and the fetch tool: ${cursorOut.slice(0, 200)}`);
      return "FAIL";
    }

    // --json mode wraps output as { additional_context: "..." }.
    const jsonInput = JSON.stringify({ session_id: "uc009-json", prompt: "What is the meaning of life?" });
    const jsonResult = await $`echo ${jsonInput} | ${bin} flush-tools --json`.env(env).quiet().nothrow();
    if (jsonResult.exitCode !== 0) {
      console.log("  FAIL: --json mode exited non-zero");
      return "FAIL";
    }
    const jsonOut = jsonResult.stdout.toString();
    try {
      const parsed = JSON.parse(jsonOut);
      if (!parsed.additional_context || !parsed.additional_context.includes("did you learn")) {
        console.log("  FAIL: --json mode did not wrap output as additional_context");
        return "FAIL";
      }
    } catch {
      console.log("  FAIL: --json mode did not produce valid JSON");
      return "FAIL";
    }

    // Skew gate: a stale SERVER version file (the hook binary is fresh)
    // suppresses the extraction nudge - the old server's compiled tool
    // list may lack the tools the nudge names (extraction_done included,
    // on either delivery shape) - and emits the restart instruction
    // instead. The queue survives (peek-not-drain) and the extraction
    // nudge returns once the version file matches.
    //
    // The version file lives under tmpdir() - which is NOT stable across
    // the env-replacing subprocess boundary: the test process resolves
    // TMPDIR (macOS: /var/folders/...) while the `.env(env)` subprocess
    // (no TMPDIR) resolves /tmp. Stamp BOTH candidate bases so the hook
    // finds the file whichever side computes the path.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(ctx.env.THATCH_DB_PATH).digest("hex").slice(0, 16);
    const stampSkew = (version: string) => {
      for (const base of new Set([tmpdir(), "/tmp"])) {
        const dir = join(base, `thatch-${hash}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "version"), `${version}\n`);
      }
    };
    const clearSkew = () => {
      for (const base of new Set([tmpdir(), "/tmp"])) rmSync(join(base, `thatch-${hash}`, "version"), { force: true });
    };
    stampSkew("0.0.1");
    const skewResult = await $`echo ${flushInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (skewResult.exitCode !== 0) {
      console.log("  FAIL: skew-gated flush-tools exited non-zero");
      return "FAIL";
    }
    const skewOut = skewResult.stdout.toString();
    if (!skewOut.includes("MCP server is stale") || !skewOut.toLowerCase().includes("restart")) {
      console.log(`  FAIL: skew should emit the restart instruction: ${skewOut.slice(0, 200)}`);
      return "FAIL";
    }
    if (skewOut.includes("get_extraction_payload")) {
      console.log("  FAIL: skew must not reference the fetch tool the old server may lack");
      return "FAIL";
    }
    clearSkew();
    const postFix = await $`echo ${flushInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
    const postFixOut = postFix.stdout.toString();
    if (!postFixOut.includes("queued tool interaction") || !postFixOut.includes("uc009-extract")) {
      console.log("  FAIL: the extraction nudge should return once the skew clears");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
