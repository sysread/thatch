import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-122: Review-mode commands (/thatch/self-review, /thatch/peer-review).
 *
 * Requires a live opencode session: the point is overlay efficacy, which
 * the mechanical checks (UC-106 step 5) cannot prove. The seeded fixture
 * plants one finding per mode rule; the live agent running the command
 * must surface the ones its mode weights and suppress the one its mode
 * bans.
 */

const useCase: UseCase = {
  name: "UC-122-review-mode-commands",
  userDoc: "docs/user/code-review.md",
  preconditions: [
    "- An opencode session in the thatch repo with the plugin loaded (the commands sync at plugin init)",
    "- A fixture branch off main with a small commit containing all four seeds below (create it if absent; keep the diff under ~50 lines so one review unit covers it)",
    "- Seed A (peer must report): a helper that reimplements something that already exists in the repo (e.g. a hand-rolled deep-clone next to an existing utility)",
    "- Seed B (peer must NOT report): a comment or finding-bait of the form 'if someone changes X in the future, this will silently break'",
    "- Seed C (self must report): an AI-slop comment (change narration or an em dash) plus a vague comment with no narrative link",
    "- Seed D (self must surface as a decision): a technique note - a simpler available design for part of the fixture",
  ].join("\n"),
  steps: [
    "1. Checkout the fixture branch and run /thatch/peer-review (no target argument, so it reviews the current branch).",
    "2. Verify the report weights for org velocity: Seed A appears as a finding naming the existing helper, with file:line evidence.",
    "3. Verify Seed B does NOT appear as a finding anywhere in the report (the future-change ban); a missing breadcrumb trail MAY be reported instead, framed for readers, not hypothetical misuse.",
    "4. Verify the memory walk ran: the report shows recalled project memory checked against the change (or an honest statement that recall returned nothing relevant).",
    "5. Run /thatch/self-review on the same branch.",
    "6. Verify the slop lens output leads the findings (Seed C) and Seed D is presented as an adopt-or-dismiss decision, not an informational aside.",
    "7. Fix the Seed C findings, then verify the round loop: the command runs a second round on the updated state and stops there (no third round when round two produces no meaningful findings).",
  ].join("\n"),
  expected: [
    "- peer-review reports the existing-helper finding (Seed A) with evidence and never reports the future-change trap (Seed B).",
    "- peer-review's report shows the memory walk over the touched area.",
    "- self-review leads with the reputation lenses (Seed C) and surfaces the simpler design as a decision (Seed D).",
    "- self-review iterates a second round after fixes and terminates at the first round with no meaningful findings (never more than three).",
    "- Both commands resolve the review target from the command text or default to the current branch, and cite file:line against the range head SHA.",
  ].join("\n"),
};

registerUseCase(useCase);
