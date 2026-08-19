import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-085: Review followup.
 *
 * Live session: requires a PR with prior review comments. After the
 * author responds or pushes changes, the followup skill verifies whether
 * prior findings were adequately addressed.
 */

const useCase: UseCase = {
  name: "UC-085-review-followup",
  preconditions: [
    "- A PR with prior review comments from a previous review round",
    "- The author has responded to comments or pushed new commits",
    "- The thatch-review-followup skill installed and loadable",
  ].join("\n"),
  steps: [
    "1. Load the thatch-review-followup skill.",
    "2. The skill reads prior review comments and the current diff.",
    "3. For each prior finding, verify whether it was addressed: fixed in code, proven not a concern, or filed as a follow-up ticket.",
    "4. For resolved findings, offer to reply on the thread.",
    "5. For unresolved findings, flag them for re-attention.",
    "6. If the changes since the last review are substantial, optionally hand off to thatch-code-review for a fresh round.",
  ].join("\n"),
  expected: [
    "- Each prior finding is classified as addressed, not-addressed, or partially-addressed.",
    "- Resolved findings get a reply drafted on the thread.",
    "- Unresolved findings are surfaced for re-attention.",
    "- The optional handoff to the coordinator is offered only when the new changes are substantial enough.",
    "- The followup does not re-run findings that were already dismissed as false positives in the prior round.",
  ].join("\n"),
  manualOnly: true,
};

registerUseCase(useCase);
