import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-038: No-save run.
 *
 * Live session: requires opencode binary + VENICE_API_KEY. The child
 * session runs the fact-extractor skill but finds nothing worth saving.
 * The parent's snapshot is still drained so entries do not replay.
 */

const useCase: UseCase = {
  name: "UC-038-no-save-run",
  preconditions: [
    "- Thatch plugin active in an opencode session with OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true",
    "- The session has buffered tool interactions that contain only routine operations (no durable facts)",
  ].join("\n"),
  steps: [
    "1. Do routine tool work: list files, read a config, run a harmless command — nothing that produces a durable fact worth remembering.",
    "2. Let the session go idle.",
    "3. The plugin calls triggerExtraction, creating a child session that runs thatch-fact-extractor.",
    "4. The child evaluates the payload and determines nothing is worth saving.",
    "5. The child calls thatch_extraction_done (the skill's final step).",
  ].join("\n"),
  expected: [
    "- The child does NOT call thatch_memory_remember.",
    "- The child calls thatch_extraction_done, which completes the parent's accepted entries and drains the snapshot.",
    "- When the child goes idle, the parent's snapshot entries are drained.",
    "- The child session is deleted.",
    "- A toast fires: [thatch] extraction complete — nothing to save.",
    "- On the next chat.message, no extraction nudge appears — the buffer is empty.",
    "- The parent's missedNudges counter is reset.",
  ].join("\n"),
};

registerUseCase(useCase);
