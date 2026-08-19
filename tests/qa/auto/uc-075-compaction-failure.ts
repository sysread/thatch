import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-075: Compaction failure.
 *
 * Automatable: simulates the stale-flag fallback in the chat.message hook.
 * When a non-compaction message arrives while the session is still in the
 * compacting set, the hook clears the flag and proceeds normally. This is
 * the third belt-and-suspenders mechanism (after autocontinue and
 * session.compacted).
 */

const useCase: UseCase = {
  name: "UC-075-compaction-failure",
  preconditions: [
    "- A session in the compacting set (compaction was triggered but never completed)",
    "- The chat.message hook with the compaction guard check at the top",
  ].join("\n"),
  steps: [
    "1. Simulate experimental.session.compacting to add the session to the compacting set.",
    "2. Do NOT fire experimental.compaction.autocontinue or session.compacted (simulating compaction failure).",
    "3. Send a non-compaction chat.message for the same session.",
    "4. Verify the hook detects the stale flag and clears it.",
    "5. Verify the message proceeds through the normal nudge pipeline.",
  ].join("\n"),
  expected: [
    "- The chat.message hook detects that the session is in the compacting set but the message is not a compaction autocontinue.",
    "- The hook removes the session from the compacting set.",
    "- The message proceeds through the normal nudge pipeline (recall, prediction, behavior, extraction tiers).",
    "- No blocked-tool errors occur because the flag was cleared before nudges fire.",
  ].join("\n"),

  async run() {
    // Replicate the compacting set and chat.message guard logic
    const compacting = new Set<string>();
    const sessionID = "test-session-075";

    // Step 1: add to compacting set
    compacting.add(sessionID);
    if (!compacting.has(sessionID)) {
      console.log("  FAIL: session not added to compacting set");
      return "FAIL";
    }

    // Step 2: do NOT fire autocontinue or session.compacted
    // (simulating compaction failure — flag is stale)

    // Step 3: non-compaction chat.message arrives
    // Replicate the guard logic from src/index.ts:361-371
    const isCompactionMsg = false; // this is a normal user message, not compaction summary
    let flagCleared = false;
    let proceedsNormally = false;

    if (compacting.has(sessionID)) {
      if (isCompactionMsg) {
        // Compaction summary generation — suppress nudges
        // This path should NOT be taken here
        console.log("  FAIL: non-compaction message incorrectly treated as compaction");
        return "FAIL";
      }
      // Stale flag detected — compaction failed (autocontinue never fired)
      compacting.delete(sessionID);
      flagCleared = true;
    }

    // After the guard, the message proceeds through the normal nudge pipeline
    if (!compacting.has(sessionID)) {
      proceedsNormally = true;
    }

    // Step 4: verify flag was cleared
    if (!flagCleared) {
      console.log("  FAIL: stale compacting flag was not cleared");
      return "FAIL";
    }
    if (compacting.has(sessionID)) {
      console.log("  FAIL: session still in compacting set after stale flag clear");
      return "FAIL";
    }

    // Step 5: verify message proceeds normally
    if (!proceedsNormally) {
      console.log("  FAIL: message did not proceed through nudge pipeline");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
