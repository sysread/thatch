import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-086: Review response.
 *
 * Live session: requires a PR with incoming review comments. The
 * review-response skill triages findings, fixes bugs, drafts replies,
 * and posts a top-level summary.
 */

const useCase: UseCase = {
  name: "UC-086-review-response",
  preconditions: [
    "- A PR with incoming review comments from another reviewer",
    "- The thatch-review-response skill installed and loadable",
    "- Write access to the PR branch (to push fixes)",
  ].join("\n"),
  steps: [
    "1. Load the thatch-review-response skill.",
    "2. The skill reads all review comments on the PR.",
    "3. Triage each finding: legitimate, intentional, false positive, unlikely edge case.",
    "4. Collapse comments sharing a root cause into a single fix.",
    "5. Fix legitimate bugs one by one, committing each fix.",
    "6. Draft per-thread replies.",
    "7. Post a top-level summary comment categorizing all findings and the resolution for each.",
  ].join("\n"),
  expected: [
    "- Each finding is triaged into one of the four categories.",
    "- Comments with a shared root cause are collapsed — one fix resolves all of them.",
    "- Fixes are committed individually so the author can review each change.",
    "- Per-thread replies are drafted and posted.",
    "- The top-level summary gives the reviewer a clear picture of what was addressed and how.",
    "- Responses on behalf of the user are prefixed with 'Landru is thinking on behalf of Jeff:'.",
  ].join("\n"),
};

registerUseCase(useCase);
