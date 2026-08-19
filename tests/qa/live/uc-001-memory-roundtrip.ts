import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-001: Remember and recall across sessions.
 *
 * Requires a live opencode session — the agent needs to call thatch tools
 * and respond to natural language. Uses the default runViaOpencode helper.
 *
 * Note: "End the session, start a fresh session" (step 3) cannot be done
 * literally inside a single `opencode run --auto` call. The agent should
 * simulate it by closing the ThatchDB instance and opening a new one to
 * the same THATCH_DB_PATH file, or by running a script that does so.
 */

const useCase: UseCase = {
  name: "UC-001-memory-roundtrip",
  preconditions: [
    "- thatch configured as a plugin in opencode (npm or local path)",
    "- Working directory is a git repo with an origin remote",
  ].join("\n"),
  steps: [
    '1. In an opencode session, ask the agent to remember a distinctive fact, e.g.',
    '   "remember that our staging DB lives at staging-db.internal:5432".',
    "2. Confirm the agent calls `thatch_memory_remember` and reports `[saved]`.",
    "3. Simulate a fresh session: close the DB connection and open a new ThatchDB",
    "   instance to the same THATCH_DB_PATH file (or run a script that does this).",
    '4. In the fresh DB context, query for the saved fact: "where does staging data live?"',
  ].join("\n"),
  expected: [
    "- The agent calls `thatch_memory_recall` and surfaces the saved fact with a",
    "  similarity score.",
    "- `thatch list` (CLI) shows the memory in the repo's store (named",
    "  `owner/repo` from the git remote), not in `global`.",
    "- Saving the same label again without `overwrite: true` is rejected with an",
    "  error naming the label and store.",
  ].join("\n"),
};

registerUseCase(useCase);
