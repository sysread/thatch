# Plan: pr-description change-first calibration

Status: ready to implement. Scope decisions taken; see [Scope decisions](#scope-decisions).

## Background

On thog PR #7561 (`[PLAT-426] SecretMetaCache tables, triggers, and deletion teardown`), Jeff hand-edited a `thatch-pr-description` draft and had the authoring session articulate the deltas between the skill's instructions and his edits. The articulation over-generalized in two places, and Jeff corrected it in review. The corrected calibration, which this plan implements into the skill:

- The description states what IS; it never argues. Facts in sequence persuade; drama and defense are the AI tell.
- But the lesson is **ratio and placement, not presence bans**: describing the problem is fine when it is brief and comes after the change; justification is fine when the behavior is unintuitive and the why is one brief, high-level sentence.
- The governing failure mode in every case is **dominance**: an all-problem synopsis, a PURPOSE taken over by a failure saga, defenses interleaved through the walkthrough.

Jeff's correction, verbatim: *"describing the problem being solved is not the problem. it's making the entire synopsis be a description of the problem being solved, rather than a 'do X to fix Y'. the synopsis isn't Y alone. it's a very brief Y, AFTER X."* And on DESCRIPTION: *"the primary purpose of the description is to walk the reviewer through the changes. if the overall behavior of the change is unintuitive, it gets a brief, high level explanation of why it had to be this way ... a paragraph where every sentence is followed by 2-3 sentences describing what was being worked around in detail makes the primary function illegible ... it's like the problem with golang code; you can't read the business logic because it's interleaved with `if err != nil {` blocks."*

## Calibration, per section

### SYNOPSIS: do X to fix Y

Lead with what the change does; a very brief statement of the problem may follow it. The anti-pattern is a synopsis that is all Y, no X: "makes the schema safe to deploy" is a certification, not a change. This supersedes the articulation's own "hazard framing belongs in NOTES, never the TLDR" line.

The skill's worked example 2 SYNOPSIS ("Move **connection acquisition** inside the transaction boundary to prevent **lock leaks across retry loops**") is already X-then-brief-Y and stays unchanged, including its scan-check line.

### PURPOSE: premise + mechanism, no saga

One sentence stating the premise — the defect, or the pivot the change serves — then feature-level mechanism teaching: the shortest version that makes DESCRIPTION's details parse. No failure narratives, no urgency arguments ("this PR prevents that before any worker exists" was cut verbatim on #7561). Harm evidence is not deleted; it is demoted into DESCRIPTION layer 1 as existing-behavior fact ("refreshes the whole view on a cycle that reaches hours, so the UI and the get-secrets API trail the base tables").

This replaces the skill's preventive-change paragraph ("say why it is worth fixing despite the low risk ... Answer 'why now?'"), which is what generated the drama, and retires the "Hazard rating without motivation" anti-pattern. That machinery came from the PLAT-135 coworker round; the PLAT-426 round supersedes it for PR descriptions.

### DESCRIPTION: the spine is the walkthrough

DESCRIPTION's primary job is "what does this do and how", readable straight through. Justification appears only where the overall behavior is unintuitive, as one brief, high-level sentence. Endorsed shape (Jeff's example):

> Note that the ON DELETE CASCADE constraints had to be applied manually in a subsequent migration, as django does not support database-level referential constraints.

Banned shape: every change sentence followed by two or three sentences of workaround detail, interleaved, so the reader has to skip around to reconstruct the what-and-how. Detailed workaround narratives are NOTES bullets (stated as facts); prose does not repeat NOTES detail. Factual scope stays in prose ("minus the view's always-empty soft-delete columns" survived the edit on #7561).

Layer 3 ("why that fixes PURPOSE") becomes conditional: keep the net-effect line when PURPOSE names a defect; omit it when PURPOSE is a pivot statement — the payoff is the feature itself. The #7561 body demonstrates the omission.

### NEXT STEPS: demarcated forward scope

When DESCRIPTION includes follow-up work, demarcate it as a `### NEXT STEPS` subsection instead of leaving it inline and undemarcated (the failure mode observed on #7561): what the follow-up does, framed by the economic property that justifies the split ("amortizing the cost of updates to the cache"), not just the raw number. Link the ticket when it exists. NOTES `Remaining work:` stays for unfinished work inside the PR itself.

### Confirmed as correct

WALK-THROUGH before/NOW steps and self-contained factual NOTES bullets survived Jeff's edit untouched; no changes there.

## Skill edits

Target file: `artifacts/skills/thatch-pr-description.md`. Then copy to the deployed skill dir, `~/.config/opencode/skills/thatch-pr-description/SKILL.md` (currently byte-identical to the repo source; `diff` verifies after the copy).

1. **SYNOPSIS section**: add the change-first rule; add a "problem-only synopsis" anti-pattern.
2. **PURPOSE section**: replace the preventive/why-now paragraph with premise-plus-mechanism; keep the existing one-sentence problem examples (they are already factual); reword "No solution yet" into an altitude rule (PURPOSE stays at feature level; table-level mechanics belong to DESCRIPTION).
3. **DESCRIPTION section**: add the spine rule with the endorsed example; make layer 3 conditional; add the interleaving ban with the err-nil image.
4. **NEXT STEPS**: new guidance for a `### NEXT STEPS` subsection under DESCRIPTION; add it to the structure list as a conditional sub-part, and to the "each section has one job" list.
5. **Anti-patterns**: add "problem-only synopsis", "interleaved defenses", "failure-saga PURPOSE"; delete "Hazard rating without motivation".
6. **Process**: step 4 becomes "state the premise in one sentence" (not "state the harm in two sentences"); step 5 gains NEXT STEPS; step 13 clarity pass checks for failure drama, interleaved defenses, and a synopsis that leads with the change.

## Scope decisions

- **PR skill only.** The ticket-description skill keeps its PROBLEM why-now machinery this round. The mapping was worked out (SYNOPSIS and PROPOSED APPROACH transfer cleanly; ticket PROBLEM is a Y-section by design, so the inversion does not apply) and the transfer was deferred.
- **Untouched**: WALK-THROUGH, NOTES, robots.txt, the emphasis machinery, and the length budgets.
- **No counting rule** for word budgets; the parked `wc -w` decision stands.

## Verification

- Repo source and deployed SKILL.md are byte-identical after the copy (`diff`).
- The edited skill is tested against the calibrated artifact — the #7561 body as Jeff left it: SYNOPSIS conforms to X-then-brief-Y; PURPOSE is premise + mechanism; the FK line matches the endorsed one-sentence justification shape; NEXT STEPS is demarcated with economic framing.
- Worked examples and scan-check lines are internally consistent: no example still teaches a banned form.
