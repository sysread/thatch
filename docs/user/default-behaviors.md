# Default Behaviors

Thatch auto-seeds a set of default behaviors into the global store on
first run. These are self-discipline rules the agent follows when your
prompt matches the trigger context. They fire across all projects
without manual setup.

## How it works

Default behaviors use the behavior engine (see
[behavior-engine.md](behavior-engine.md)). On every prompt, thatch
embeds the text and searches for matching behavior matchers. If a
matcher scores above the threshold (default 0.60), the behavior is
injected as a `Situational behaviors` nudge.

The rules are plugin-owned. The agent can ham/spam them (adjust
confidence, controls whether they fire) but cannot change the behavior
text or trigger. When thatch updates a default behavior in a new
release, the old version is automatically replaced on next startup.

## What ships

| Rule | Fires on | What it does |
|------|----------|-------------|
| Session wrap-up | "wrapping up," "loose ends," "signing off," "clean up" | Check git status, untracked files, stale artifacts before the session ends. Read-only. |
| Work finalization | "committing," "merging," "closing out," "ready to merge," "shipping" | Check git status, branch memory consolidation, follow-up TODOs. Read-only. |
| Research new project | "new project," "unfamiliar codebase," "new ticket" | Check coverage, naming drift, migration evidence. Load archaeology skill. |
| Day turnover (coding) | "continuing from yesterday," "picking up where I left off" | Check how far origin/main moved since merge-base, suggest rebase. |
| Day turnover (PR) | "continuing the PR," "picking up the branch" | Check for new upstream review comments on the open PR. |
| Day turnover (review) | "continuing the review," "picking up the review" | Check for new upstream comments and responses to our comments. |
| Snag or dead end | "dead end," "red herring," "that did not work" | Save a memory about the wrong path so future sessions skip it. Save-only. |
| Debugging archaeology | "debugging," "why is this broken," "what changed" | Git archaeology before proposing a fix. Look for orphaned code from removed behavior. |
| Planning archaeology | "planning a change," "how should we approach" | Git archaeology to understand design intent before proposing changes. |

## Version-gated updates

Each default behavior carries a version stamp in its rationale text.
On startup, thatch compares the stored stamp against the current
package version. If they differ (the behavior was seeded by an older
release), the old behavior is deleted and the new one is created
with the updated content. This mirrors how stale skill cleanup
works: updating a behavior in a new release automatically replaces
the old version on every install.

## Customizing

You cannot edit the default behaviors directly (they are
plugin-managed). But you can:

- **Ham/spam them**: Call `thatch_behavior_feedback` with
  `relevant: true` or `relevant: false` when a default behavior
  surfaces. This adjusts confidence and controls whether it fires
  in future sessions.
- **Add your own**: Call `thatch_behavior_codify` to add custom
  rules for situations the defaults don't cover. Custom behaviors
  coexist with the defaults.
- **Delete a default**: Call `thatch_behavior_delete` with the
  behavior statement text. This removes it, but it will re-seed on
  next startup if it's still in the defaults list. To permanently
  remove a default, it must be removed from the thatch source code.

## Limitations

- Default behaviors live in the global store. They fire across all
  projects. There is no per-project default behavior.
- The trigger is semantic (cosine on the situation text), not keyword
  matching. A prompt that means the same thing but uses different
  words will still match. A prompt that uses the same words but means
  something different may false-fire.
- The 0.60 threshold is tuned to reduce false fires. If you see
  unwanted behavior nudges, ham them (relevant: false) to lower
  confidence. If you see missing nudges, check the threshold.

See [behavior-engine.md](behavior-engine.md) for the full engine
documentation and [skills.md](skills.md) for the skill system.
