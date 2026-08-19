import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-044: Tier priority.
 *
 * Automatable: the tier ordering in flush-tools is a deterministic CLI
 * contract. When the extraction queue is non-empty, tier 1 fires and
 * returns early — tiers 2–4 (recall, prediction, behavior) are skipped.
 * This test seeds the queue via buffer-batch, verifies the extraction nudge
 * fires, then consumes the queue and verifies it does NOT fire again.
 */

const useCase: UseCase = {
  name: "UC-044-tier-priority",
  preconditions: [
    "- A Claude Code / Cursor session with flush-tools hooks installed",
    "- THATCH_QUEUE_DIR set to an isolated temp directory",
    "- At least one stored memory that would match the test prompt (to verify it does NOT fire)",
  ].join("\n"),
  steps: [
    "1. Seed the extraction queue with non-thatch tool interactions (via buffer-batch).",
    "2. Run thatch flush-tools with a prompt that would match a stored memory.",
    "3. Verify the output is the extraction nudge only.",
    "4. Consume the queue (via buffer-batch with mcp__thatch__memory_remember).",
    "5. Run flush-tools again with the same prompt.",
    "6. Verify the extraction nudge does NOT fire (queue is empty).",
  ].join("\n"),
  expected: [
    "- Step 3: the output contains the extraction nudge (references fact-extractor, queued tool interaction, the session ID, and get_extraction_payload). It does NOT contain recall match labels.",
    "- Step 5–6: with the queue empty, tier 1 is skipped. The sideband tier is attempted (no server → falls through to write nudge).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env, THATCH_MODEL: "mock" };
    const sessionID = "uc044-tier-test";

    // Step 1: seed the queue via buffer-batch.
    const batchInput = JSON.stringify({
      session_id: sessionID,
      tool_calls: [{
        tool_name: "Read",
        tool_input: { path: "/foo/bar" },
        tool_response: "file contents here",
      }],
    });
    await $`echo ${batchInput} | ${bin} buffer-batch`.env(env).quiet().nothrow();

    // Step 2: run flush-tools with a matching prompt.
    const flushInput = JSON.stringify({ session_id: sessionID, prompt: "fix the bug in the parser code" });
    const extractResult = await $`echo ${flushInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (extractResult.exitCode !== 0) {
      console.log("  FAIL: tier 1 flush-tools exited non-zero");
      return "FAIL";
    }
    const extractOut = extractResult.stdout.toString();

    // Step 3: verify extraction nudge fired.
    if (!extractOut.includes("fact-extractor") || !extractOut.includes("queued tool interaction")) {
      console.log(`  FAIL: tier 1 should fire extraction nudge, got: ${extractOut.slice(0, 200)}`);
      return "FAIL";
    }
    if (!extractOut.includes(sessionID) || !extractOut.includes("get_extraction_payload")) {
      console.log(`  FAIL: extraction nudge should include session ID and fetch tool, got: ${extractOut.slice(0, 200)}`);
      return "FAIL";
    }

    // Verify it does NOT contain recall nudge elements (no "relates to" or memory labels).
    if (extractOut.includes("relates to") || extractOut.includes("memory_recall")) {
      console.log("  FAIL: tier 1 should not contain recall nudge elements");
      return "FAIL";
    }

    // Step 4: consume the queue by sending a memory_remember call.
    const drainInput = JSON.stringify({
      session_id: sessionID,
      tool_calls: [{
        tool_name: "mcp__thatch__memory_remember",
        tool_input: {},
        tool_response: "saved",
      }],
    });
    await $`echo ${drainInput} | ${bin} buffer-batch`.env(env).quiet().nothrow();

    // Step 5: run flush-tools again with the same prompt.
    const flushInput2 = JSON.stringify({ session_id: sessionID, prompt: "fix the bug in the parser code" });
    const postResult = await $`echo ${flushInput2} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (postResult.exitCode !== 0) {
      console.log("  FAIL: post-drain flush-tools exited non-zero");
      return "FAIL";
    }
    const postOut = postResult.stdout.toString();

    // Step 6: verify extraction nudge does NOT fire (queue is empty).
    if (postOut.includes("fact-extractor") || postOut.includes("queued tool interaction")) {
      console.log(`  FAIL: extraction nudge should NOT fire with empty queue, got: ${postOut.slice(0, 200)}`);
      return "FAIL";
    }

    // With no sideband server, it should fall through to the write nudge.
    if (!postOut.includes("did you learn")) {
      console.log(`  FAIL: post-drain should produce write nudge, got: ${postOut.slice(0, 200)}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
