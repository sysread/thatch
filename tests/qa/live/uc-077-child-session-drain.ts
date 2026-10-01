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
    "2. Create an extraction child session (childToParent linked).",
    "3. The child calls thatch_get_extraction_payload — the fetch claims the 3 entries (accept + delivery record).",
    "4. Add 2 more interactions to the parent's buffer (interleaved-turn entries, arriving after the fetch).",
    "5. Simulate the child session calling thatch_memory_remember (triggers tool.execute.after).",
    "6. Verify completeClaimed consumes exactly the 3 claimed entries.",
    "7. Verify the 2 interleaved-turn entries remain pending in the parent's buffer.",
    "8. Simulate the child session going idle.",
    "9. Verify the child session is deleted via the host's delete capability (v1).",
    "10. Verify all maps for the child are cleaned up.",
  ].join("\n"),
  expected: [
    "- The child's memory write completes only the entries its fetch claimed (by reference identity).",
    "- Interleaved-turn entries (added after the fetch) survive and are extracted at the next idle.",
    "- The child session is deleted after going idle (v1; v2 has no delete capability — documented gap).",
    "- All internal maps for the child are cleaned up.",
    "- No whole-set completion ever fires: a child that never fetched (no claim) consumes nothing on memory write, ack, or idle.",
  ].join("\n"),
};

registerUseCase(useCase);
