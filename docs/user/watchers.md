# Watchers

Watchers monitor external sources - today, GitHub pull requests,
branches, and local shell commands - and inject a notification into
the conversation when something happens. You ask the agent to watch a
PR, a branch, or a command; thatch polls it in the background; the
agent gets woken up when a watched event occurs. No one has to keep
asking "any updates yet?"

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

Command watched events:

- `command_success` - the watched command exited 0. The agent calls
  `thatch_watch_command_create` with a shell command that works as a
  **condition variable, not a data pipe**: the watcher re-runs it every
  poll and reads only the exit code - the command's output is
  discarded, never delivered. A command watch is one-shot by design:
  the first exit 0 fires one notification, then the watcher cancels
  itself. The command must be a fast, idempotent status check (a
  marker-file test, a health endpoint curl, a `gh run list` query).
  Blocking waits like `gh run watch` or `tail -f` are not refused -
  the tool guidance tells the agent not to use them, and a blocking
  command is killed at the per-run timeout each cycle and
  treated as not-done-yet. The command runs once at registration as
  validation: a command that already exits 0 is refused (the condition
  is already met), as is a command-not-found.

Notifications are delivered as synthetic parts: the model sees them,
the transcript does not. A notification triggers a model turn, so the
agent can act on the event even while you are away.

## Privacy model

Notifications carry pointer data and machine status: who acted, what
happened, a URL, and - for CI - the check or workflow name with its
conclusion (success, failure). Comment bodies, diff contents, and CI
logs never enter the context from the notification itself. This is
deliberate - GitHub comments are written by strangers, and untrusted
text flowing into a model's context is a prompt-injection vector.
Machine status fields come from the GitHub API rather than
user-written text, so they are safe to deliver. The agent fetches
everything else on demand with `gh` when it decides to act.

Command watches follow the same rule with a stricter boundary: the
notification carries the exit code and duration only. The command's
stdout and stderr are discarded - command output can be external
content (a curl response, a build log), so it never rides a
notification. The agent re-runs the command or reads logs itself when
it acts. The command runs in the project directory (or the `cd` path you
pass to `watch_command_create`) as the local user;
each run is killed at a 30-second timeout
(`THATCH_WATCH_COMMAND_TIMEOUT_SECONDS` overrides it). If the project
directory is a git worktree that gets deleted while a watch is active
(the branch merged and was cleaned up), the command keeps running from
the repo's main checkout instead of failing - branch lists and git state
are shared across worktrees, so the checks stay equivalent.

## How to use it

Ask for it in conversation:

> Watch PR 1234 for review comments. If bugbot comments, handle it
> yourself. If a human comments, just tell me.

The handling policy lives in your instruction. State it when you ask -
the notification turn reads your policy from the conversation and
follows it. The notification says what happened and where, not what
to do about it.

For waiting on CI, pick the tool that fits the wait. A short bounded
wait (a couple of minutes) can simply be polled in the conversation.
Watchers are the better fit for longer or open-ended waits, and for
post-merge builds on main; the creation output states when the first
poll lands so the choice compares real numbers.

Other tools:

- `thatch_watch_branch_create` - watch a branch (typically main) for
  commits, CI check runs, and workflow runs
- `thatch_watch_command_create` - wait on any local condition via a
  shell command that exits 0 when the wait is over
- `thatch_watch_list` - shows the session's active watchers
- `thatch_watch_cancel` - cancels one by id

## Lifetime

Watchers are in-memory and process-scoped:

- Ending the opencode process (or restarting it) drops all watchers.
- A watcher expires after 8 hours by default.
- Each session can hold up to 5 active watchers (all sources share
  the budget).
- A one-shot watch cancels itself after its first event - a single
  "tell me when this run finishes" request leaves nothing polling
  afterwards. Standing watches (the default) keep going until they
  are cancelled, expire, or the process ends. Command watches are
  always one-shot.

If opencode restarts while a watch is active, re-register it - the
session's conversation survives, so the policy you stated is still
there.

## Requirements and limitations

- **opencode only.** MCP hosts (Claude Code, Cursor) have no way for a
  plugin to start a conversation turn, so the watch tools are not
  available there.
- **Requires the `gh` CLI** to be installed and authenticated for PR
  and branch watches. Watch creation reports a clear error if it is
  not. Command watches need only `bash`, not `gh`.
- **Polling, not webhooks.** Events appear on the next poll cycle
  (60 seconds by default), not instantly.
- **No delivery during an active turn.** If the agent is mid-turn when
  an event fires, the notification waits until the turn ends.
