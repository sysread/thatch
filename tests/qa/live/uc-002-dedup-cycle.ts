import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-002: Deduplication review cycle.
 *
 * Requires a live opencode session.
 */

const useCase: UseCase = {
  name: "UC-002-dedup-cycle",
  preconditions: [
    "- A store containing at least two memories with near-identical content",
    '  (e.g. save "the API rate limit is 100 req/min" twice under different labels)',
  ].join("\n"),
  steps: [
    "1. Ask the agent to check for duplicate memories.",
    "2. Agent calls `thatch_find_duplicates`; the similar pair is reported with a",
    "   score above the 0.85 default threshold.",
    "3. Agent loads the `thatch-dedup-classifier` skill and classifies the pair.",
    "4. For a true duplicate: agent merges content via",
    "   `thatch_memory_remember(overwrite: true)` on the better label and deletes",
    "   the other via `thatch_memory_forget`.",
    "5. For a false positive (unrelated/supplement/contradiction kept as-is):",
    "   agent records the verdict via `thatch_dedup_mark_checked`.",
    "6. Ask the agent to check for duplicates again.",
  ].join("\n"),
  expected: [
    "- After step 4 or 5, `thatch_find_duplicates` no longer reports the pair.",
    "- Overwriting either memory of a checked pair afterwards clears the verdict:",
    "  the pair becomes eligible for re-reporting.",
    "- Forgetting a memory clears all verdicts involving it.",
  ].join("\n"),
  // No custom run — uses default runViaOpencode.
};

registerUseCase(useCase);
