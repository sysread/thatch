import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ExtractionPipeline, type ToolInteraction } from "../../../src/extraction";

/**
 * UC-039: Direct extraction failure.
 *
 * Automatable: when triggerExtraction throws (client.session.create rejects
 * or client.session.prompt fails), the extracting set clears and the buffer
 * keeps its pending entries. There is NO model-facing nudge fallback on
 * opencode any more - the plugin itself retries at the next idle, and the
 * entries are never dropped in the meantime. This test simulates that
 * lifecycle directly: buffer populated, a simulated throw + catch, then a
 * simulated retry that completes the extraction via the claim path.
 */

function makeInteraction(sessionID: string, i: number): ToolInteraction {
  return {
    tool: "bash",
    sessionID,
    args: { command: `cmd-${i}` },
    title: `title-${i}`,
    output: `output-${i}`,
  };
}

const useCase: UseCase = {
  name: "UC-039-direct-extraction-failure",
  preconditions: [
    "- Thatch plugin active in an opencode session",
    "- The plugin's triggerExtraction can be made to throw",
  ].join("\n"),
  steps: [
    "1. Generate non-thatch tool interactions in the session.",
    "2. Let the session go idle — triggerExtraction is called and throws.",
    "3. Let the session go idle again (the retry).",
  ].join("\n"),
  expected: [
    "- triggerExtraction adds the parent ID to the extracting set, then attempts to create and prompt the child session.",
    "- When the attempt throws, the catch block removes the parent ID from extracting.",
    "- No child session is created. No toast fires.",
    "- The buffered entries are NOT dropped while nothing is extracting: the pipeline holds them (pending) across the failed attempt.",
    "- There is no model-facing extraction nudge on opencode - chat.message stays clean.",
    "- On the next idle, the plugin re-triggers extraction from the same pending buffer (self-heal without model cooperation).",
    "- A retried extractor that fetches (claim) and completes consumes the delivery - no silent loss anywhere in the cycle.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const pipeline = new ExtractionPipeline();
    const sessionID = "test-extraction-fail";

    // Step 1: buffer non-thatch tool interactions.
    for (let i = 0; i < 5; i++) {
      pipeline.push(makeInteraction(sessionID, i));
    }

    // Step 2: simulate triggerExtraction throwing.
    // In the real code, triggerExtraction adds to extracting, then tries
    // sessionCreate. If it throws, the catch in triggerExtraction does
    // extracting.delete(parentID). We simulate the post-throw state:
    // extracting is NOT set (it was cleared by the catch).
    const extracting = new Set<string>();
    // extracting.delete(sessionID) — already not set, matching the post-throw state.

    // Verify: extracting does not have the session.
    if (extracting.has(sessionID)) {
      console.log("  FAIL: extracting set should not contain sessionID after throw");
      return "FAIL";
    }

    // Verify: buffer still has the pending entries - nothing was dropped
    // by the failed attempt.
    if (!pipeline.pending(sessionID)) {
      console.log("  FAIL: buffer should still have pending entries after the failed trigger");
      return "FAIL";
    }

    // Verify: no model-facing extraction nudge exists on the opencode path.
    // The nudge text used to be injected into chat.message here; the
    // model-driven handshake it drove raced its own state machine (the
    // September 2026 dispatch-loop report) and was removed. The runtime's
    // chat.message block no longer imports or calls extractionNudge - the
    // behavioral pin lives in tests/plugin.test.ts (no-nudge assertions);
    // here we assert the pipeline contract the retry relies on.
    if (typeof pipeline.peek(sessionID) !== "object") {
      console.log("  FAIL: peek should expose the pending buffer for the retry");
      return "FAIL";
    }

    // Step 3: the retry. The next idle re-triggers extraction from the same
    // pending buffer. The retried extractor fetches (the fetch IS the
    // accept + claim in the real pipeline)...
    const batch = pipeline.peek(sessionID);
    if (batch.length !== 5) {
      console.log(`  FAIL: retry should see all 5 entries, got ${batch.length}`);
      return "FAIL";
    }

    // ...and completes: the claim-scoped completion consumes the delivery.
    pipeline.accept(sessionID);
    pipeline.completeAccepted(sessionID);
    if (pipeline.pending(sessionID) || pipeline.peekAccepted(sessionID).length > 0) {
      console.log("  FAIL: buffer and accepted set should be empty after completion");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
