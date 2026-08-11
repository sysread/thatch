# Review Response

## Synopsis

An author-side skill for responding to code review on the user's own PR.
Triage review findings, fix them one by one, reply on each thread, then
post a top-level summary comment. The summary uses PR-description-grade
prose so reviewers can see what changed and why without re-reading the
full diff.

## Background

Review skills in thatch today serve the reviewer. `thatch-code-review`
dispatches specialists to find issues. `thatch-review-followup`
verifies whether the author addressed prior findings. Neither helps the
author respond to review on their own PR.

A review by Martin Locklear on thog PR #6766 demonstrated a style worth
capturing. At each review finding, the response narrated the diagnosis,
the fix (including wrong first attempts), and the commit. After each
round, a top-level comment gave the shape of the work: what changed, key
decisions, false starts, and what was deliberately left out. The PR
description linked to these comments at the bottom.

This plan captures that workflow as a skill. It is the author's
counterpart to the reviewer-side skills.

## The "playful but precise" principle

Tone is playful in delivery, precise in substance. The light touch
reduces defensiveness for less experienced reviewers who may feel
sensitive about findings. The precision earns respect from experienced
ones who care about correctness.

The humor is in the insight itself: a sharp technical observation that
happens to be funny. Not a joke next to the insight. Not performed
casualness. Not sycophancy. Not "great catch!" The playfulness signals
engagement, not approval.

This principle applies to both this skill (author responding to
reviewer) and the code-review skill (reviewer leaving findings). Same
direction, different side. For this skill it is a skill-body
instruction. For the code-review skill it is an addition to the
synthesizer's tone guidance, so review comments the user posts carry
the same quality.

## What it does

### Phase 1: Discover user rules

Before doing anything else, discover the current user's response rules.
These always supersede the skill's defaults.

1. `thatch_memory_recall` for review response preferences: prefix,
   banned closers, tone, framing guidelines.
2. `thatch_prediction_query` for review response decision patterns.
3. If the user has defined rules, those win. The skill's defaults are
   fallbacks for users who have not defined rules.

The skill is user-agnostic. It discovers the current user's rules
rather than hardcoding any specific user's prefix or banned phrases.

### Phase 2: Gather and classify findings

Fetch all review comments on the PR. For each finding, classify into one
of four categories:

- **Legitimate.** Real bug. Fix it. A reasonably plausible edge case
  falls here, not under "unlikely." The bar for dismissing something as
  unlikely is high: if a user could plausibly hit it, it is legitimate.
- **Intentional.** Code is correct, but the reader was confused. This
  is a legibility bug, not a code bug. Fix = add an explanatory comment
  in the code. The response credits the reviewer for noticing the
  confusion. Future readers will be confused the same way, so the
  comment goes in the code, not just in the thread.
- **False positive.** Finding is wrong. No code change. The response
  must explain why with a verifiable argument: cite the constraint, the
  unreachable path, the type guard. Do not just assert "this is fine."
- **Unlikely edge case.** Requires impossible or near-impossible
  conditions to trigger. Explain why it is not a concern. The bar is
  high. If a user could plausibly hit it, it is legitimate.

Bot findings (Cursor Bugbot, etc.) get the same treatment but with more
suspicion. Bots are more prone to false positives, first-order
thinking, and bugs that require impossible states. Investigate with a
larger grain of salt. But respond to them the same way you would to a
human, because other human reviewers will read the thread and want to
understand the verdict.

### Phase 3: Collapse by root cause

Before presenting findings to the user, trace each to its root cause.
Surface-level unrelated findings that share an underlying issue get
collapsed into one bug. The overview presents one entry per root cause,
with the constituent findings listed under it.

Example: a config channel mismatch between `.env` and `mise.local.toml`
might surface as vite port issues, Django origin mismatches, and devdb
helper failures. Three different-looking findings, one root cause.

### Phase 4: Present overview, then work through bugs

Present the user with an overview of each collapsed bug. Then start
working through them one by one. Use a task list to track each bug-task,
plus additional bugs found during the work.

For each bug:

1. Show the finding(s) and the classification.
2. For legitimate bugs: fix the code.
3. For intentional: add an explanatory comment in the code.
4. For false positive or unlikely: prepare the explanation.
5. Offer to respond to the reviewer on the thread.

### Phase 5: Per-thread responses

After each fix or decision, offer to respond on the thread. The
response:

- States the verdict: accepted, narrowed, or declined with reason.
- Names the concrete failure mode the finding catches.
- Shows the fix, including wrong first attempts when they are
  instructive. The wrong first attempt teaches why the final choice is
  what it is.
- Names the commit.
- Notes the response was automated, unless the user's rules say
  otherwise.
- Uses the user's prefix if defined (e.g., `**Landru is thinking on
  behalf of Jeff:**`).
- Avoids the user's banned closers if defined (e.g., `wdyt?`, `not
  blocking`, `happy to leave it`).
- Uses "playful but precise" tone.
- Credits the reviewer for catching something real. For intentional
  findings, credits the reviewer for noticing the confusion.

### Phase 6: Top-level summary comment

After all changes are complete, post a top-level comment on the PR
summarizing the changes. Structure:

- **What this pass changed** — each change with its reason. Note which
  reviewer identified the bug or finding that led to the change.
- **Key decisions** — why this path over the alternative.
- **False starts** — what was tried first and why it was wrong, when
  instructive.
- **Deliberately not done** — scope boundaries with reasons.
- **Verification** — how it was confirmed.

Borrows the PR-description prose rules: plain English, one idea per
sentence, no buzzwords, define jargon on first use, conclusion-first,
scale to complexity. Notes it was LLM-generated (or uses the user's
framing if they have defined one).

The summary comment serves the reviewers who need to see what changed
since their last pass. This is especially valuable for organizations
struggling to keep up with reviews, where AI-generated PRs are trending
longer and more complex.

### Phase 7: Update PR description footer

After posting the summary comment, update the PR description's footer
with a bullet or two linking to the summary comment. This makes the
pivots discoverable from the PR body, not buried in the comment thread.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Author-side skill (not reviewer-side) | Existing skills serve the reviewer. This fills the gap for the author responding to review. |
| "Playful but precise" in the skill body | A skill instruction, not a memory. Hardcoded because it is a contract, not advice. |
| Also add to code-review synthesizer tone guidance | Same principle, different direction. Reviewer comments should carry the same quality. |
| Four-category classification | Legitimate, intentional, false positive, unlikely edge case. Intentional is the sharpest: correct code that confused the reader is a legibility bug. |
| Collapse by root cause before presenting | Surface-level unrelated findings often share one underlying issue. One bug per root cause. |
| Task list for bug-tracking | Track each bug as a task. Add new bugs found during the work. |
| User rules always supersede | Skill is user-agnostic. Discover the current user's rules at start. |
| Bot findings: same treatment, more suspicion | Bots are more prone to false positives. But respond the same way, because human reviewers read the threads. |
| Summary comment uses PR-description prose rules | Reviewers need to see what changed. PR-description-grade prose makes it scannable. |
| PR description footer gets a bullet linking to the summary | Makes pivots discoverable from the PR body. |
| Per-thread responses include wrong first attempts when instructive | The wrong first attempt teaches why the final choice is what it is. Not just the fix. |

## Architecture

```
User requests: "check the review comments on my PR"
  |
  v
Phase 1: Discover user rules
  -> thatch_memory_recall (review response preferences)
  -> thatch_prediction_query (review response decisions)
  -> user rules supersede skill defaults
  |
  v
Phase 2: Gather findings
  -> fetch all review comments (inline + top-level)
  -> classify each: legitimate / intentional / false positive / unlikely
  -> bot findings: same classification, more suspicion
  |
  v
Phase 3: Collapse by root cause
  -> trace each finding to root cause
  -> group surface-level unrelated findings sharing one issue
  -> build overview: one entry per root cause
  |
  v
Phase 4: Present overview, work through bugs
  -> present overview to user
  -> create task list (one task per bug)
  -> work through one by one
  -> add new bugs found during work as tasks
  |
  v
Phase 5: Per-thread responses
  -> after each fix/decision, offer to respond
  -> state verdict, name failure mode, show fix + wrong first attempts
  -> name commit, note automation, use user prefix
  -> playful but precise tone
  |
  v
Phase 6: Top-level summary comment
  -> after all changes complete
  -> post summary: what changed, key decisions, false starts,
     deliberately not done, verification
  -> PR-description prose rules
  -> note which reviewer identified each bug
  |
  v
Phase 7: Update PR description footer
  -> add bullet(s) linking to summary comment
```

## Open questions

1. **Monitoring mode.** The user mentioned the possibility of asking the bot
   to monitor for comments. That would make the skill fire automatically
   when new review comments arrive, rather than on explicit request. This
   is out of scope for the initial skill. A hook or polling mechanism would
   be needed. Future direction.

2. **Skill placement.** This skill works on all hosts (opencode, Claude
   Code, Cursor) since it does not require sub-agent dispatch. It goes
   in `SHARED_SKILLS`, not `OPENCODE_ONLY_SKILLS`. (Resolved: implemented
   as shared skill.)

## Dependencies

### Runtime

- VCS CLI (`gh`, `glab`) for fetching comments and posting responses
- `thatch_memory_recall` for user preference discovery
- `thatch_prediction_query` for user decision model

### Skill dependencies

- `thatch-pr-description` prose rules (referenced by the summary comment
  phase, not loaded as a skill)
