import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-079: Child session deletion.
 *
 * Live session: requires opencode binary + VENICE_API_KEY. Needs
 * opencode session events to test the child-deletion requeue path.
 */

const useCase: UseCase = {
  name: "UC-079-child-session-deletion",
  preconditions: [
    "- A parent session with accepted entries",
    "- A child session created by triggerExtraction that is deleted before writing any memories",
    "- The session.deleted event handler installed",
  ].join("\n"),
  steps: [
    "1. Simulate a parent session with pending interactions.",
    "2. Simulate an extraction_done nudge accepting the entries.",
    "3. Create a child session and snapshot the parent's buffer.",
    "4. Simulate session.deleted for the child session.",
    "5. Verify requeueAccepted(parentID) is called — accepted entries move back to pending.",
    "6. Verify all maps for the child are cleaned up.",
    "7. Send a chat.message for the parent and verify the requeued entries appear in the next nudge.",
  ].join("\n"),
  expected: [
    "- requeueAccepted moves the parent's accepted entries back to pending.",
    "- The entries replay on the next extraction nudge.",
    "- All maps for the child are cleaned up.",
    "- The extracting flag for the parent is cleared.",
  ].join("\n"),
  manualOnly: true,
};

registerUseCase(useCase);
