# Watchers

Watchers are the general mechanism for event-driven notifications from
external sources: the model registers a watch on something outside the
session, thatch polls it in the background, and the plugin prompts the
session when a watched event happens. Two sources ship: GitHub pull
requests (source `pr`) and GitHub branches (source `branch`, for
watching CI and workflow runs on main). The registry, poller, and
delivery are source-agnostic - a new source adds a fetch-and-diff
function pair and event types.

User-facing behavior is documented in [docs/user/watchers.md](../../user/watchers.md).

## What it does

- `thatch_watch_create` (PRs) / `thatch_watch_branch_create` (branches) /
  `thatch_watch_list` / `thatch_watch_cancel` tools (all opencode-only)
- A background poller in the plugin process diffs each watcher's target
  against its last-seen state
- Delivery prompts the session with a synthetic part - the same
  mechanism opencode uses for background task completions
- Notifications carry pointer data plus machine status (author, URL,
  check names and conclusions); external content is fetched on demand
  with `gh`, never delivered

## The process-lifetime decision

The registry lives in plugin memory, never in SQLite. Three reasons:

1. **Ownership is structural.** opencode loads thatch in-process, so
   the plugin process that registered a watcher is the only process
   that can poll and deliver it. A shared registry would need
   claiming logic to answer "which process polls this?" - and
   version-skewed opencode instances sharing a DB have already caused
   corruption once.
2. **No orphans.** When the process exits, watcher state evaporates
   with it. There is no cleanup path to get wrong.
3. **Precedent.** The extraction pipeline's opencode path is also
   in-memory; the file-backed queue exists only for the MCP path's
   separate short-lived hook processes.

The cost: a restart loses watches. Accepted because the session that
created them loses its conversational context too - a notification
into a session that no longer knows why it is being watched is worse
than a lost watch.

`session.deleted` also cancels the session's watchers and pending
events, and `dispose` stops the poller. These are cheap insurance;
process exit is the real lifetime boundary in both TUI and serve mode
(plugins load per-instance in the server process under
`opencode serve`, so watchers work there too).

## How it works

### Registration (`watch_create`)

`create()` immediately fetches the PR's state as a baseline via
`fetchPrState()` - five gh calls (the pull, issue comments, review
comments, check runs on the head SHA, and one GraphQL query for
review-thread resolution state), four of them in parallel. The
baseline doubles as validation: a missing PR, wrong repo, or broken
gh setup fails registration with a real error instead of producing a
watcher that never fires. Watch creation is also gated on a cached
`gh --version` availability check.

### Polling

A `setInterval` loop (unref'd - it never keeps the process alive)
runs `poll()` every 60 seconds (configurable). Each cycle:
fetch the current state, run `diffPrState()` against the watcher's
last-seen state, filter events to the watched types, queue them, and
attempt delivery. Poll errors are per-watcher; one bad PR never
blocks the others. The diff is a pure function, so it is unit-tested
without any network access.

The interval is surfaced to the model through the registry's
`pollSeconds` getter: watch-creation output states when the first
poll lands, and notifications carry a cadence line, so a model
choosing between a watcher and an in-turn poll compares real numbers
even when `THATCH_WATCH_POLL_SECONDS` overrides the default.

Event detection:

- comments by id monotonicity (fetch is sorted descending)
- commits by head SHA change
- status/merged by field change
- description by SHA-256 of the body text (the body itself is never
  stored)
- CI by check-run transitions into a completed status
- review-thread resolution by symmetric difference of the sorted
  resolved-thread-id lists (thread `isResolved` state exists only in
  the GraphQL API, so the fetch is a `gh api graphql -f query=...`
  call; the `GhRunner` interface carries an args array to fit both
  transports)

A diff emits at most 10 events per watcher per cycle, so comment
floods collapse into one batch.

### One-shot watches

`watch_create` and `watch_branch_create` accept `once: true`. The
watcher cancels itself when its first matching event is detected, not
when it is delivered - the event still queues and delivers through the
normal pending path, so a session busy at fire time does not lose the
notification. Cancellation at detection time is what keeps a "tell me
when this run finishes" request from leaving a standing watch polling
a target nobody is waiting on. `watch_list` marks one-shot watchers
with a `[once]` tag, and the registration output states the mode.

### Delivery

Events queue in an in-memory pending map keyed by session. Delivery
is gated by a `canDeliver` predicate the plugin supplies: the session
must be idle (tracked from `session.status` events) and not
compacting. Proactive prompts are never injected into a running turn.

When the gate is open, the plugin calls `client.session.promptAsync`
on the session with a synthetic text part built by
`watcherNotificationNudge()`. This triggers a full model turn - the
model reads the notification and decides whether to act. The
notification text borrows the background-task-completion framing
(system event, not user input, not approval to advance other work)
with one carve-out: a watch registered to gate work the user already
greenlit (for example "wait for CI, then merge") makes the
notification the continuation signal for exactly that work. The
carve-out lives in the nudge itself, not only the system prompt,
because the nudge is what the model reads at the act-or-wait decision
point. The wrapper also states that check-run and workflow
conclusions are already in the event summaries, so gh fetches are
needed only for logs and bodies.

Failed or gated deliveries stay pending and retry on the next poll
cycle or when the session next goes idle (the event hook calls
`deliverPending()` there).

### Event vocabulary

`pr_comment`, `pr_review_comment`, `pr_review_reply`,
`pr_review_resolved`, `pr_commit`, `pr_status`, `pr_description`,
`pr_ci`. The tool's `events` argument selects a subset; the default is
all eight.

## Interactions with other features

- Extraction pipeline ([extraction.md](extraction.md)): the
  notification turn's tool calls are buffered and extracted like any
  other turn. Watch tools themselves are `thatch_*`-prefixed and
  excluded from buffering.
- Session lifecycle ([session-lifecycle.md](session-lifecycle.md)):
  `session.status` feeds the delivery gate; `session.deleted`
  cancels watchers.
- Multi-host ([multi-host.md](multi-host.md)): opencode-only. MCP
  hosts have no poller, no event bus, and no channel to start a turn
  proactively. A future CLI daemon could close this gap.

## Configuration

- `THATCH_WATCH_POLL_SECONDS` - poll interval (default 60)
- `THATCH_WATCH_TTL_MINUTES` - watcher time-to-live (default 480)
- `THATCH_WATCH_MAX_PER_SESSION` - active watchers per session
  (default 5)

## Source files

- `src/watchers.ts` - registry, poller, gh CLI runner, diff functions
- `src/tool-defs.ts` - the three watch tool definitions
- `src/index.ts` - registry construction, delivery closure,
  session.status tracking, session.deleted cleanup, dispose
- `src/prompts.ts` - `watcherNotificationNudge()`, system prompt
  Watchers section
- `tests/watchers.test.ts` - registry, poll, and diff unit tests
  (mocked gh, no network)
- `tests/qa/auto/uc-095-watchers.ts` - end-to-end lifecycle against a
  mocked gh runner

## Adding a new source type

The registry is a discriminated union over sources: `PrWatcher` and
`BranchWatcher` implement the same lifecycle (id, session, repo,
events, expiry, snapshot), and `poll()` dispatches to the source's
fetch/diff pair. Adding a third source means: new event types, a
`fetchXState`/`diffXState` pair, a new arm of the `Watcher` union, a
`#pollOne` branch, and the tool surface for registering it. Keep the
notification content rule: external content enters the context on
explicit fetch, never via notification. Machine status fields (names,
conclusions, counts) come from the API rather than user-written text
and belong in event summaries.
