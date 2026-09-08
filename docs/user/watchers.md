# Watchers

Watchers monitor external sources - today, GitHub pull requests and
branches - and inject a notification into the conversation when
something happens. You ask the agent to watch a PR or a branch; thatch
polls it in the background; the agent gets woken up when a watched
event occurs. No one has to keep asking "any updates yet?"

## What it does

The agent calls `thatch_watch_create` to register a watcher on a PR,
or `thatch_watch_branch_create` to register a watcher on a branch
(typically main). thatch captures the target's current state as a
baseline, then polls the GitHub API through the `gh` CLI once a
minute. When the target changes in a way the watcher cares about, the
plugin prompts the agent with a notification.

PR watched events:

- `pr_comment` - new top-level comments on the PR
- `pr_review_comment` - new inline comments on the diff
- `pr_review_reply` - replies to an existing review comment
- `pr_review_resolved` - a review thread resolved or reopened
- `pr_commit` - new commits (the head SHA moved)
- `pr_status` - the PR opened, closed, or merged
- `pr_description` - title or description edited
- `pr_ci` - a CI check run on the head SHA completed

Branch watched events:

- `branch_commit` - new commits land on the branch (e.g. a PR merged)
- `branch_ci` - a check run on the branch head completed
- `branch_workflow` - a GitHub Actions workflow run starts or finishes
  on the branch, optionally filtered by workflow name (substring,
  case-insensitive)

Notifications are delivered as synthetic parts: the model sees them,
the transcript does not. A notification triggers a model turn, so the
agent can act on the event even while you are away.

## Privacy model

Notifications carry pointer data only: who commented, what happened,
and a URL. Comment bodies, diff contents, and CI logs never enter the
context from the notification itself. This is deliberate - GitHub
comments are written by strangers, and untrusted text flowing into a
model's context is a prompt-injection vector. The agent fetches details
on demand with `gh` when it decides to act.

## How to use it

Ask for it in conversation:

> Watch PR 1234 for review comments. If bugbot comments, handle it
> yourself. If a human comments, just tell me.

The handling policy lives in your instruction. State it when you ask -
the notification turn reads your policy from the conversation and
follows it. The notification says what happened and where, not what to
do about it.

Other tools:

- `thatch_watch_branch_create` - watch a branch (typically main) for
  commits, CI check runs, and workflow runs
- `thatch_watch_list` - shows the session's active watchers
- `thatch_watch_cancel` - cancels one by id

## Lifetime

Watchers are in-memory and process-scoped:

- Ending the opencode process (or restarting it) drops all watchers.
- A watcher expires after 8 hours by default.
- Each session can hold up to 5 active watchers.

If opencode restarts while a watch is active, re-register it - the
session's conversation survives, so the policy you stated is still
there.

## Requirements and limitations

- **opencode only.** MCP hosts (Claude Code, Cursor) have no way for a
  plugin to start a conversation turn, so the watch tools are not
  available there.
- **Requires the `gh` CLI** to be installed and authenticated. Watch
  creation reports a clear error if it is not.
- **Polling, not webhooks.** Events appear on the next poll cycle
  (60 seconds by default), not instantly.
- **No delivery during an active turn.** If the agent is mid-turn when
  an event fires, the notification waits until the turn ends.
