# Behavior Engine

Thatch lets your agent codify self-discipline rules: "when situation X
arises, I should do Y." These are the agent's own operational rules,
not your preferences (those are predictions). The agent grades its own
rules with ham/spam feedback.

## How it works

Each behavior has two parts:

- **Matcher**: a description of the situation that triggers the
  rule ("about to commit changes to the repo"). Embedded and matched
  against your prompt.
- **Behavior**: the rule itself ("run mise run check before
  committing"). What the agent reads and follows.

When your prompt matches a behavior matcher above the threshold
(default 0.60), thatch injects a `Situational behaviors` block into
the agent's context. The block looks like:

```text
[thatch] Situational behaviors
- [0.58 conf, 1 tests] When about to commit changes to the repo:
  do Run mise run check (tsc + bun test + markdownlint) before
  committing. Never commit code that fails the quality gate.
```

The agent evaluates each surfaced rule against the current situation.
If relevant (ham), it follows the rule and calls `behavior_feedback`
with `relevant: true`. If not relevant (spam), it calls
`behavior_feedback` with `relevant: false`. This trains the classifier
so future nudges are more accurate.

## Default behaviors

Thatch auto-seeds a set of default behaviors into the global store on
first run. These fire across all projects without manual setup:

| Rule | Fires on | What it does |
|------|----------|-------------|
| Session wrap-up | "wrapping up," "loose ends," "signing off" | Check git status, untracked files, stale artifacts before the session ends. Read-only. |
| Work finalization | "committing," "merging," "closing out," "ready to merge" | Check git status, branch memory consolidation, follow-up TODOs. Read-only. |
| Research new project | "new project," "unfamiliar codebase," "new ticket" | Check coverage, naming drift, migration evidence, load archaeology skill. |
| Day turnover (coding) | "continuing from yesterday," "picking up where I left off" | Check how far origin/main moved since merge-base, suggest rebase. |
| Day turnover (PR) | "continuing the PR," "picking up the branch" | Check for new upstream review comments on the open PR. |
| Day turnover (review) | "continuing the review," "picking up the review" | Check for new upstream comments and responses to our comments. |
| Snag or dead end | "dead end," "red herring," "that did not work" | Save a memory about the wrong path so future sessions skip it. Save-only. |
| Debugging archaeology | "debugging," "why is this broken," "what changed" | Git archaeology before proposing a fix, look for orphaned code from removed behavior. |
| Planning archaeology | "planning a change," "how should we approach" | Git archaeology to understand design intent before proposing changes. |

Default behaviors are plugin-owned. The agent can ham/spam them
(adjust confidence, controls whether they fire) but cannot change the
behavior text or trigger. When thatch updates a default behavior in a
new release, the old version is automatically replaced on next startup.

## Tools

| Tool | What it does |
|------|-------------|
| `thatch_behavior_codify` | Create a self-discipline rule: situation, behavior, rationale. |
| `thatch_behavior_feedback` | Record ham/spam feedback on a surfaced behavior. `relevant: true` confirms; `relevant: false` disconfirms. |
| `thatch_behavior_list` | List all codified behaviors with matchers, confidence, and provenance. |
| `thatch_behavior_delete` | Delete a behavior by semantic match. Edges and provenance are cascade-deleted. |

## Configuration

- `THATCH_BEHAVIOR_THRESHOLD`: cosine score threshold for behavior
  auto-fire. Defaults to 0.60. Same rationale as prediction threshold.

## Limitations

- Behaviors are the agent's own rules, not your preferences. Use
  `thatch_prediction_update` for user preferences instead.
- The agent creates behaviors based on its own judgment. Thatch never
  creates behaviors on its own (except the default seeds).
- Ham/spam feedback adjusts confidence but never reaches 0 or 1.
  Delete a wrong behavior with `thatch_behavior_delete`.
- Behaviors are per-store. The default behaviors live in the global
  store (shared across projects). Agent-codified behaviors default to
  the project store.

See [memory.md](memory.md) for the base memory system and
[prediction-engine.md](prediction-engine.md) for the user decision
model.
