# Plan: fix-cycle prose gate (followup + review-response)

Revision 2. Round 1 reviewer findings folded in: one MISQUOTE fixed
(Change 4 rationale), two should-fixes adopted (author-only delta; loaded
-skill scope), qa-system.md rows added, disposition sentence added,
summary-row exclusion extended. Nice-to-have 5 (dev loading-guidance
bullets) rejected: loading guidance describes how to enter the skills,
not what they check; the gate does not change it.

## Problem

The review pipeline gates the prose of text that existed at review time:
NoSlop and Clarity scan the changed files in the review range. Fix cycles
create new prose that ships unreviewed:

- `thatch-review-followup.md` Step 3 verifies the FIX (code fixed, proved
  not a concern, or ticket + risk), never the prose the fix wrote.
  Step 7's full re-run offer is optional and ungated
  (artifacts/skills/thatch-review-followup.md:103-145, :263-281).
- `thatch-review-response.md` Step 4's per-bug loop fixes code and writes
  comments with no prose check; Step 6's summary template has a freeform
  "How it was confirmed" bullet (artifacts/skills/thatch-review-response.md:170-191,
  :255-257).
- Motivating instance: trufflesecurity/thog PR #7791. A Technique-lens
  suggestion became a compressed fix-list item became a shipped README
  section with three clarity defects. No lens saw the text after the fix.

## Goal

When a fix cycle introduces or modifies human-facing text (comments,
docstrings, error strings, docs), that text gets a clarity + no-slop
check before it ships. Mandatory, not dependent on the optional Step 7
re-run offer.

## Design decisions

1. **No new vocabulary, no REVIEW_COMMON change.** "Fix-cycle prose" and
   "prose epoch" stay out of the skills. The skills name the behavior
   plainly ("text the fix introduced"). REVIEW_COMMON scopes
   problem-finding specialists to the review range; the followup and
   review-response skills do not use REVIEW_COMMON, and nothing here
   changes specialist scope. Rationale: the two skill edits close the
   observed gap; new taxonomy would need single-sourcing and pinning for
   no behavior gain.
2. **Inline check, no dispatch.** Both `thatch-review-clarity` and
   `thatch-review-no-slop` are standalone loadable shared skills
   (src/skills.ts:60 via the roster at src/prompts.ts:21-22). The
   fix-cycle check runs inline against their standards; no specialist
   dispatch, so the check works on every host.
3. **Followup: one sweep per round, over the author-only delta.** The
   author's fix delta is one commit set for all findings, so the prose
   check runs once per round, not once per finding. The sweep runs over
   the author-only changes Step 2 already isolates
   (artifacts/skills/thatch-review-followup.md:82: the
   `git log --not origin/<default-branch>` filtered commit set, extended
   for stacked PRs), never the plain two-SHA diff when a merge-from-base
   or stacked rebase happened. A plain diff would pull in base-branch
   prose the author never wrote and post those findings on the PR.

## Changes

### 1. artifacts/skills/thatch-review-followup.md

New subsection at the end of Step 3, after "Verification method"
(:137-145), heading `### Prose check on the fix delta`:

- Trigger: the author-only changes from Step 2 (the merge-filtered
  commit set per :82) introduce or modify comments, docstrings, error
  strings, or documentation.
- Check: load `thatch-review-clarity` and `thatch-review-no-slop` and
  apply their rule categories to that text. Scope note in the wording:
  only the two skills' standards apply; their scope-gathering sections
  and specialist output format do not (both ship with REVIEW_COMMON
  interpolated, which tells a reader to compute a review range and emit
  specialist-shaped findings - wrong here).
- Mandatory whenever the delta touches prose, independent of the Step 7
  re-run offer (the re-run stays the full-depth option).
- No new prose in the delta: the check is a no-op.

Step 4 report (:147-189) gains a labeled subsection after the five
status groups, `#### New prose findings`, listing each prose problem
with file:line @ CURRENT_SHA and the violated rule. These are ordinary
findings: the author's fix introduced them, the same as new code.
One disposition sentence: prose findings feed the re-run decision the
same way the Round assessment's existing "introduced new code" line
does (:189). The Round assessment (:186-189) gains a prose-findings
count line.

### 2. artifacts/skills/thatch-review-response.md

New subsection in Step 4 after "New bugs found during the work"
(:188-191), heading `### Prose check on the fix`. The subsection amends
the per-bug loop (:180-186): before moving to the next bug, check any
comments, docstrings, error strings, or docs the fix
introduced against the clarity and no-slop standards (load both skills;
only their rule categories apply, not scope gathering or specialist
output format). Fix problems before drafting the thread response, so
the response and the diff agree.

Step 6 summary template: the Verification section (:255-257) gains a
prose-verification line under "How it was confirmed."

### 3. Tests

tests/setup-skills.test.ts, established pinned-phrase pattern
(:342-368, :374-379). New test in the "skill artifact registry parity"
describe block (:262) pinning the exact gate wording in both skills:

- followup: the `### Prose check on the fix delta` heading, the
  mandatory clause, the `#### New prose findings` heading.
- review-response: the `### Prose check on the fix` heading, the
  template's prose-verification line.

No collisions: no existing test pins these phrases or the "How it was
confirmed" template line.

### 4. Docs

- docs/user/code-review.md "Follow-up rounds" (:91-101): add a sentence
  naming the fix-delta prose check. "Author-side response" (:103-108):
  add a sentence naming the per-fix prose check.
- docs/dev/features/qa-system.md UC-085/UC-086 table rows (:99-100):
  extend the two row descriptions to include the prose check, so the
  table matches the updated use cases.
- Skill summary rows NOT changed, extended set: docs/dev/skills.md:54
  and :73, docs/user/README.md:342-343, docs/user/skills.md:54-55.
  These rows hand-summarize the frontmatter descriptions, which also
  appear in compressed form in src/prompts.ts (both host variants); the
  variants already diverge slightly, so syncing four-plus copies for a
  summary row costs more than it buys. The user doc carries the
  behavior. Frontmatter descriptions stay untouched.
- docs/dev/skills.md loading-guidance bullets (:164-168) not changed:
  they describe how to enter the skills, not what they check.
- tests/qa/README.md: no followup/review-response coverage claims today
  (grep verified); no change.

### 5. QA use cases

- tests/qa/live/uc-085-review-followup.ts: add an expected bullet for
  the prose check on the author-only fix delta and new prose findings
  in the report.
- tests/qa/live/uc-086-review-response.ts: add an expected bullet for
  the per-fix prose check and the summary's prose-verification line.

## Out of scope

- No REVIEW_COMMON or provenance-taxonomy change.
- No new skill, no src/ changes, no prompt-variant changes.
- No frontmatter description changes.

## Verification

- `bun install` (fresh worktree), then `mise run check` before every
  commit.
- New pinned-phrase test fails if either gate's wording is dropped.
- Grep sweep after edits: no stray "fix-cycle prose" vocabulary, no em
  dashes in the new text.

## Open questions for the coordinator

1. Placement confirmation: followup prose check as a Step 3 subsection
   (runs once per round over the author-only delta) vs. inside the
   per-finding verification method. Plan picks once-per-round;
   per-finding would re-read the same delta for every finding.
2. "New prose findings" as the report heading. Alternative: fold into
   Round assessment only. Plan picks a full subsection so findings carry
   evidence per the existing structure.
