import { registerUseCase } from "../runner";

// UC-130: the thatch-review-adjudicate skill's verdict loop, exercised as a
// user working through a completed peer review of another author's branch.
// Live tier because the loop needs user turns: a verdict per finding, a bulk
// ruling, and the staged-draft contract (the agent stages, the user submits).
const useCase = {
  name: "UC-130-review-adjudicate",
  userDoc: "docs/user/code-review.md",
  preconditions: [
    "- An opencode session with the thatch plugin loaded",
    "- A fixture branch off main authored as another author's work (a small commit or two; a handful of reviewable findings across severities helps)",
    "- A completed synthesized review report of that branch (run the review pipeline first, or use a prior report)",
  ].join("\n"),
  steps: [
    "1. Ask the session to work through the review findings using thatch-review-adjudicate.",
    "2. Verify the walkthrough comes first: the changed workflows with counts (findings by severity and class, plus highlights and technique-notes counts), and NO individual finding presented yet.",
    "3. After you acknowledge, verify findings arrive one at a time, highest severity first, each in the finding template: Location, Shape, Description, and the verdict line on its own line.",
    "4. Give mixed verdicts: keep one (with a severity relabel on one), drop one, and reframe one; verify the reframe re-presents for a fresh verdict and the drop never re-surfaces later.",
    "5. On a later finding, exercise a bulk ruling (skip the rest) and verify every remaining finding plus the highlights and technique notes is dropped with it, then the session gives the final summary of what will be staged.",
    "6. Accept the staging offer and verify only the kept findings are staged as a draft review at their lines in the PR, and the session does NOT submit it.",
  ].join("\n"),
  expected: [
    "- The walkthrough precedes any individual finding, and all counts are announced up front.",
    "- Each finding uses the template (Location / Shape / Description) and ends with the verdict line.",
    "- Verdict semantics hold: a keep with a severity relabel wins under the new label, a drop is permanent for the round, a reframe re-presents, and a bulk drop takes the remainder plus highlights and technique notes.",
    "- Only kept findings are staged, at lines that match the PR branch (not the local tree), and the review is submitted by the user, never the session.",
    "- On a self-review or subordinate-work report instead, the skill declines to run the loop and routes findings over chat.",
  ].join("\n"),
};

registerUseCase(useCase);
