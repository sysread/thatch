import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-083: Review coordinator.
 *
 * Live session: requires opencode with sub-agent support. The coordinator
 * dispatches parallel specialist sub-agents for a full multi-agent review.
 */

const useCase: UseCase = {
  name: "UC-083-review-coordinator",
  userDoc: "docs/user/code-review.md",  preconditions: [
    "- opencode with sub-agent support (the coordinator dispatches parallel specialists)",
    "- A branch, PR, or commit range with changes to review",
    "- The thatch-code-review skill installed and loadable",
  ].join("\n"),
  steps: [
    "1. Load the thatch-code-review skill.",
    "2. The coordinator resolves the review target — branch name, PR number, or explicit range.",
    "3. The coordinator gathers project context (PR description, git archaeology, TODO markers, links to docs/designs/tickets followed from the change, related PRs discovered as stack members or release-train siblings, staleness check against post-merge-base main, thatch memories, docs).",
    "4. The coordinator researches affected workflows via thatch-code-archaeology.",
    "5. The coordinator estimates complexity and partitions the diff into review units.",
    "6. The coordinator dispatches specialist sub-agents in parallel — one per review unit.",
    "7. Each specialist produces findings in the standard format.",
    "8. The coordinator synthesizes all specialist findings into a final report.",
  ].join("\n"),
  expected: [
    "- The review target is resolved correctly (branch, PR, or range).",
    "- Project context is gathered and injected into specialist prompts.",
    "- When the change belongs to a stack or release train, the sibling register is built with targeted consistency verdicts, injected into specialist prompts, and cross-referenced at synthesis (a missing piece delivered by a sibling PR is not reported as a defect).",
    "- Affected workflows are researched before partitioning.",
    "- The diff is partitioned into review units sized for a single sub-agent.",
    "- Specialists run in parallel and produce structured findings.",
    "- The synthesized report deduplicates findings, groups by severity, and leads with a workflow-change preface.",
    "- When main has moved past the merge-base touching the same paths, behavioral findings are re-verified against current main and merge-base-only findings are reported as rebase notes rather than defects.",
  ].join("\n"),
  manualOnly: true,
};

registerUseCase(useCase);
