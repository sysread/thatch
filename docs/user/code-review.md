# Code Review

Thatch ships a multi-agent code review pipeline. Eight specialist
review lenses run in parallel, then a synthesizer verifies and
deduplicates their findings into a single report.

## How it works

The coordinator skill (`thatch-code-review`, opencode-only) orchestrates
the review:

1. **Resolve the target**: fetch origin, compute merge-base against
   `origin/main`, support branch/PR/explicit range. All file reads and
   comment anchors are computed against the PR head ref, not the
   working tree, which may be checked out on a different branch.
2. **Gather project context**: PR descriptions, git archaeology,
   ticket references, links to docs/designs/tickets found in the
   change (followed one hop for scope and design context), TODO
   markers, prior reviews, project memory. Also checks whether main
   has moved past the merge-base touching the same paths — a stale
   branch can make findings true only at the merge-base.
3. **Research affected workflows**: load `thatch-code-archaeology`,
   trace the code paths the change touches.
4. **Estimate complexity**: partition the diff into review units.
5. **Dispatch specialists**: fan out the eight specialists as
   parallel sub-agents, each with the context brief.
6. **Synthesize**: the synthesizer reads all specialist output,
   verifies each finding (cited text exists, claim is accurate,
   severity is justified), deduplicates by root cause, and produces
   the final report. When the branch is stale relative to main, it
   re-verifies behavioral findings against current main and reports
   merge-base-only findings as rebase notes rather than defects.

## The eight specialists

| Skill | What it checks |
|-------|-------------|
| `thatch-review-pedantic` | Spelling, naming, doc accuracy, specs, guidelines, stale artifacts, structural conventions (file/directory placement). |
| `thatch-review-acceptance` | UX coherency, behavioral delta, integration effects, user assumptions. |
| `thatch-review-state-flow` | Module boundaries, implicit state machines, error propagation, separation of concerns. |
| `thatch-review-economy` | Design simplicity and maintainability: is the complexity earned? Evaluates both the overall change design (forest) and individual touch points (trees) for unnecessary complexity, redundancy, and simpler available alternatives. |
| `thatch-review-no-slop` | AI writing anti-patterns: change narration, fourth wall breaks, em dashes, hedging, filler. |
| `thatch-review-breadcrumbs` | Comment narrative: do comments form a coherent outline of the code's behavior? |
| `thatch-review-mark-and-sweep` | Mechanical change completeness: whole-repo sweep for stragglers after renames, flag removals, API substitutions. |
| `thatch-review-highlights` | Positive finding detection: clever solutions, cleanup done along the way, documentation that helps. Medium-high bar. |

Each specialist is a self-contained static-analysis pass. They can run
individually or as part of the coordinated review.

## Follow-up rounds

After the author responds or pushes changes, `thatch-review-followup`
verifies whether prior findings were adequately addressed before
deciding whether to re-run the full review. The author must either
fix the code, prove the finding is not a concern with a checkable
argument, or file a follow-up ticket with a risk explanation.

## Author-side response

When you receive review comments on your own PR,
`thatch-review-response` helps you triage findings (legitimate,
intentional, false positive, unlikely edge case), fix bugs one by
one, reply on each thread, and post a top-level summary comment.

## Limitations

- The coordinator (`thatch-code-review`) is opencode-only. It
  requires sub-agent support to dispatch parallel specialists. On
  Claude Code or Cursor, run specialists individually instead.
- The review quality depends on the model. Weak models may
  hallucinate findings or miss subtle issues.
- The synthesizer verifies cited text exists, but it does not
  re-run the specialist's analysis. A specialist that cites
  correctly but reasons incorrectly will pass verification.
- The review covers the diff (merge-base..HEAD). It does not
  review the entire codebase. Pre-existing bugs are only found
  if the change makes them more reachable.

See [skills.md](skills.md) for the full skill list and
[default-behaviors.md](default-behaviors.md) for the review-adjacent
behavior rules (day-turnover-review, planning-git-archaeology).
