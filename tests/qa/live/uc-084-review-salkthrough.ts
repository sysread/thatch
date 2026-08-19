import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-084: Review solo.
 *
 * Live session: requires a host that can load skills. On hosts without
 * sub-agent support (Claude Code, Cursor), load a specialist skill
 * directly and run the review in the main session.
 */

const useCase: UseCase = {
  name: "UC-084-review-salkthrough",
  userDoc: "docs/user/code-review.md",  preconditions: [
    "- A host that can load skills (Claude Code, Cursor, or opencode without sub-agents)",
    "- A branch with changes to review",
    "- At least one specialist skill installed (e.g., thatch-review-pedantic, thatch-review-state-flow)",
  ].join("\n"),
  steps: [
    "1. Load a specialist skill directly (e.g., thatch-review-pedantic).",
    "2. Point the skill at the branch or commit range to review.",
    "3. The specialist runs its review pass and produces findings in the standard format.",
    "4. Repeat with additional specialists (one at a time, since there are no sub-agents).",
    "5. Load the thatch-review-synthesizer skill manually.",
    "6. Feed all specialist findings to the synthesizer.",
    "7. The synthesizer produces the final deduplicated, severity-grouped report.",
  ].join("\n"),
  expected: [
    "- Each specialist produces structured findings when run in the main session.",
    "- The standard format is the same as when dispatched by the coordinator.",
    "- The synthesizer aggregates findings from multiple specialists run in sequence.",
    "- The final report is equivalent to what the coordinator would produce, minus the parallelism.",
  ].join("\n"),
  manualOnly: true,
};

registerUseCase(useCase);
