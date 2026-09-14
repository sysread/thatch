---
name: thatch-clear-writing
description: Prose rules for every piece of text a human reads that no dedicated skill already covers - PR and ticket comments posted on the user's behalf, documentation, feature plans, reports, write-ups, status updates, and chat replies to the user. Load it before drafting any of those. When a dedicated writing skill is loaded (thatch-pr-description, thatch-ticket-description, thatch-review-response), that skill's rules win.
---

# Clear writing

## Core principle

Write for humans. Not for LLMs. Not to impress. Not to pad.

Every sentence earns its place or gets cut. Plain English over jargon. Concrete over abstract. If a phrase sounds smart but you cannot say it in simpler words, it is a buzzword. Cut or replace it.

Target a 7th-grade reading level. Short sentences, common words, one idea each. The concepts stay technical; the language stays simple.

## Where these rules apply

Every text a human reads:

- **Comments you post for the user** - PR comments, ticket comments (Linear, Jira), replies to reviewers, replies to bot findings.
- **Written artifacts** - documentation, feature plans, reports, write-ups, design notes, status updates.
- **Replies to the user in chat** - explanations, summaries, answers.

Same prose rules everywhere. Only the structure differs:

- **Artifacts** may use sections, headings, and bullets as the content needs.
- **Chat replies** use no scaffold. Lead with the answer, then the context, then the caveats. Short, but never compressed into shorthand to make it short.

A dedicated writing skill overrides this one when loaded: `thatch-pr-description` for PR bodies, `thatch-ticket-description` for ticket descriptions, `thatch-review-response` for replies on the user's own PR, the review skills for review reports. Use those where they fit. This skill covers everything they do not.

## The reader

A busy engineer with zero context on this task. They know the stack and general engineering vocabulary. They have never touched this area. They read once, top to bottom, and every sentence must parse on the first read.

## Ordering

Lead with the answer. Then the evidence. Then the caveats.

The reader decides when to stop reading. Give them the point first so stopping early is safe. Never build to a reveal.

- First sentence or two: the conclusion, the answer, or the request.
- Then: why. The mechanism, the evidence, the reasoning.
- Last: caveats, open questions, alternatives considered.

## Prose rules

Hard rules. Not suggestions.

1. **One idea per sentence.** Split clause-chains. One topic per paragraph.
2. **Literal phrasing beats compressed idiom.** Write for an unfamiliar reader. Do not use method names as verbs. Prefer plain English nouns over code-domain nouns: "reading the row from the database" not "the row read"; "a request waiting for a worker" not "a waiter". If a word sounds like it belongs in a source file rather than a sentence, replace it.
3. **Define subsystem-specific terms on first use.** General engineering vocabulary needs no definition. "the DEK (the symmetric key that encrypts secrets at rest)" - yes. After the first definition, use the term freely.
4. **Translate project-private labels.** Roadmap names, subsystem nicknames, ticket shorthand, and branch-local labels are not explanations. Say what the code does first: what reads, writes, blocks, retries, or changes. The label can follow if it helps the reader connect prose to code.
5. **Prefer concrete over ambiguous.** If a word can mean more than one thing here, qualify it or replace it with the specific behavior. Ordinary words can be ambiguous when the code gives them a special role: claim, owner, active, current, publish, resolve, sync, scope. "Persist the value in the database so the UI can display it" beats "publish the value".
6. **Explain operations before naming them.** Refresh, repair, coalesce, reconcile, normalize, hydrate, fan out - these are not explanations. Name the object, the action, and the effect: "The worker waits up to 5 seconds, then reloads each stale cache key once."
7. **Name both sides of a contrast.** If timing, ownership, or behavior changed, state the old behavior and the new close together.
8. **Show causal links.** If a sentence uses "so", "because", or "prevents", make the middle step visible. Cause and effect that do not obviously touch need the missing step spelled out.
9. **Clarity wins over compression.** Brevity means fewer claims, not denser claims. Shorten by deleting whole claims. Never rewrite surviving sentences into tighter ones. Keep the connective tissue that makes a sentence parse on first read.
10. **No invented shorthand.** Do not coin abbreviations, portmanteaus, or labels mid-text. Use the real name, or spell out the behavior. A term the reader cannot find anywhere else is a term they cannot look up.
11. **No buzzwordy abstractions.** "leverage" -> "use". "utilize" -> "use". If you cannot say what a phrase means in plain English, it does not belong.
12. **Plain ASCII.** No smart quotes, em dashes, or ellipsis glyphs.
13. **No process narration.** Never describe the order you assembled things in or narrate your own actions inside the text. State the thing itself.

## Length

Match length to complexity: how much new mental model the reader must build.

- A one-line answer gets one line.
- A real explanation gets as many sentences as the idea needs, and not one more.
- When over length, cut the lowest-value claim. Do not compress the survivors.

For chat replies: terse is fine, illegible is not. If a two-line answer only fits by inventing shorthand, spend five lines.

## Clarity pass

Before you post, save, or send: reread the draft as a reader with zero context. Fix what they would stumble on. Do not announce the pass; just return clean prose.

Check: Does every sentence parse on first read? Does every term carry its plain-English meaning before or with the label? Would a reader who has never seen this codebase, ticket, or conversation understand it? If the draft runs long, cut a claim; never tighten the grammar.
