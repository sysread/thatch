import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-080: Parent session deletion.
 *
 * Live session: requires opencode binary + VENICE_API_KEY. Needs
 * opencode session events to test the parent-deletion complete path.
 */

const useCase: UseCase = {
  name: "UC-080-parent-session-deletion",
  preconditions: [
    "- A parent session with accepted entries",
    "- The session.deleted event handler installed",
  ].join("\n"),
  steps: [
    "1. Simulate a parent session with pending interactions.",
    "2. Simulate an extraction_done nudge accepting the entries.",
    "3. Simulate session.deleted for the parent session.",
    "4. Verify completeAccepted(parentID) is called — accepted entries are dropped (not requeued).",
    "5. Verify the extracting flag is cleared for the parent.",
    "6. Verify all maps referencing the parent are cleaned up.",
  ].join("\n"),
  expected: [
    "- completeAccepted drops the parent's accepted entries. They are not requeued to pending.",
    "- The extracting flag is cleared.",
    "- No orphaned state remains in missedNudges, parentSnapshots, or other maps referencing the parent.",
    "- Unlike child deletion (requeueAccepted), parent deletion uses completeAccepted because there is no session to replay into.",
  ].join("\n"),
  manualOnly: true,
};

registerUseCase(useCase);
