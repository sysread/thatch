---
name: thatch-plan-refinement
description: Refine a plan for a code change by dispatching a fresh-context reviewer subagent to hunt for gaps, unverified premises, and unexpected side effects, then revising and re-reviewing until consensus. Use when a plan is about to be implemented, when the user asks to refine, stress-test, or double-check a plan, or after a plan revision that incorporated prior findings. This is the generic core loop; when the project type should shape the refinement bar, load thatch-refine instead and it will apply a type delta on top of this loop. Quick mode is one fresh reviewer per round; deep mode adds a specialist lens fan-out (reuse, alternatives, hidden problems, safe-to-modify, archaeology, evidence, consistency). Deep-mode triggers are binding; when one is met the fan-out runs, and project-type deltas relax round counts, never mode selection. Every round reviewer also runs two introspection audits (evidence, consistency) on the plan text under review, both must pass for consensus, and a failed audit triggers reroot analysis, not in-place patches.
---

You are refining a plan before code exists. A plan written by the same context that researched the problem inherits that context's blind spots. A reviewer with no stake in the plan and no memory of writing it finds what the author cannot. Refinement is the loop: draft, review, revise, repeat until consensus. Each pass tightens the plan; a round with no findings means the plan is done, not that the loop failed.

This is the plan-stage counterpart to code review: code review applies multi-lens scrutiny to a diff that exists; refinement applies it to a plan, where findings cost nothing to fix.

## Mode triage

Pick the mode before starting, and say which you picked.

**Skip refinement** for single-file mechanical changes, typo or docs-only changes, and changes that follow an established pattern with no design decisions. A single self-review pass is enough; running this loop on a five-line change is waste.

**Quick mode (default)** — one fresh-context reviewer per round. Use for everything that is not trivial and not deep-mode material.

**Deep mode** — adds a one-time specialist lens fan-out (see below) before the consensus rounds. Use when the plan: touches shared or persistent state (database tables, files, config) that other consumers read; spans many files or multiple hosts/processes; introduces a new abstraction, table, or contract; or when the user asks for depth. Deep mode runs the lenses ONCE, in the first round; the remaining rounds are quick-mode consensus on the revised plan.

**These triggers are binding.** If any trigger is met, deep mode's lens fan-out runs for that plan; quick mode is not an option for it. Project-type deltas (`thatch-refine-personal` and its siblings) relax round counts and skip thresholds. They never relax mode selection. The triggers were met verbatim in a 26-round field refinement (October 2026) and quick mode ran anyway, which is why this paragraph is a rule and not advice.

## Plan format requirements

Two plan shapes earn their own plan section. Add them at draft time; retrofitting them mid-loop costs rounds, because every round after the retrofit re-reviews prose the section would have settled.

**State and transition matrix.** Any plan that adds or changes UI or session state (modes, statuses, retention, flags, caches) must carry a state-and-transition matrix as a plan section: every state, every transition between states, and the precedence rule that decides which transition wins when two compete. The first reviewer round verifies every user journey in the plan against the matrix, not against the prose. UX rules written as prose accrete; a matrix makes the unspecified combination impossible to miss. In a 26-round field refinement (October 2026), the state rules of a chat-and-UI plan lived as prose for 16 rounds, and reviewers kept finding combinations no one had written down; a matrix forced at round one would have collapsed most of those findings into the first two rounds.

**Deltas-from-template ledger.** When the plan ports or clones a template or twin feature, it must carry a table of deltas from that template. Each row names one divergence and what the twin actually does at that point, verified against the template's source, not remembered. Reviewers check template-behavior claims against the ledger instead of re-deriving the twin's behavior from scratch. In the same field refinement, a template fact flipped across three rounds because each fresh reviewer re-derived it and got a different answer; the ledger is the fix for that class.

## The loop

1. **Draft the plan.** Every factual premise carries a `file:line` citation you personally verified. A premise you did not check is a guess wearing a citation; verify it or mark it unverified. A premise you mark unverified becomes an open user question before build; it is never silently built on.
2. **Dispatch one reviewer** (read-only). The prompt must instruct it to:
   - Verify each premise against the actual code, with `file:line` evidence.
   - Give each plan step a verdict: CORRECT, NEEDS ADJUSTMENT (how), or WRONG (why).
   - Hunt for gaps by severity (blocker / should-fix / nice-to-have), unexpected side effects, blast radius, and the question "how does this fail in production?" — concurrency, stale state, multi-host interactions, test flakiness, and behavior changes for existing callers.
   - Run the two introspection audits (Evidence audit and Consistency audit, defined under "The introspection lenses" below) on the plan as revised through the previous round (the text under review; this round's revision is audited by the next round's reviewer), and report each audit's verdict and findings in its own section of the round report. A stale draft audited instead of the text under review is a wasted round; if the reviewer cannot tell which revision it is reading, the dispatch failed.
   - Say explicitly when it cannot verify something, rather than guessing.
3. **Revise the plan** from the findings. Fix what is wrong, adjust what needs adjusting, and record what you rejected and why.
4. **Run the revision self-check.** Before dispatching the next reviewer, re-read the revision diff against the plan it edits, in the same context, and check three things: does the fix contradict anything else in the plan, does it open a new unspecified corner, and is it consistent with findings already folded in. This is a contradiction check on the diff, not a fresh review, and it is cheap because it reuses context you already have. Skipping it hands the next fresh reviewer your own unfinished edges one round late. In the 26-round field refinement cited above, revision churn dominated rounds 8 through 19 because each fix opened corners no one checked until the next round caught them.
5. **Dispatch a NEW reviewer with fresh context** on the revised plan. Never continue the prior reviewer's session, and never tell it what previous reviewers said — prior findings anchor the next reviewer, and it will inherit the earlier reviewer's blind spots instead of finding its own. Present the revised plan as if it were the original.
6. **Consensus** is a round where the reviewer reports no blockers, no unaddressed should-fixes, both introspection audits return AUDIT PASS, and the plan's premises all verify. An audit FAIL does not converge the round: it produces a reroot (the earliest point where the wrong conclusion landed, and the first place that conclusion is load-bearing, both named) plus a re-derived downstream plan, which the next round's audits see. Two consecutive quiet rounds is strong consensus; one is enough to build. For a run extended past the cap, the stopping rule changes; see Extended runs below.
7. **Cap at three review rounds.** If the plan has not converged by then, stop looping and put the remaining disagreements in front of the user — continued revision usually means the design problem, not the plan, is unresolved. If the user explicitly extends the run past the cap, follow Extended runs below instead of stopping. If a revision landed after the final round's audits, say so explicitly when presenting: the user is accepting an unaudited revision.

## Extended runs (past the cap)

The cap is a default, not a law. When the user explicitly extends the run ("keep going while it is useful"), do not stop, and do not repeat the general reviewer prompt either. In the 26-round field refinement cited above, the user overrode the cap, the extended rounds kept earning their keep, and the repeated prompt re-trod ground earlier rounds had already covered. Two mechanics govern the extension.

**Rotate the reviewer lens.** Each extended round's reviewer prompt carries one lens from a fixed schedule, instead of the general prompt:

1. Schema and data model: the tables, columns, constraints, and migrations the plan touches.
2. Cross-module contracts: the callers, imports, and API surfaces the plan changes.
3. Lifecycle and edge cases: creation, teardown, concurrency, and failure paths.
4. Prompt and UI surfaces: user-visible text, states, and flows.
5. General: the standard reviewer prompt, then restart the schedule.

This rotation applies only past the cap. The standard loop keeps the general prompt for all three of its rounds. The two introspection audits are not rotation lenses: they run in every extended round regardless of which lens the schedule assigns, on the plan as revised through the previous round, and an AUDIT FAIL is build-changing by definition, so it routes to reroot analysis rather than a patch.

**Stop on a build-clean round.** For an extended run, consensus is a round with no build-changing findings, where build-changing means the finding would change what gets built, not how a sentence reads. Wording and editorial findings batch into one final editorial pass after the last round; they do not start new rounds. The quiet-round definition in the loop stays in force for standard runs.

## Deep mode: the lenses

Run each lens as its own fresh read-only agent, in parallel where the host allows. The lenses see the plan plus the problem context — never prior review findings. Before the fan-out, run `thatch_memory_recall` for the plan's topic and include what comes back as a "prior knowledge from project memory" block in every lens prompt: lens agents are plain read-only sub-agents WITHOUT thatch MCP tools, so the coordinator is the only side of the fan-out that can reach project memory — a lens told to "consult project memory" will report a spurious unverifiable-input hole instead (observed in the first dogfood run). Mark the block as unverified context, not established fact; the archaeology lens treats it as a lead to check, not a source to cite. Collect the results, synthesize (dedupe by root cause, severity-group, keep only verified findings), revise the plan, then continue with quick-mode rounds.

**Pattern and reuse.** Find existing patterns, helpers, and abstractions in the codebase that the plan could reuse or extend instead of adding new surface. The verification gate: the lens must READ the code it cites and show the contract fits the plan's need — a pattern claim from memory or a name match is not evidence, and a wrong "reuse X" sends the design down a bad path. Output: reusable candidates with `file:line` and fit analysis, or an explicit "none found".

**Alternatives.** Research materially different solutions to the same problem and judge the juice-to-squeeze ratio against the plan's actual constraint set. Budget: at most two alternatives, each argued in a paragraph — this lens is a filter, not a survey. "No better alternative found" is a valid, expected, honest output; padding with straw men is worse than an empty result.

**Hidden problems (pre-mortem).** Enumerate every consumer of each symbol, table, file, and config value the plan touches (grep, not memory). Enumerate state the plan writes, moves, or invalidates, and who reads it after the change — including other hosts, processes, and hook paths sharing the same database or files. Then mentally apply the change and diff the failure modes: what breaks downstream, what silently changes meaning. This lens owns the question "who knows about this state that the plan does not?"

**Safe-to-modify audit.** For each code section the plan must touch: is there test coverage that would catch a regression (name the test), and is the section in shape to modify without a rewrite? Verdict per section: **safe**, **refactor-first** (the plan gains an explicit dependency: refactor before the change), or **stop-and-ask** (structural problem — surface to the user before building). Audit only sections the plan touches; auditing the whole repo is out of scope. A missing-coverage section is refactor-first or stop-and-ask, never "safe, we'll add tests later" — coverage comes before the change, not after.

**Archaeology (intent).** For the code in the change's path, find out WHY it is the way it is: git history (commits, PR descriptions and review discussions, merge messages), ticket history, code comments, and docs — all reachable from a read-only agent via git and the gh CLI. Project memory arrives only via the coordinator-injected prior-knowledge block in your prompt (you have no memory tools); treat it as a lead to verify, not a citable source. Every intent claim cites its evidence. Where the evidence runs out, record exactly that — "unknown, not enough detail available" — and stop. NEVER construct a plausible intent from how the code looks: unstated intent is treated as unknown, and the plan must not build on assumed intent. The deliverable is a map of evidenced intent plus an explicit unknowns list, so the plan can ask the user about the unknowns instead of hallucinating past them.

**Evidence.** Exhaustive citation sweep: every `file:line`, function name, table or constraint, and prior decision the plan cites is checked against the repo, and against git and ticket history for decision citations. The boundary with the archaeology lens: archaeology GENERATES intent claims from history (why the code is the way it is); this lens VERIFIES the plan's existing citations. Whether a cited prior decision still binds is judgment, not audit; the lens only checks the decision record exists. Output: per-citation verdicts plus the audit verdict defined under "The introspection lenses" below.

**Consistency.** Section-vs-section contradiction sweep of the plan document itself: approach against constraints, acceptance criteria against approach, stated goal against steps, and terminology drift across sections. No repo access needed; this lens reads the plan and nothing else. When a term drift is meaning-bearing, report it as a contradiction in disguise and escalate accordingly (see TERM-DRIFT under "The introspection lenses"). Output: the findings list plus the audit verdict.

## The introspection lenses

Two audits check the plan's own text rather than the code it proposes to change: the **Evidence audit** (does every cited file, line, function, constraint, and prior decision exist and say what the plan claims?) and the **Consistency audit** (do sections contradict each other; has terminology drifted?). They exist in two roles. In deep mode they are fan-out lenses (above). In every mode they are also mandatory checklist sections in the round reviewer's prompt; in deep mode that applies from round 2 onward, since round 1 runs them as the two lenses.

**The current-plan guarantee.** The audits run on the plan as revised through the previous round, never on an older draft; this round's revision is audited by the next round's reviewer. A converging round makes no revision, so the text it audits is the final text, which is what makes the gate sound. Every revision rewrites the plan text, so the introspective surface changes each round: a citation that verified last round can go stale, and an edit can introduce a contradiction no earlier round saw. A round that audits a stale draft has not run the audits; if the dispatch left the reviewer unsure which revision it is reading, re-dispatch.

**Evidence audit checklist.** For each citation in the plan: does the cited file exist at the cited path; does the cited line range contain what the plan says; does the cited function, type, or config value exist with the cited contract; do cited constraints (schema, CI, ownership) hold; do cited prior decisions have a real record (commit, ticket, doc). Finding classes:

- **BROKEN - the citation target does not exist** (file, function, constraint, or decision record). Always blocks.
- **MISQUOTE - the target exists but does not say what the plan claims.** Always blocks.
- **UNVERIFIED-CLAIM - the plan asserts the citation as verified but the auditor cannot check it.** Blocks unless the plan already marks the premise unverified; marked premises route to user questions per the draft rule, and are not findings.

**Consistency audit checklist.** Read the plan's sections against each other: approach against constraints, acceptance criteria against approach, stated goal against steps, and terminology across sections. Finding classes:

- **CONTRADICTION - sections conflict** on fact, requirement, or constraint. Always blocks.
- **TERM-DRIFT - the same concept under different names, or one name carrying two meanings.** A should-fix unless meaning-bearing; when the drift changes what a section requires, it is a contradiction in disguise, report it as a CONTRADICTION, and say so.

**Verdicts.** Each audit returns an overall verdict: **AUDIT PASS** (no findings, or only should-fix term-drift) or **AUDIT FAIL** (any blocking finding). Consensus requires evidence audit PASS and consistency audit PASS alongside the existing conditions. An audit with zero findings is the expected common case for a healthy plan; do not pad with nits.

**On AUDIT FAIL: reroot, do not patch.** An audit failure does not just indicate editing problems; it means an assumption behind the plan's guiding decisions may be off. Find the earliest point in the plan where the wrong conclusion was landed on, find the first place that conclusion is load-bearing, and rethink the plan from that point. Downstream sections are re-derived from the corrected root, not patched in place. The finding classes locate the reroot point: a MISQUOTE on content the revision just edited roots near the edit; a BROKEN citation on untouched content roots at the plan's premise. This is the structured version of a known failure mode: a session that iterates in-place fixes on a contradicting plan loops, the way the September 2026 mid-turn-injection incident looped a session that kept reconstructing its world model after incoming mail contradicted its in-flight plan state (recovery worked only because the work lived in durable state). An unaudited iteration on a contradicting plan fails the same way.

**Observability.** Every round report carries the two audit verdicts and their findings, in labeled sections, even when both are PASS: the refining session and the user see the gate working, not just benefit from it silently. A round report without the two verdict sections is incomplete. A FAIL report names the reroot point and the first load-bearing point.

**Boundaries.** The audits verify; they do not redesign. The Evidence audit overlaps the reviewer's premise-verification by design: the reviewer verifies premises relevant to its findings, the audit sweeps every citation and reports separately. The Evidence audit checks that a cited decision record exists; whether the decision still binds is archaeology and judgment. The revision self-check (loop step 4) is a same-context diff check; the audits are fresh-context whole-plan checks. Both run.

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
- Require the two introspection audits (Evidence audit, Consistency audit) as labeled sections of the report, each with its verdict and findings, even when both are PASS. Make the current-plan guarantee explicit in the prompt: the audits run on the plan as revised through the previous round. On an AUDIT FAIL the round produces a reroot (earliest wrong point and first load-bearing point, both named), not in-place patches.
- Ask it to state whether the plan's own list of affected surfaces is complete or over-broad. Plan authors over-scope and under-scope in equal measure.
- Tell it the repo is read-only for this task.
- If the plan carries a state-and-transition matrix, tell the reviewer to verify each user journey against the matrix. This is the first round's job in particular.
- If the plan carries a deltas-from-template ledger, tell the reviewer to check template-behavior claims against the ledger and not re-derive the twin's behavior from its source. Each ledger row already records what the twin does, verified; independent re-derivation is how contradictory facts about the template flip-flop across rounds.

## Cost control

One reviewer per round in quick mode; one lens fan-out total in deep mode, then quick rounds. Foreground dispatches — the loop is sequential by design, and the fresh-context requirement, not reviewer count, is what buys independence. Parallel reviewers multiply context spend without adding much signal at plan stage.

The introspection audits add no per-round dispatch cost: they are checklist sections inside the reviewer prompt the loop already runs. Deep mode adds two parallel agents to the round-1 fan-out (seven lenses total); the fan-out runs in parallel, so wall-clock latency is roughly flat. Do not split the per-round audits into separate gate dispatches: the verdicts arrive with the round's design findings, and the round's response handles both, reroot on audit FAIL and revision on design findings.

## Relationship to other skills

- **`thatch-refine`** - the type-aware entry point. Different project types need different refinement bars: a team codebase owes coordination and breadcrumbs, a personal project allows cleverness, a shared library owes API hygiene. When the user runs `/thatch/refine` or the project's type should shape the bar, load `thatch-refine` first; it classifies and hands back a thatch-refine-* delta to apply on top of this loop. This skill stays the generic core.
- **`thatch-code-archaeology`** - the research skill for understanding the code; its output is often the plan's input. The archaeology lens is a targeted, plan-scoped re-run of its git-history step, not a replacement for it.
- **`thatch-coding-workflow`** — the procedure skill for executing the refined plan. Refinement ends where coding-workflow begins.
- **`thatch-ticket-description` / `thatch-pr-description`** — if the refined plan feeds a ticket or PR description (or the session iterated on one using this skill), RE-LOAD the appropriate writing skill and draft within its contract. A plan is a working artifact for the session that wrote it; a ticket or PR description is a reader-facing document with its own sections, verbosity budget, and prose rules. Refinement output — findings, accepted risks, review rounds — is SOURCE MATERIAL for those skills, never a substitute for them. This holds the right level of detail for the medium and keeps the writing clear.
- **`thatch-clear-writing`** — for any other human-facing text produced along the way (reports, comments, docs).
- **`thatch-code-review`** — the post-implementation multi-lens pipeline. Same machinery, different artifact and stage. Findings from code review that reveal a plan flaw are a signal to refine the plan for the NEXT change, not to loop backwards.
