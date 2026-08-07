import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-011: Write-time similarity warning.
 *
 * Automatable: yes — the "save proceeds + warning lists similar entries" contract and both
 * reconciliation paths are pure tool/DB calls with no LLM in the loop.
 */

const useCase: UseCase = {
  name: "UC-011-write-time-similarity-warning",
  preconditions: [
    '- A store with a memory, e.g. `API rate limit` -> "the API rate limit is 100 req/min"',
    "- A second, similar memory not yet saved",
  ].join("\n"),
  steps: [
    "1. Save the second memory under a different label with similar content, without `overwrite: true`.",
    "2. Read the tool's response.",
  ].join("\n"),
  expected: [
    "- The save **succeeds** (`[saved] ...`) — the warning never blocks. The response also carries a warning listing the existing memory with a similarity score and instructions to reconcile.",
    "- Two reconciliation paths both work:",
    "  - Merge: `memory_remember` the merged content with `overwrite: true` on the better label, then `memory_forget` the other. The survivor has the combined content; the deleted label is gone.",
    "  - Mark distinct: `dedup_mark_checked` the pair as `unrelated`. A subsequent `find_duplicates` no longer reports the pair.",
  ].join("\n"),
  // No custom run — uses default runViaOpencode.
};

registerUseCase(useCase);
