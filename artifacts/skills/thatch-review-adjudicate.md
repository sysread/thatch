---
name: thatch-review-adjudicate
description: 'Present the findings of a completed code review to the human user for adjudication, one finding at a time: a fixed per-finding template (location, shape, plain-English description) with a verdict line after each (keep, drop, reframe, verify, elaborate, abort, post as draft), highlights and technique notes walked through the same loop, then a staged draft review the user submits. Use when a review of work authored by someone else (a PR, MR, branch, or git range) has produced its synthesized report and the findings now need user verdicts before anything is posted, or when the user asks to work through review findings one at a time. Not for self-review or subordinate-session work: those reviews route findings over chat and stay automatic.'
---

# Review adjudication

You are presenting the findings of a completed code review to the human user.
The review itself is done: the specialist lenses ran and the synthesizer
verified and deduplicated the findings. Your job is the adjudication loop.
The user rules on each finding. Only the kept findings reach the author. The
kept findings are staged - placed at their lines in the PR as a draft review -
and the user submits it.

## Scope: peer review only

This skill applies when the work under review was authored by someone else -
another person's PR, MR, branch, or git range - and a human user adjudicates
the findings and submits the review themselves.

It does not apply to self-review or to work authored by the user's own
subordinate sessions. Those reviews are the agent double-checking its own
side's work: findings route to the author-side session over chat as a fix
list, the user is the final arbiter only when disagreement persists, and no
draft review is ever created for them. If your findings came from such a
review, stop and hand the synthesized report to the chat loop instead.

## Sequence

1. Walk through the change first. Present the report's workflow-changes
   section as the map of what changed, then the counts: findings by severity
   and by class or lens, plus the highlights count and the technique-notes
   count. Then stop and let the user digest. Never open with an individual
   finding. The map gives each finding a place to land.
2. Present findings ONE AT A TIME: strictly one finding template per
   message, highest severity first, one verdict per finding. Never present
   a batch - no message ever carries more than one template block, even for
   small, related, or same-root findings (they become separate findings in
   sequence), and never issue a blended ruling over several findings at
   once. The reason is the point of the loop: a batch forces one verdict
   over findings the user would have adjudicated differently, so the
   per-finding verdict is only real if each finding arrives alone. End every
   finding with the verdict line on its own line, so the prompt never crowds
   out the finding.
3. After each verdict, check for a preference signal. When a verdict encodes
   a reusable preference - severity taste, scope threshold, tone, what is
   worth posting - query the prediction store for an existing matcher that
   fits this situation, then reinforce it, adjust it, or create a new one.
4. Walk the highlights and the technique notes through the same loop, right
   after the defect findings. Never hold them back for a later offer; their
   counts were announced up front so they cannot be missed. A keep verdict
   stages them like any finding. Confirmatory-only technique notes —
   correctness confirmations with no change the author could make ("verified
   X is correct; no change requested") — are NOT presented: they do not
   survive synthesis, and if the report carries one anyway, drop it without
   a verdict and subtract it from the announced count. A note that only
   confirms the code is fine wastes the adjudication loop's attention.
5. When every item has a verdict, give a final summary of what will be
   staged.
6. Offer to stage the draft review. Place each kept finding at its line in
   the PR and double-check every anchor: the local checkout and the PR branch
   are different trees, and a wrong line number is the most common staging
   error. Ask the user when an anchor cannot be resolved with confidence.
   The user submits the review, never you. Follow the user's attribution
   rules where the project has them.

## The finding template

Every finding, highlight, and technique note is presented in this exact shape:

```
# Finding <#> of <total> (<severity> * <class/lens> * <blocker/non-blocker>)

**Location:** <file path> @ <line number>
**Shape:** <the kind of problem: missing test, poorly phrased comment, race condition, unnecessary complexity, inconsistent naming, and so on>
**Description:** <plain-English description, written for a reader who has not read the delta. Lead with what breaks, who it affects, and the blast radius.>

Review tally: <kept>/<adjudicated>

Choose your adventure: (k)eep • (d)rop • (r)eframe • (v)erify • (e)laborate • (a)bort • (p)ost as draft
```

The tally line rides every finding template, one line above the verdict
line, so the user sees the running state without hunting for it. The
denominator is the number of items already adjudicated (verdicts on
merit: keep or drop), NEVER the total number of findings - it grows as
the walkthrough proceeds. The numerator is how many of those the user
kept. Verify and elaborate do not advance the tally (they are not
verdicts on merit); a re-presented reframe counts when it lands its
final verdict, not twice. A bulk ruling ("skip the rest", post-as-draft
remainder) advances the denominator by everything it covered, in one
step.

The verdict line is plain text in the chat message, part of the finding
presentation. Never route the verdict options through the host's interactive
question/prompt tool: that tool exists for blocking questions the agent
cannot answer itself, and a review verdict is not one - it is the user's
ruling on work they are reading, and it arrives in their next message like
every other line of the conversation.

## Verdicts

- (k)eep - the finding goes in the review. May carry a severity change
  ("keep as a nit"); the new label wins.
- (d)rop - the finding is out, permanently for this round; never re-surface
  it in later summaries or the draft review. Part of a dropped finding may
  survive: the piece the user's reason for dropping did not kill can be
  promoted to its own smaller finding, which enters the walkthrough as a new
  finding. A drop may arrive in bulk ("skip the rest"): every remaining
  finding, plus the highlights and technique notes, is dropped with it.
- (r)eframe - reshape it (narrow to the surviving half, merge with a
  same-root finding, or re-derive it after new evidence) and re-present for a
  fresh verdict.
- (v)erify - not a verdict on merit: a request for the load-bearing evidence
  the presentation lacks. Measure the live risk surface, check the stacked
  PRs, or expand the mechanism, then re-present with the evidence included.
- (e)laborate - also not a verdict on merit: drop the plain-terms
  presentation for this finding and share its code details - the paths,
  symbols, and line-level evidence - so the user can judge it against the
  code.
- (a)bort - stop the walkthrough. Already-adjudicated findings stand; list
  the un-adjudicated remainder once for a bulk ruling, then stop. Nothing is
  staged; the user decides what happens next.
- (p)ost as draft - stop the walkthrough and stage the draft review from
  the kept findings immediately, after any bulk ruling on the remainder.
  Skips straight to the staging step; the user still reads it in place and
  submits.

## Presentation prose

In chat, present each finding in plain product terms: the shape of the
problem, the workflow it lives in, who does what, what breaks, and the blast
radius. No code paths, symbols, or file-and-line scaffolding in the chat
presentation; those belong in the staged comment, where the author has the
diff open. The user trusts the agent on accuracy and judges on shape and
severity.

Write clearly above all else. If your findings start reading as compressed,
jargon-dense prose, stop and reread the `thatch-clear-writing` skill. The
user wants plain, easy-to-read sentences; when that conflicts with any other
instruction about how to write, clarity wins. One idea per sentence. Define
jargon on first use. Lead with what breaks.
