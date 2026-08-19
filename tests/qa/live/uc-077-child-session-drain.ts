import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-077: Child session drain.
 *
 * Live session: requires opencode binary + VENICE_API_KEY. Needs
 * opencode session events to test the child-parent buffer drain.
 */

const useCase: UseCase = {
  name: "UC-077-child-session-drain",
  preconditions: [
    "- A parent session with pending interactions in the extraction buffer",
    "- A child session created by triggerExtraction with a snapshot of the parent's buffer",
    "- The tool.execute.after hook installed (calls consumeSnapshot on child memory writes)",
    "- Interleaved-turn entries added to the parent's buffer after the snapshot",
  ].join("\n"),
  steps: [
    "1. Simulate a parent session with 3 pending interactions in the extraction buffer.",
    "2. Create a child session and snapshot the parent's buffer (3 entries captured).",
    "3. Add 2 more interactions to the parent's buffer (interleaved-turn entries, not in snapshot).",
    "4. Simulate the child session calling thatch_memory_remember (triggers tool.execute.after).",
    "5. Verify consumeSnapshot removes only the 3 snapshot entries from the parent's buffer.",
    "6. Verify the 2 interleaved-turn entries remain in the parent's buffer.",
    "7. Simulate the child session going idle.",
    "8. Verify the child session is deleted via client.session.delete.",
    "9. Verify all maps for the child are cleaned up.",
  ].join("\n"),
  expected: [
    "- consumeSnapshot removes exactly the snapshot entries from the parent's pending buffer.",
    "- Interleaved-turn entries (added after the snapshot) survive the drain.",
    "- The child session is deleted after going idle.",
    "- All internal maps for the child are cleaned up.",
    "- completeAccepted(parentID) is called and missedNudges is reset.",
  ].join("\n"),
};

registerUseCase(useCase);
