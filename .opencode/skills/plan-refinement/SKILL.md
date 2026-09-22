---
name: plan-refinement
description: Refine a plan for a code change or design work by dispatching a fresh-context subagent reviewer to hunt for gaps, unverified premises, and unexpected side effects, then revising and re-reviewing until reviewer and plan reach consensus. Use when a plan is about to be implemented, when the user asks to refine, stress-test, or double-check a plan, or after a plan revision that incorporated prior findings.
---

# Plan refinement by fresh-context reviewer

A plan written by the same context that researched the problem inherits that
context's blind spots. A reviewer with no stake in the plan and no memory of
writing it finds what the author cannot. Refinement is the loop: draft,
review, revise, repeat until consensus. Each pass tightens the plan; a round
with no findings means the plan is done, not that the loop failed.

Not for reviewing code that already exists -- use `thatch-code-review` for
that. This skill is for the plan that precedes the code.

## The loop

1. **Draft the plan.** Every factual premise carries a `file:line` citation
   you personally verified. A premise you did not check is a guess wearing a
   citation; verify or mark it unverified.
2. **Dispatch one reviewer subagent** (read-only explore type). The prompt
   must instruct it to:
   - Verify each premise against the actual code, with `file:line` evidence.
   - Give each plan step a verdict: CORRECT, NEEDS ADJUSTMENT (how), or
     WRONG (why).
   - Hunt for gaps by severity (blocker / should-fix / nice-to-have),
     unexpected side effects, blast radius, and the question "how does this
     fail in production?" -- concurrency, stale state, multi-host
     interactions, test flakiness, and behavior changes for existing callers.
   - Say explicitly when it cannot verify something, rather than guessing.
3. **Revise the plan** from the findings. Fix what is wrong, adjust what
   needs adjusting, and record what you rejected and why.
4. **Dispatch a NEW reviewer with fresh context** on the revised plan. Never
   continue the prior reviewer's session, and never tell it what previous
   reviewers said -- prior findings anchor the next reviewer, and it will
   inherit the earlier reviewer's blind spots instead of finding its own.
   Present the revised plan as if it were the original.
5. **Consensus** is a round where the reviewer reports no blockers, no
   unaddressed should-fixes, and the plan's premises all verify. Two
   consecutive quiet rounds is strong consensus; one is enough to build.
6. **Cap at three review rounds.** If the plan has not converged by then,
   stop looping and put the remaining disagreements in front of the user --
   continued revision usually means the design problem, not the plan, is
   unresolved.

## When the user insists on proceeding with open findings

Do not argue, and do not silently drop the findings. Reduce the risk of
building with known holes:

- For each open finding, attach an explicit mitigation or mark it as an
  accepted risk. A mitigation is one of: a test that guards the risky
  behavior, a rollout or feature-flag plan, a log or assertion that makes
  the failure loud when it happens, or a documented rollback path.
- "We discussed it and Jeff said go" is not a mitigation. Name what will
  catch the failure if the reviewer was right.
- Present the list of accepted risks to the user in one place before
  implementation starts, and keep it with the plan so a future session can
  see what was knowingly left open.

## Reviewer prompt rules

- Give the reviewer the problem context and the plan. Give it neither your
  research transcript nor earlier review findings.
- Demand `file:line` evidence for every claim, and explicit "unverified"
  where it cannot check.
- Ask it to state whether the plan's own list of affected surfaces is
  complete or over-broad. Plan authors over-scope and under-scope in equal
  measure.
- Tell it the repo is read-only for this task.

## Cost control

One reviewer per round, single agent, foreground. Parallel reviewers multiply
context spend without adding much signal at plan stage -- the fresh-context
requirement, not reviewer count, is what buys independence.
