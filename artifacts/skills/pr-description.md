---
name: pr-description
description: Draft a PR description using instructional-design scaffolding (SYNOPSIS / PURPOSE / DESCRIPTION / WALK-THROUGH / NOTES) with bold and italic emphasis on the phrases that carry the meaning, so a reviewer skimming only the emphasized fragments still gets the story. Use when the user asks you to write, draft, or update a PR description or PR body, or when running `gh pr create` and no body has been supplied. Do NOT use for commit messages, release notes, or changelog entries.
---

# Writing PR descriptions

## The reader

You are writing for a senior engineer who knows the tech stack and general engineering vocabulary but has never touched this feature, subsystem, or branch. They may not know subsystem-specific jargon or acronyms: a crypto term like DEK, an auth term like the SAML assertion, a scanning term like a ScanRun, a results term like the frozen materialized view. Their goal is to review the diff. Your goal is to raise their baseline understanding just enough that the diff becomes self-explanatory, without making them check out the branch or open a design doc.

The description is not a design doc, changelog, or implementation journal. It is a scaffold that front-loads the context the reviewer needs, didactically layered so they absorb it in the order that makes the diff land.

This is **instructional design**, not documentation. Each section has a cognitive goal for the reader:
- SYNOPSIS: orient to the class of change and affected area.
- PURPOSE: make the reader agree there is a problem worth solving.
- DESCRIPTION: teach the system's current behavior and how this change alters it.
- WALK-THROUGH (when needed): walk the reviewer through the changed workflow step by step.
- NOTES: flag scope limits, intentional regressions, and things AI reviewers will misread.
- robots.txt (when needed): dense, machine-addressed context that heads off recurring false positives from automated reviewers.

Layer the knowledge so each section builds on the previous one. The reader should never encounter a concept in layer N that was not introduced in layer N-1.

AI-authored PRs tend to be large. The description is the reader's lever against that: a good one lets them say "small description, easy to scan" and then read the code critically. A bad one makes them skip the description, wade through the diff cold, and miss intent.

## Structure

Sections, in order: SYNOPSIS, PURPOSE, DESCRIPTION, WALK-THROUGH (conditional), NOTES (conditional), robots.txt (conditional, always last).

**SYNOPSIS, PURPOSE, and DESCRIPTION are mandatory** - even for a one-line, single-concern change. A tiny PR gets short sections, not fewer sections. WALK-THROUGH and NOTES appear only when warranted; omit them when empty. robots.txt appears only after an automated reviewer has produced a false positive worth heading off (see its section); it is always the final section.

**Scale the body to the diff's conceptual size**, not its structure's capacity. A 2-file, single-concern change (add a flag, guard a branch, rename a symbol, bump a constant) is a few lines per section. SYNOPSIS one line, PURPOSE one to three, DESCRIPTION one short paragraph, NOTES if needed. The layered DESCRIPTION machinery below is for changes with real before/after mechanics to teach; when the diff is self-evident once you know the intent, collapse it. If your draft for a small change runs past ~15 lines of body, you are padding. Cut until each remaining line earns its place. Most of this skill's apparatus exists to tame large PRs; applying it wholesale to a small one produces exactly the bloat the skill warns against.

### SYNOPSIS

One to two lines. Orient only. The reader should come away knowing the class of change (bugfix, refactor, feature, revert, infra, cleanup) and the affected area.

SYNOPSIS may use subsystem-specific terms as scan anchors (that is its job). It does not define them. The first teaching section (PURPOSE or DESCRIPTION) picks up that burden. An outsider who does not know the terms should still be able to orient from the plain-English nouns around them.

Include a ticket link if one exists. Format: `Ticket: [PLAT-139](https://<host>/browse/PLAT-139)` on its own line directly under the SYNOPSIS text.

Ticket resolution order (stop at first hit):
1. Branch name (e.g. `plat-139-m3` -> `PLAT-139`). Case-insensitive; ignore trailing `-mN`, `-partN`, `-wip` segments.
2. Commit messages in the PR range (`git log $MERGE_BASE..HEAD` - look for `PROJ-123` patterns or `Refs:`/`Fixes:` trailers).
3. An open draft PR description or linked branch metadata, if available via `gh`.
4. If none of the above yields a ticket, ask the user once: "Ticket for this PR? (or 'none')". Accept `none` to skip, a bare ID (resolve against the project's tracker base URL), or a full URL.

Do not fabricate ticket IDs. If no signal exists and the user says `none`, omit the line entirely rather than leaving a placeholder.

### PURPOSE

Frame the problem. Lead with the conclusion, then provide the evidence, not the other way around. State what is wrong, then explain why. For example:

- "The export endpoint loads every row into memory before serializing, so a large tenant runs the pod out of memory" not "the endpoint allocates a slice per row, and with enough rows... which is why the pod runs out of memory."
- "This handler runs one query per result row, so a page of 50 items fires 51 queries" not "the handler loops over results issuing a query each time... resulting in an N+1 query pattern."
- "The retry loop has no cap, so a persistent failure spins forever" not "the loop re-enters on error without a counter... meaning it never terminates."

The reader should know what the problem is before they read why it happens.

No solution yet. The reader should finish this section agreeing there is something to address, even with zero code knowledge.

Separate the problem from its context. The problem statement is one paragraph. Hazard rating and prior-work context go in a separate paragraph. The reader who already agrees there is a problem can skip the rating; the reader who does not should not have to wade through it to find the problem.

If the change is preventive (no current defect), say why it is worth fixing despite the low risk. "No incident has hit this shape" is a demotivation, not a motivation. Answer "why now?": a prior PR identified it as a follow-up, the API still permits a failure shape, or the next planned change would make it worse. The reviewer's question is "should I spend time on this?" - give them the answer.

When a ticket description is available, use its problem statement as the seed for PURPOSE. But verify it against the actual code. Ticket descriptions can be stale or wrong. If the ticket says "the frobnicator crashes on null input" but the diff shows you fixing a race condition in the frobnicator, the PURPOSE describes the race condition, not the null input. Flag the discrepancy to the user.

### DESCRIPTION

How much structure DESCRIPTION needs depends on the change's conceptual size.

**Small, self-evident change** (add a flag, guard a branch, rename a symbol, bump a constant): collapse to a sentence or two stating what the PR adds/changes. Do not manufacture a "how the code behaves today" paragraph for a change whose intent already makes the diff obvious. That is padding, not scaffolding.

**Medium change with non-obvious before/after mechanics**: three layers, in order. Each layer is as short as possible while remaining honest.

1. **How the existing code behaves.** High-level narrative, not a function walk. Name the key components, their contract, and the specific behavior that matters for this change. Introduce decision points explicitly - they become anchors for layer 2.
2. **What this PR changes.** For each decision point named in layer 1, say what it does now. Keep parallelism: same names, same order. The reader's mental model from layer 1 is the load-bearing structure here.
3. **Why that fixes PURPOSE.** One or two sentences linking the mechanics in layer 2 to the harm named in PURPOSE. If the fix has limits (doesn't cover case Z, follow-up needed), call them out here in one line.

The didactic spine: PURPOSE names a harm, layer 1 names the mechanism, layer 2 changes the mechanism, layer 3 shows the harm is gone. Names carry through. The reader builds one model, not four.

**Large change with a workflow or lifecycle**: keep DESCRIPTION to root-cause and design concept only (what is wrong, what is the approach). Use a separate WALK-THROUGH section for the step-by-step mechanics.

Organize by **workflow or data-flow**, not by touched symbol. A bullet list of API changes reads as disconnected touchpoints. A walkthrough following one object through the system reads as a story. If the change touches a request lifecycle, follow the request. If it touches a data pipeline, follow the data.

### WALK-THROUGH

When the change has a sequence of steps - a lifecycle, a workflow, a data flow through the system - split the mechanics into a numbered WALK-THROUGH. Keep DESCRIPTION to root-cause + design concept only.

Default to a numbered outline. A flat list of steps, with an occasional inline branch ("if the path is not in the registry, return a 404; otherwise continue to step 6"), covers almost every workflow. The bar for a diagram or Mermaid chart is high: reach for one only when the flow genuinely needs two dimensions to read - a graph network with many nodes and edges, or a workflow that recurses, forks, and rejoins in ways a linear outline cannot follow without constant back-references. If the flow is one or two levels deep and does not recurse or redirect, an outline is clearer and cheaper to maintain than a diagram.

Each numbered step states what changed at that stage of the workflow. Bold the **key phrase** that identifies the step (the scan anchor). The rest of the step is plain prose.

Format:

1. **Request enters the handler** - the new guard checks the tenant scope before dispatching.
2. **Validation runs** - the validator now rejects empty payloads that previously passed through.
3. **Database write** - the write happens inside the transaction boundary, not after it.

Rules:
- One step per workflow stage, in execution order.
- State what changed, not what you did. "The handler now checks tenant scope" not "I added a tenant scope check."
- Cut parenthetical API-symbol asides. The diff carries symbol detail.
- Cut rationale asides from steps. If the why matters, it goes in DESCRIPTION layer 3 or NOTES.
- Italics for orientation asides: _This is where the deadlock lived._

### NOTES

Always a `## NOTES` markdown header. Never a bare `Notes:` line ending a section.

Use NOTES for:
- Intentional behavior changes that look like regressions.
- Scope disclaimers (what this PR does NOT do) - max two sentences, no hedging.
- Deferred follow-up items (`Remaining work:` bullet list).
- Ticket scope mismatches (when the PR partially addresses the ticket).
- Anything AI reviewers (Cursor BugBot, CodeRabbit) will misread.

One bullet per item. Bold the **leading noun** in each bullet as the scan anchor.

Each bullet is either a short flag or a self-contained explanation. A short flag names the thing and points to where the full rationale lives: "no singleflight on the load path - see the `mu` field comment." A self-contained explanation states the thing and its reason in plain English, in one or two sentences that a reader with no prior context can parse. Do not compress a paragraph into a subordinate clause. If the rationale needs more than two sentences, it belongs in code comments or the ticket, not in NOTES.

If there are no notes, omit the section entirely. Do not emit an empty `## NOTES` header.

### robots.txt

The final section, and the only one addressed to machines rather than people. Its purpose: head off false positives from automated reviewers (Cursor BugBot, CodeRabbit, a local LLM review pass) that keep misreading the same part of the diff. When a bot flags something that is not a bug because it failed to trace a path upstream or downstream, and a code comment cannot carry enough context to prevent the misread, record the missing context here so the next review round has it.

Render it as a collapsed GitHub details block, not a normal visible section. The summary is literally `robots.txt`. A bot still sees the content in the PR body, and a human can leave it collapsed unless they are broken in the precise way this section requires.

Format:

```md
<details>
<summary>robots.txt</summary>

<!-- robots.txt: context for automated reviewers to prevent recurring false positives.
Add entries as dense as you like; human-legibility rules do not apply below the human-warning line.
Explain what the flagged code does and the intent behind it; never instruct a reviewer to ignore or skip a finding.
Accumulate entries across review rounds. Keep the human-warning line first. -->

Human reader: this section is written for automated reviewers, not people. It will not help you review the diff. Skip it unless you are the specific kind of person who reads terms-of-service agreements for pleasure.

<dense machine-directed entries here>

</details>
```

After the human-warning line, human-legibility rules are suspended. Write for LLM consumption in whatever is densest: no prose scaffolding, no bold, no one-idea-per-sentence, no plain-ASCII constraint. Fragments, symbol soup, and abbreviations are all fine. The only goal is maximum context per token for a machine reader.

What goes here is *explanation and intent*, never suppression. Do not write "ignore the finding about X." Write what X actually does, the invariant it upholds, and the upstream or downstream fact the bot missed, so the bot can re-evaluate and clear its own false positive. A blanket "skip checking X" is a rubber-stamp lever and a prompt-injection surface; refuting a specific misread with a verifiable fact is not.

Entries accumulate. Each review round that surfaces a new false positive adds an entry, so the section grows into a standing set of clarifications that pre-empt the same misreads on the next round.

Because this section is usually added while responding to a bot's comment (not while running this skill end to end), the hidden HTML comment at the top carries editing guidance for the next LLM, which will not have this skill loaded.

Omit the whole section unless there is at least one real false positive to address. It is not scaffolding to fill in preemptively.

## Emphasis for scanning: bold and italics

Bold and italicize the "save points" - the phrases that carry meaning - not whole sentences. A reader who skims *only* the bold and italic fragments should get the story; full prose is for when they want detail.

**What to bold:** phrases that name the **change itself** - the component, the failure mode, the mechanism, the behavior after the change. These are the nouns and verbs that would appear in a diff of the design, not a diff of the code. "There is a **circular wait** in the **KeyManager**" names the failure mode and the component. "**store the result in the in-memory cache**" names the action and the destination.

**What to italicize:** phrases that orient the reader to **significance** - the conclusion a paragraph is building toward, or the outcome that makes the change matter. _There is a circular wait in the KeyManager_ in PURPOSE. _the circular wait cannot form_ in DESCRIPTION's payoff paragraph. Italics mark the load-bearing insight; bolds mark the load-bearing nouns and verbs.

**What NOT to bold or italicize:** history ("PLAT-134 removed the deadlock"), hazard detail ("it only triggers during the first key fetch"), justification ("they are idempotent and cost pennies"), or connective tissue ("the reader should finish this section"). These are context and support; they do not carry the story.

**Where formatting goes:**
- SYNOPSIS: bold the key noun phrases (scan anchor for the whole PR).
- PURPOSE: bold and italicize the conclusion phrase (the problem statement), then bold key nouns in the explanation. Italicize the hazard-motivation insight if there is one.
- DESCRIPTION: bold the mechanism nouns and verbs in each paragraph. Italicize the payoff phrase in the final paragraph (the "why that fixes PURPOSE" sentence).
- WALK-THROUGH step leads: bold the phrase that identifies each step.
- NOTES bullets: bold the leading noun.

Rules:
- Bold once per concept per section. If `rate limiter` appears three times, bold only the first.
- Prefer bolding things (components, states, thresholds, identifiers) and verbs of change (replaces, removes, guards, moves) over adjectives.
- Italicize at most one phrase per paragraph. If two phrases compete, pick the one that carries the paragraph's point.
- Never bold a whole sentence. Never italicize a whole sentence. Never bold a whole bullet.
- In WALK-THROUGH steps and NOTES bullets, the leading noun is usually the right anchor; bold it, leave the qualifier plain.
- A phrase may be both bold and italicized when it is both a change-naming noun and the paragraph's load-bearing insight: **_circular wait_**. Use sparingly.

Scan check before submitting: read only the bold and italic fragments top-to-bottom. If that reading does not convey the shape of the change, you bolded the wrong words (or the prose is padding around them).

## Prose style

These are hard rules, not suggestions.

1. **One idea per sentence.** Split clause-chains. If a sentence has more than one comma separating independent clauses, it is two sentences. One topic per paragraph: if a paragraph shifts from the problem to its risk rating, split it. The reader who skims paragraph leads should get the section's structure.
2. **Literal phrasing beats compressed idiom.** Write for an unfamiliar reader: "assigned at construction" not "baked in". Spell out "perform database operations against a new connection within a transaction" rather than "hidden connection acquisition mid-transaction". Implementation verbs are compressed idiom: do not use method names as verbs in prose. "store the result in the in-memory cache" not "publish it". "check the cache" not "peek the cache". Prefer plain English nouns over code-domain nouns, even when the code-domain noun is technically correct: "reading the row from the database" not "the row read"; "a request waiting for a worker" not "a waiter"; "overwritten with zeros" not "zeroized"; "the queued scan jobs" not "the backlog". If a word sounds like it belongs in a source file rather than a sentence, replace it.
3. **Define subsystem-specific terms on first use.** If a term is specific to this subsystem (not general engineering vocabulary), expand or briefly gloss it the first time it appears in prose. "the DEK (the symmetric key used to encrypt secrets at rest)" not just "the DEK". "the SAML assertion (the signed XML document an identity provider returns to prove who the user is)" not just "the assertion". After the first definition, use the term freely. Definitions go in DESCRIPTION layer 1 or PURPOSE, not SYNOPSIS.
4. **No design-narration phrases.** Delete "it anchors the design", "the fix", "this change", "the new approach". State the fact plainly.
5. **No authoring-sequence narration.** Never describe the order you assembled things in, which commit does what, or what a later commit will add. Describe the PR as it stands. Pending work goes in a `Remaining work:` bullet list under NOTES.
6. **Italics for orientation asides.** Use `_italics_` for a one-phrase aside that orients the reader: _This is where the deadlock lived_. Not for emphasis.
7. **Plain ASCII only.** No smart quotes, smart apostrophes, em dashes, en dashes, ellipsis glyphs, or arrow glyphs. Use plain hyphens (sparingly) for asides; semicolons are often better.
8. **No buzzwordy abstractions.** If a phrase sounds like it is trying to sound smart, cut or replace it. Name the code and behavior directly. "identity contract" -> "the struct field that identifies the owner". "canonical hash" -> "the SHA-256 we compute on ingestion".
9. **Avoid loaded language.** Use neutral, current terminology unless the repo's established name is different. Prefer allowlist/blocklist over whitelist/blacklist, primary/replica over master/slave, and precise role names over moralized labels like "bad" or "evil".
10. **No parenthetical API-symbol asides in WALK-THROUGH steps.** The diff carries symbol detail. If the reader needs the function name, they will find it in the diff.

## Length and style

Target: the reader can take in the whole description in under 60 seconds. Err on the shorter side.

Scale the body to the diff's conceptual size:
- Trivial 2-file change: ~15-line ceiling. SYNOPSIS one line, PURPOSE one to three, DESCRIPTION one short paragraph, NOTES if needed.
- Moderate refactor: one tight paragraph or bullet set per section.
- Large change with WALK-THROUGH: as long as the walkthrough needs, but no longer. Each step earns its place.

If your draft for a small change runs past ~15 lines of body, you are padding. Cut until each remaining line earns its place.

Inside sections, telegraphic bullet style is fine: lowercase start, abbreviations (`w/`, `1x`, `~`), parenthetical shorthand. Full sentences only when required for clarity. The section headers are the only formal structure.

**GitHub rendering**: GitHub renders a single newline as a visible hard line break, not a soft-wrap join. Put each narrative paragraph on one physical line. Separate paragraphs with a blank line. Bullets stay one per line. Do not split a paragraph across multiple physical lines; GitHub will render each line break as a separate visible line.

## Ticket context and plan changes

When a ticket is resolved (see SYNOPSIS ticket resolution order), fetch its description before drafting. The ticket is context for the PR description, not a checklist for code review. Use it to understand the original plan, then explain only the differences a reviewer needs to know.

Context process:
1. Fetch the ticket description. Resolution order by tracker:
   - **Linear**: use the `linear_get_issue` MCP tool if the Linear server is connected.
   - **Jira**: use `webfetch` on the Jira URL, or the Jira MCP tools if connected.
   - **No MCP or CLI access**: ask the user to paste the ticket description.
2. Use the ticket's problem statement as the seed for PURPOSE, but verify it against the actual code. Ticket descriptions can be stale or wrong.
3. Treat the ticket's proposed approach and acceptance criteria as the original plan. Look for reviewer-relevant changes from that plan:
   - revisions over the original approach;
   - pivots caused by the actual state of the code;
   - things learned after the ticket was written;
   - ticket items intentionally deferred or made unnecessary by implementation reality.
4. Include only the plan changes that help a reviewer understand the diff. Put them where they belong: PURPOSE if they change the problem framing, DESCRIPTION if they change the design concept, WALK-THROUGH if they change the workflow, NOTES if they are scope boundaries or follow-ups.
5. If the PR truly does not match the ticket at all, stop and ask the user before drafting. That is a coordination issue, not PR-description material.

Do not turn this into a code-review checklist. The PR description does not need to prove every acceptance criterion was met. It needs to explain how the PR as implemented relates to the plan reviewers saw in the ticket.

When there is no ticket, skip this step. The rest of the process works the same; PURPOSE is seeded from the diff and commit messages instead.

## Link verification

Before posting or updating a PR body, verify every link you can. Broken links in PR descriptions waste reviewer time and make the surrounding prose less trustworthy.

- **Ticket and PR links** - verify the ID and title match the thing being referenced.
- **Repo file links** - prefer GitHub links when the PR description needs to send reviewers to a file outside the diff; verify the path exists on the relevant branch.
- **External docs** - if tooling can fetch the URL, confirm it resolves and appears to be the intended doc. If you cannot verify a user-provided doc link, keep it but do not claim you verified it.
- **Reference-style footers** - avoid stale auto-generated Jira/GitHub reference footers. If a Linear ticket link would create a stale Jira footer for `[PLAT-123]`, use link text like `[Linear PLAT-123](...)` instead.

## Defensive phrasing for AI reviewers

Cursor BugBot, CodeRabbit, and similar will read the description and judge the diff against it. Pre-empt misreads by calling out in NOTES:

- Intentional behavior changes that look like regressions ("old fallback path is gone on purpose - see PURPOSE").
- Deletions that might look like accidental losses.
- Renames where grep for the old name returns nothing.
- Scope disclaimers (what this PR does NOT do) - max two sentences, no hedging.

One line each. Fold into NOTES as bullets.

## What does NOT belong in the description

- File inventories (`modified X, Y, Z`). The diff shows this.
- "Notable design decisions" sections. Rationale goes in code comments at the decision site.
- Line-by-line commentary. That is PR review, not description.
- Test plans, unless the reviewer cannot infer them.
- AI attribution, co-author lines, "generated with" footers.
- Backstory that does not affect review ("we explored approach A then B then landed on C").
- **Authoring-process / commit-sequence narration.** e.g. "this first commit pins the naming; the instrumentation lands as follow-up commits", "first I... then...", "as a next step this branch will...". This is the single most common AI tell. Describe the change as it stands, never the order in which you assembled it. If a draft has pending work worth flagging, use a trailing `Remaining work:` bullet list under NOTES.

## Worked examples

### Small change (collapsed DESCRIPTION)

    ## SYNOPSIS
    Narrow the **rotation advisory lock** to DB writes only; release across KMS I/O.

    Ticket: [PLAT-412](https://example.atlassian.net/browse/PLAT-412)

    ## PURPOSE
    The secret rotation worker currently holds a Postgres advisory lock for the full rotation batch, including network I/O to KMS. A batch of 500 keys blocks all other rotations for ~3 min, stalling unrelated tenants sharing the worker pool.

    ## DESCRIPTION
    `rotateBatch` acquires `pg_advisory_lock(rotation_ns)` once, then loops: read key, call KMS encrypt, write ciphertext, advance cursor. The lock spans the whole loop.

    This PR moves the lock acquisition inside the loop, around only the DB read+write. KMS calls run unlocked. Cursor advancement unchanged.

    Net effect: concurrent rotations for other tenants no longer block on KMS I/O, removing the stall in PURPOSE. A crash mid-batch resumes from the cursor, which was already the behavior on any non-lock failure.

    ## NOTES
    - **lock is no longer held across KMS** - intentional narrowing, not a regression.

### Large change (with WALK-THROUGH)

    ## SYNOPSIS
    Move **connection acquisition** inside the transaction boundary to prevent **lock leaks across retry loops**.

    Ticket: [PLAT-501](https://example.atlassian.net/browse/PLAT-501)

    ## PURPOSE
    The batch processor opens a database connection before entering the retry loop, then begins a transaction inside each retry attempt. If a retry fails and the loop continues, the connection is reused for the next attempt without releasing the transaction savepoint. This holds locks from the failed attempt across the retry, blocking concurrent writers.

    ## DESCRIPTION
    The root cause is a mismatch between connection lifecycle and transaction lifecycle. The connection is acquired once and held for the whole batch. The transaction is per-attempt but the savepoint release is skipped on error. The fix is to acquire a fresh connection per attempt, so each retry starts with a clean connection and a clean transaction boundary.

    ## WALK-THROUGH

    1. **Batch processor receives work item** - the handler now calls `acquireConnection` per attempt instead of once at the top.
    2. **Connection enters transaction** - `BEGIN` is issued immediately after acquisition, so the connection and transaction lifecycles are aligned.
    3. **Work executes** - the batch runs its queries inside the transaction. _This is where the lock leak originated: the old code held the connection open across retries, dragging the previous transaction's locks into the next attempt._
    4. **Retry on failure** - on error, the connection is released and a new one is acquired for the next attempt. The savepoint from the failed attempt is gone with the connection.
    5. **Commit on success** - the transaction commits and the connection is released. Clean exit.

    ## NOTES
    - **connection pool pressure** - acquiring per attempt increases pool churn under heavy retry load. Acceptable because retries are rare (observed <0.1% in prod).
    - **PLAT-501 scope** - this addresses the lock leak. The retry backoff strategy described in the ticket is deferred to a follow-up.

Scan the bolds only:
> rotation advisory lock ... KMS I/O ... connection acquisition ... lock leaks across retry loops ... Batch processor receives work item ... Connection enters transaction ... Work executes ... Retry on failure ... Commit on success ... lock is no longer held across KMS ... connection pool pressure ... PLAT-501 scope

That reading alone conveys the shape and scope of both changes. The prose is for when the reader wants the full picture.

## Process

1. **Gather**: `git log $MERGE_BASE..HEAD`, `git diff $MERGE_BASE..HEAD --stat`, commit messages, current branch name. Apply the ticket resolution order (SYNOPSIS section) - infer first, ask only if nothing matches. Skim the diff; identify decision points (components or branches where behavior differs before vs after). Identify the workflow or lifecycle path if the change has one.
2. **Read ticket context**: if a ticket is resolved, fetch its description. Use it to seed PURPOSE and identify reviewer-relevant plan changes: revisions, pivots caused by code reality, discoveries after the ticket was written, and deferred or unnecessary ticket items.
3. **Draft PURPOSE first**, in one breath, without looking at code. If you cannot state the harm in two sentences, you do not understand the PR yet. Go back and read. When a ticket is available, seed PURPOSE from its problem statement, but verify against the code.
4. **Write DESCRIPTION**: choose the right depth (collapsed for small, three-layer for medium, root-cause + concept for large with WALK-THROUGH). Name everything you will refer to later. Organize by workflow/data-flow, not by touched symbol.
5. **Write WALK-THROUGH** (if needed): numbered steps in execution order. Bold the step leads. State what changed, not what you did.
6. **Write SYNOPSIS last** - it is a compression of PURPOSE + the core mechanic.
7. **Bold and italicize the save points** in the allowed locations. Bold phrases that name the change (components, mechanisms, behaviors). Italicize phrases that orient to significance (conclusions, payoffs), at most one per paragraph. Apply the scan check: read only the bold and italic fragments and verify the shape comes through.
8. **Add NOTES** for AI-reviewer defensive lines, scope disclaimers, ticket scope mismatches, and remaining work. Use `## NOTES` header. Omit if empty.
9. **robots.txt only when earned**: do not add it during initial authoring. It is added later, in response to an automated reviewer's false positive (see its section). When you do add it, use the collapsed `<details>` format with `<summary>robots.txt</summary>`, keep the editing HTML comment at the top of the block, and keep the human-warning line first after the comment.
10. **Verify links**: check ticket/PR links, repo file links, and external docs where tooling allows. Do not claim an unverified link was verified.
11. **Verify prose style**: check each rule in Prose style. Cut design-narration, authoring-sequence, and buzzwordy abstractions. Verify plain ASCII. Verify first-use definitions for subsystem jargon. Verify plain English nouns (no code-domain nouns in prose). Verify conclusion-first in PURPOSE. Verify NOTES bullets are either short pointers or self-contained. Verify one-paragraph-one-physical-line for GitHub rendering. The robots.txt section is exempt from these prose rules below its human-warning line.
12. **Verify length**: if the body exceeds the ceiling for its conceptual size, cut until each line earns its place.
13. **Submit** via `gh pr create --body "$(cat <<'EOF' ... EOF)"` to preserve formatting.

## Anti-patterns

- **Burying the harm.** If PURPOSE is a paragraph of setup before the actual problem, rewrite. Problem first.
- **Layer 2 introduces new names.** If layer 2 mentions components layer 1 never named, the scaffold broke. Go back, add them to layer 1, or drop them from layer 2.
- **Emphasizing filler words.** Bolding "this", "the", "we", or adjectives produces scan noise. Bold only nouns and verbs that carry meaning.
- **Bolding filler or context.** Bolding history, hazard detail, justification, or connective tissue creates scan noise. Bold the change itself (components, mechanisms, behaviors); italicize the significance (conclusions, payoffs). Not the scaffolding around them.
- **Over-italicizing.** More than one italicized phrase per paragraph dilutes the signal. Pick the one phrase that carries the paragraph's point.
- **Design-doc DESCRIPTION.** If layer 1 is a function walkthrough or architecture essay, you are writing for yourself, not the reviewer. Compress to the decision points.
- **Matching the diff line-by-line.** The description is orthogonal to the diff, not a prose projection of it.
- **Over-claiming scope.** A fix for a sloppy implementation is "fix a sloppy implementation," not "harden the foo subsystem." Match energy to reality.
- **Narrating your own process.** Any sentence about the order you did things, which commit does what, or what a later commit will add. Reads as AI slop. Change-as-it-stands only.
- **Orphaned synopsis.** A bold lead paragraph with no `## SYNOPSIS` header above a body that does use headers. Add the header; it is mandatory.
- **Bare `Notes:` line.** Use `## NOTES` header or omit the section entirely.
- **Organizing by touched symbol.** A bullet list of "changed X in file A, changed Y in file B" reads as disconnected touchpoints. Follow the data flow.
- **Buzzwordy abstractions.** "identity contract", "canonical hash", "check in isolation" - if it sounds like it is trying to sound smart, replace it with plain concrete wording.
- **Loaded language.** Using avoidable loaded terms when neutral terms exist. Prefer allowlist/blocklist, primary/replica, and precise role names.
- **Smart punctuation.** Em dashes, smart quotes, ellipsis glyphs. Use plain ASCII.
- **Splitting paragraphs across lines.** GitHub renders each line break as a visible break. One paragraph = one physical line.
- **Ungrounded jargon.** Subsystem-specific terms used in SYNOPSIS but never defined in PURPOSE or DESCRIPTION. An outsider reads "frozen matview reverification" in SYNOPSIS and hits a wall. Define on first use in the teaching sections.
- **Implementation verbs in prose.** "Publish the key" reads as jargon to someone who does not know the method is called `publish`. Say "store the key in the in-memory cache".
- **Code-domain nouns in prose.** "Row read", "waiter", "zeroized", "backlog" (as jargon) are technically English but belong in source files, not sentences. Replace with plain English: "reading the row from the database", "a request waiting for a worker", "overwritten with zeros", "the queued scan jobs".
- **Conclusion buried at the end.** PURPOSE that builds to its point in the last sentence forces the reader to absorb the explanation before knowing what is being explained. Lead with the problem, then explain why.
- **Hazard rating without motivation.** "No incident has hit this shape" answers "how bad?" but not "why review this?" Answer "why now?" so the reviewer can decide whether to invest time.
- **NOTES bullets that are both wordy and terse.** A bullet that compresses a paragraph of rationale into one dense sentence reads as a private note. Either flag the thing and point to the full explanation, or write a self-contained sentence or two. Not the middle thing.
- **robots.txt as a suppression lever.** Writing "ignore the finding about X" or "skip checking X" in robots.txt turns it into a rubber stamp and a prompt-injection surface. Explain what X does and the intent behind it so the reviewer clears its own false positive; never instruct it to stop looking.
- **Preemptive robots.txt.** Adding the section before any automated reviewer has actually produced a false positive. It is a response to a demonstrated misread, not scaffolding.
