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
    "3. The coordinator gathers project context (PR description, git archaeology, TODO markers, thatch memories, docs).",
    "4. The coordinator researches affected workflows via thatch-code-archaeology.",
    "5. The coordinator estimates complexity and partitions the diff into review units.",
    "6. The coordinator dispatches specialist sub-agents in parallel — one per review unit.",
    "7. Each specialist produces findings in the standard format.",
    "8. The coordinator synthesizes all specialist findings into a final report.",
  ].join("\n"),
  expected: [
    "- The review target is resolved correctly (branch, PR, or range).",
    "- Project context is gathered and injected into specialist prompts.",
    "- Affected workflows are researched before partitioning.",
    "- The diff is partitioned into review units sized for a single sub-agent.",
    "- Specialists run in parallel and produce structured findings.",
    "- The synthesized report deduplicates findings, groups by severity, and leads with a workflow-change preface.",
  ].join("\n"),
  manualOnly: true,
};

registerUseCase(useCase);
