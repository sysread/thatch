import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-043: Compaction suppression.
 *
 * Live session: requires opencode binary + VENICE_API_KEY. Needs a
 * compaction trigger (fill the context window). All nudges are suppressed
 * while the session is in the compacting set.
 */

const useCase: UseCase = {
  name: "UC-043-compaction-suppression",
  preconditions: [
    "- Thatch plugin active in an opencode session",
    "- A session with enough context to trigger compaction (opencode's context window limit)",
  ].join("\n"),
  steps: [
    "1. Fill the session context until opencode triggers compaction (the experimental.session.compacting hook fires).",
    "2. Send a message while the session is marked as compacting.",
    "3. Observe whether nudges fire.",
    "4. The compaction summary message arrives (has a compaction-type part).",
    "5. After compaction completes (experimental.compaction.autocontinue fires), send another message.",
  ].join("\n"),
  expected: [
    "- While compacting.has(sessionID) is true, the chat.message hook checks for compaction. If the message is the compaction summary itself, nudges are suppressed.",
    "- If the message is NOT a compaction message, the stale flag is cleared and nudges proceed normally.",
    "- After experimental.compaction.autocontinue clears the flag, nudges fire normally on subsequent messages.",
  ].join("\n"),
};

registerUseCase(useCase);
