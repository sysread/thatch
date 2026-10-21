---
description: "Review the user's own completed work before submitting it"
---
# User Message

$ARGUMENTS

(That section carries the text typed after the command. When it is empty, treat the user message as n/a - the command was run bare.)

# Self-review

Review the user's own completed work before submitting it: as a PR or MR on a shared project, or as a direct commit on a personal project. The review runs the full thatch review pipeline with findings weighted to protect the user's reputation as a conscientious developer.

The work under review was authored by the user, or by their agent acting in the user's name. Two goals: the work is sound, and it does not read as sloppy. Reviewers and teammates read the comments, docs, and commit messages as the user's own.

${COUCHING:target}

${COUCHING:pipeline}

## Self review mode rules

- The reputation lenses weigh heaviest. NoSlop, Clarity, Technique, and Breadcrumbs findings outrank same-severity findings from the other lenses. AI-writing tells, unclear prose, and a missing narrative are exactly what this review exists to catch before anyone else sees them.
- Overweight simplicity on shared projects. Prefer findings that make the design easier to understand, easier to test, and more reliable: fewer assumptions, less surface area for bugs and side effects.
- Technique and highlights findings are decisions, not footnotes. Each one that would produce a simpler, clearer, or more reliable design is surfaced for an adopt-or-dismiss decision before submission. Work through them with the user one at a time; do not leave them as informational asides.
- Iterate rounds. After each round, work the findings with the user: fix each, or explicitly decline it with a reason. Then run another full round on the updated state. A round is meaningful when it produces a MEDIUM or higher finding, or a technique or slop finding worth adopting. A round producing only LOW mechanical findings gets them fixed but does not trigger another round. Stop at the first round with no meaningful findings, and never run more than three rounds.
