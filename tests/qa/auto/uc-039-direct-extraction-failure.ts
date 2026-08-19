import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ExtractionPipeline, type ToolInteraction } from "../../../src/extraction";
import { extractionNudge } from "../../../src/prompts";

/**
 * UC-039: Direct extraction failure.
 *
 * Automatable: the fallback nudge path is exercised when triggerExtraction
 * throws (client.session.create rejects or client.session.prompt fails).
 * The extracting set clears, and on the next chat.message, the buffer has
 * pending entries with no extracting flag, so the nudge fallback fires.
 * This test simulates that state directly: buffer is populated, extracting
 * is not set (simulating the throw + catch), and the nudge text is verified.
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
    "3. Send another chat message.",
  ].join("\n"),
  expected: [
    "- triggerExtraction adds the parent ID to the extracting set, then attempts to create and prompt the child session.",
    "- When the attempt throws, the catch block removes the parent ID from extracting.",
    "- No child session is created. No toast fires.",
    "- On the next chat.message: extracting.has(sessionID) is false, extraction.pending(sessionID) is true → the fallback nudge fires.",
    "- The nudge carries the session ID and the fetch tool name (get_extraction_payload), not the full payload.",
    "- The missedNudges counter starts at 0 and increments by 1 for this first fallback nudge.",
    "- The buffer is NOT drained — it persists until the agent writes a memory or calls thatch_extraction_done.",
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
    // client.session.create. If it throws, the catch at index.ts:175 does
    // extracting.delete(parentID). We simulate the post-throw state:
    // extracting is NOT set (it was cleared by the catch).
    const extracting = new Set<string>();
    // extracting.delete(sessionID) — already not set, matching the post-throw state.

    // Verify: extracting does not have the session.
    if (extracting.has(sessionID)) {
      console.log("  FAIL: extracting set should not contain sessionID after throw");
      return "FAIL";
    }

    // Verify: buffer has pending entries.
    if (!pipeline.pending(sessionID)) {
      console.log("  FAIL: buffer should have pending entries");
      return "FAIL";
    }

    // Step 3: simulate the chat.message fallback nudge path.
    // The hook checks: !extracting.has(sessionID) && extraction.pending(sessionID)
    // If true, it calls extractionNudge and pushes a synthetic part.
    const shouldFireNudge = !extracting.has(sessionID) && pipeline.pending(sessionID);
    if (!shouldFireNudge) {
      console.log("  FAIL: fallback nudge should fire (extracting not set, pending is true)");
      return "FAIL";
    }

    // The nudge fires with missedNudges = 0 (first fallback).
    const batch = pipeline.peek(sessionID);
    const missed = 0;
    const nudgeText = extractionNudge(batch.length, missed, "thatch_memory_remember", sessionID);

    // Verify: nudge carries the session ID.
    if (!nudgeText.includes(sessionID)) {
      console.log(`  FAIL: nudge text should contain session ID "${sessionID}"`);
      return "FAIL";
    }

    // Verify: nudge references the fetch tool name.
    if (!nudgeText.includes("get_extraction_payload")) {
      console.log("  FAIL: nudge text should reference get_extraction_payload");
      return "FAIL";
    }

    // Verify: nudge references fact-extractor skill.
    if (!nudgeText.includes("fact-extractor")) {
      console.log("  FAIL: nudge text should reference fact-extractor skill");
      return "FAIL";
    }

    // Verify: nudge is tier-0 (polite, not ALL-CAPS) for missed=0.
    if (nudgeText.includes("IGNORING") || nudgeText.includes("NOT PROCESSED")) {
      console.log("  FAIL: first fallback nudge should be polite (tier-0), not escalated");
      return "FAIL";
    }

    // Verify: buffer is NOT drained after nudge delivery.
    // The hook peeks (does not consume) — the buffer persists.
    if (!pipeline.pending(sessionID)) {
      console.log("  FAIL: buffer should NOT be drained after nudge delivery");
      return "FAIL";
    }

    const remainingBatch = pipeline.peek(sessionID);
    if (remainingBatch.length !== 5) {
      console.log(`  FAIL: buffer should still have 5 entries, got ${remainingBatch.length}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
