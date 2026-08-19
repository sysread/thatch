import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-078: Child session error.
 *
 * Live session: requires opencode binary + VENICE_API_KEY. Needs
 * opencode session events to test the child-error requeue path.
 */

const useCase: UseCase = {
  name: "UC-078-child-session-error",
  preconditions: [
    "- A parent session with accepted entries (moved from pending to accepted by a prior extraction_done nudge)",
    "- A child session created by triggerExtraction that errors before writing any memories",
    "- The session.error event handler installed",
  ].join("\n"),
  steps: [
    "1. Simulate a parent session with pending interactions.",
    "2. Simulate an extraction_done nudge accepting the entries (moves them to accepted).",
    "3. Create a child session and snapshot the parent's buffer.",
    "4. Simulate session.error for the child session.",
    "5. Verify requeueAccepted(parentID) is called — accepted entries move back to pending.",
    "6. Verify all maps for the child are cleaned up.",
    "7. Send a chat.message for the parent and verify the requeued entries appear in the next nudge.",
  ].join("\n"),
  expected: [
    "- requeueAccepted moves the parent's accepted entries back to pending.",
    "- The entries replay on the next extraction nudge.",
    "- All maps for the child are cleaned up.",
    "- The extracting flag for the parent is cleared so the nudge pipeline resumes.",
  ].join("\n"),
  manualOnly: true,
};

registerUseCase(useCase);
