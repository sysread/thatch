---
name: thatch-plan-refinement
description: Refine a plan for a code change by dispatching a fresh-context reviewer subagent to hunt for gaps, unverified premises, and unexpected side effects, then revising and re-reviewing until consensus. Use when a plan is about to be implemented, when the user asks to refine, stress-test, or double-check a plan, or after a plan revision that incorporated prior findings. Quick mode is one fresh reviewer per round; deep mode adds a specialist lens fan-out (reuse, alternatives, hidden problems, safe-to-modify, archaeology).
---

You are refining a plan before code exists. A plan written by the same context that researched the problem inherits that context's blind spots. A reviewer with no stake in the plan and no memory of writing it finds what the author cannot. Refinement is the loop: draft, review, revise, repeat until consensus. Each pass tightens the plan; a round with no findings means the plan is done, not that the loop failed.

This is the plan-stage counterpart to code review: code review applies multi-lens scrutiny to a diff that exists; refinement applies it to a plan, where findings cost nothing to fix.

## Mode triage

Pick the mode before starting, and say which you picked.

**Skip refinement** for single-file mechanical changes, typo or docs-only changes, and changes that follow an established pattern with no design decisions. A single self-review pass is enough; running this loop on a five-line change is waste.

**Quick mode (default)** — one fresh-context reviewer per round. Use for everything that is not trivial and not deep-mode material.

**Deep mode** — adds a one-time specialist lens fan-out (see below) before the consensus rounds. Use when the plan: touches shared or persistent state (database tables, files, config) that other consumers read; spans many files or multiple hosts/processes; introduces a new abstraction, table, or contract; or when the user asks for depth. Deep mode runs the lenses ONCE, in the first round; the remaining rounds are quick-mode consensus on the revised plan.

## The loop

1. **Draft the plan.** Every factual premise carries a `file:line` citation you personally verified. A premise you did not check is a guess wearing a citation; verify it or mark it unverified.
2. **Dispatch one reviewer** (read-only). The prompt must instruct it to:
   - Verify each premise against the actual code, with `file:line` evidence.
   - Give each plan step a verdict: CORRECT, NEEDS ADJUSTMENT (how), or WRONG (why).
   - Hunt for gaps by severity (blocker / should-fix / nice-to-have), unexpected side effects, blast radius, and the question "how does this fail in production?" — concurrency, stale state, multi-host interactions, test flakiness, and behavior changes for existing callers.
   - Say explicitly when it cannot verify something, rather than guessing.
3. **Revise the plan** from the findings. Fix what is wrong, adjust what needs adjusting, and record what you rejected and why.
4. **Dispatch a NEW reviewer with fresh context** on the revised plan. Never continue the prior reviewer's session, and never tell it what previous reviewers said — prior findings anchor the next reviewer, and it will inherit the earlier reviewer's blind spots instead of finding its own. Present the revised plan as if it were the original.
5. **Consensus** is a round where the reviewer reports no blockers, no unaddressed should-fixes, and the plan's premises all verify. Two consecutive quiet rounds is strong consensus; one is enough to build.
6. **Cap at three review rounds.** If the plan has not converged by then, stop looping and put the remaining disagreements in front of the user — continued revision usually means the design problem, not the plan, is unresolved.

## Deep mode: the lenses

Run each lens as its own fresh read-only agent, in parallel where the host allows. The lenses see the plan plus the problem context — never prior review findings. Collect the results, synthesize (dedupe by root cause, severity-group, keep only verified findings), revise the plan, then continue with quick-mode rounds.

**Pattern and reuse.** Find existing patterns, helpers, and abstractions in the codebase that the plan could reuse or extend instead of adding new surface. The verification gate: the lens must READ the code it cites and show the contract fits the plan's need — a pattern claim from memory or a name match is not evidence, and a wrong "reuse X" sends the design down a bad path. Output: reusable candidates with `file:line` and fit analysis, or an explicit "none found".

**Alternatives.** Research materially different solutions to the same problem and judge the juice-to-squeeze ratio against the plan's actual constraint set. Budget: at most two alternatives, each argued in a paragraph — this lens is a filter, not a survey. "No better alternative found" is a valid, expected, honest output; padding with straw men is worse than an empty result.

**Hidden problems (pre-mortem).** Enumerate every consumer of each symbol, table, file, and config value the plan touches (grep, not memory). Enumerate state the plan writes, moves, or invalidates, and who reads it after the change — including other hosts, processes, and hook paths sharing the same database or files. Then mentally apply the change and diff the failure modes: what breaks downstream, what silently changes meaning. This lens owns the question "who knows about this state that the plan does not?"

**Safe-to-modify audit.** For each code section the plan must touch: is there test coverage that would catch a regression (name the test), and is the section in shape to modify without a rewrite? Verdict per section: **safe**, **refactor-first** (the plan gains an explicit dependency: refactor before the change), or **stop-and-ask** (structural problem — surface to the user before building). Audit only sections the plan touches; auditing the whole repo is out of scope. A missing-coverage section is refactor-first or stop-and-ask, never "safe, we'll add tests later" — coverage comes before the change, not after.

**Archaeology (intent).** For the code in the change's path, find out WHY it is the way it is: git history (commits, PR descriptions and review discussions, merge messages), ticket history, code comments, docs, and project memory. Every intent claim cites its evidence. Where the evidence runs out, record exactly that — "unknown, not enough detail available" — and stop. NEVER construct a plausible intent from how the code looks: unstated intent is treated as unknown, and the plan must not build on assumed intent. The deliverable is a map of evidenced intent plus an explicit unknowns list, so the plan can ask the user about the unknowns instead of hallucinating past them.

## Dispatching across hosts

The fan-out needs sub-agents, and every host has them — couch the instructions per host, the same way code review does:

- **opencode**: Task tool, read-only explore-type agent, one agent per lens.
- **Claude Code**: Agent tool; the skill runs inline, each lens is one Agent dispatch.
- **Cursor**: background subagents, one per lens.

Single level of dispatch only — lenses never dispatch further agents. If the host or session cannot dispatch sub-agents, degrade honestly: run each lens as a separate focused self-review pass in sequence, and tell the user the review is weaker than the real thing (same-context review misses what fresh-context review catches).

## When the user insists on proceeding with open findings

Do not argue, and do not silently drop the findings. Reduce the risk of building with known holes:

- For each open finding, attach an explicit mitigation or mark it as an accepted risk. A mitigation is one of: a test that guards the risky behavior, a rollout or feature-flag plan, a log or assertion that makes the failure loud when it happens, or a documented rollback path.
- "We discussed it and the user said go" is not a mitigation. Name what will catch the failure if the reviewer was right.
- Present the list of accepted risks to the user in one place before implementation starts, and keep it with the plan so a future session can see what was knowingly left open.

## Reviewer prompt rules

- Give the reviewer the problem context and the plan. Give it neither your research transcript nor earlier review findings.
- Demand `file:line` evidence for every claim, and explicit "unverified" where it cannot check.
- Ask it to state whether the plan's own list of affected surfaces is complete or over-broad. Plan authors over-scope and under-scope in equal measure.
- Tell it the repo is read-only for this task.

## Cost control

One reviewer per round in quick mode; one lens fan-out total in deep mode, then quick rounds. Foreground dispatches — the loop is sequential by design, and the fresh-context requirement, not reviewer count, is what buys independence. Parallel reviewers multiply context spend without adding much signal at plan stage.

## Relationship to other skills

- **`thatch-code-archaeology`** — the research skill for understanding the code; its output is often the plan's input. The archaeology lens is a targeted, plan-scoped re-run of its git-history step, not a replacement for it.
- **`thatch-coding-workflow`** — the procedure skill for executing the refined plan. Refinement ends where coding-workflow begins.
- **`thatch-code-review`** — the post-implementation multi-lens pipeline. Same machinery, different artifact and stage. Findings from code review that reveal a plan flaw are a signal to refine the plan for the NEXT change, not to loop backwards.
