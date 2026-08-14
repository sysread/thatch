import { $ } from "bun";
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
    "  - extraction: queue non-empty -> nudge with session ID and fetch tool name. The queue is peeked, not deleted; it persists until a memory write or `extraction_done` (drains via `consumeQueue` in `appendBatch`).",
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

    // Tier 1: seed the queue via buffer-batch, then flush-tools.
    // The extraction nudge should fire (priority over recall/write).
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
    if (!extractOut.includes("uc009-extract") || !extractOut.includes("get_extraction_payload")) {
      console.log(`  FAIL: extraction tier should include session ID and fetch tool name: ${extractOut.slice(0, 200)}`);
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

    return "PASS";
  },
};

registerUseCase(useCase);
