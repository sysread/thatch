# Cross-Session Chat

Cross-session chat lets independent opencode sessions on one machine message
each other through thatch: a session registers in a shared directory, other
sessions see it in the list, and messages land in its inbox. An idle
recipient is woken with a prompt when mail arrives, so coordination does not
route through the human ("ask the other session whether the release is
green" instead of "Jeff, go ask").

User-facing behavior is documented in
[docs/user/cross-session-chat.md](../../user/cross-session-chat.md).

## What it does

- `thatch_chat_register` / `thatch_chat_list` / `thatch_chat_send` /
  `thatch_chat_read` / `thatch_chat_unregister` tools (all opencode-only,
  identity from the host session)
- A shared SQLite directory and inbox in thatch.db, writable by any opencode
  process on the machine
- A per-process poller that heartbeats hosted sessions and delivers wake
  prompts via `client.session.promptAsync` with a synthetic part - the same
  mechanism watchers use
- Anti-loop protection at two levels: prompt guidance (messages are
  informational, no reflexive auto-reply) and a hard per-recipient nudge
  rate cap

## The shared-state, local-delivery decision

Watchers keep their registry in plugin memory, never SQLite, because the
process that registered a watcher is the only one that can deliver its
events (see [watchers.md](watchers.md)). Chat cannot work that way: the
sender's process and the recipient's process are usually different, so the
state they coordinate through must be shared.

The split:

- **State is shared.** `chat_sessions` and `chat_messages` live in thatch.db.
  Every opencode process on the machine reads and writes the same tables.
  Concurrent access is the already-solved case - multiple sessions share the
  DB for memories today, under WAL plus a busy timeout.
- **Delivery is local.** Each process polls the inbox for messages addressed
  to sessions it hosts (those it has seen `session.status` events for) and
  prompts them through its own SDK client. A sender never prompts a session
  in another process.

This preserves the watcher rationale's core property - no process prompts a
session it does not host - so each message has exactly one possible
deliverer. There is no claiming logic, no double-delivery race, and no
orphaned delivery state. The cost is the mirror of watchers': chat state
outlives a process, so liveness needs a signal beyond process lifetime.

## How it works

### Registration and identity

`chat_register` joins the directory. Without a name it draws one at random
from the built-in pool (`src/chat-names.ts`): whimsical geek-culture names
in the style of fnord's Nomenclater, statically baked in so assignment never
costs a model call. Pool draws cannot collide with each other and skip any
name a session already claimed; the pool is the recommended path because it
cannot collide at all. With a name, the session claims it custom -
uniqueness is case-insensitive ("Landru" and "landru" are one name), so two
visually identical identities cannot coexist, and message addressing follows
the same rule. Databases created before the case-insensitive constraint are
rebuilt at schema init (first row wins per case group; message history
survives because the endpoints are not foreign keys).

Identity is the host session ID, which the model cannot know or forge.
Re-registering renames. Unregistered sessions are invisible and
unmessageable in both directions. Only top-level sessions should register -
sub-agent children are ephemeral - which the tool descriptions and system
prompt state; there is no mechanical barrier, a documented v1 trust posture.

Names are claimable by any session (no impersonation defense). The trust
model is the same as the shared memory stores: every agent on this machine
is the operator's agent.

### Messages

`chat_send` addresses a recipient by display name or session ID. Both
endpoints must be registered and distinct. `chat_read` drains the calling
session's inbox oldest-first and stamps rows read. Message history survives
unregistration; a departed sender degrades to an unknown name in the
reader's view (the endpoints are deliberately not foreign keys - leaving the
directory must not be blocked by history).

### Polling, heartbeat, staleness

A `setInterval` loop (default 30s) runs one cycle per process: heartbeat the
hosted sessions' `last_seen`, then deliver. A crashed process fires no
`session.deleted`, so `chat_list` marks sessions whose `last_seen` is older
than the staleness threshold (default 10 minutes) as stale rather than
hiding them - the operator decides what to do with ghosts. `session.deleted`
is the graceful-exit fast path that unregisters immediately.

### Delivery, re-nudge, and the rate cap

A message needs a wake prompt when it is unread and either never delivered
or delivered more than the re-nudge window ago (default 15 minutes).
Delivery is gated by the same `canDeliver` predicate watchers use - the
recipient must be idle and not compacting - and the idle event handler
flushes pending mail directly so it lands promptly instead of waiting for
the next cycle. Failed deliveries stay pending and retry.

One wake prompt covers all of a recipient's pending messages: sender names
and a count, pointer-only like watcher notifications, with the model calling
`chat_read` for content. On success the poller stamps `delivered_at`
(re-stamping on re-nudges resets the re-nudge timer).

The hard brake: at most a fixed number of wake prompts per recipient per
hour (default 6, in-memory on purpose - it is a loop guard, not accounting).
Without it, two agents politely acknowledging each other would ping-pong
forever, each wake triggering a reply that wakes the other.

### Transcript echo

Plugin tools render in the opencode TUI as muted one-line generic entries,
with the output block behind a default-off toggle - so without help, a chat
exchange is invisible to the human watching the session. The plugin's
`tool.execute.after` hook builds a short echo for the conversational events
(`chatEchoText()` in `src/prompts.ts`: register, send, read) and delivers it
as a non-synthetic, `noReply` promptAsync part: rendered as a visible
bubble in the transcript, no model turn started (the server's prompt path
returns before the completion loop). Failed calls never echo; `chat_list`
and `chat_unregister` stay on the muted tool line.

The trade-off: non-synthetic is what makes the TUI render the part, and it
also means later turns see the echo in context - a small duplication of the
tool call it mirrors, accepted for visibility. Echo bodies are clipped
(send: the body; read: the formatted inbox) so a bubble stays cheap. Echo
delivery is fire-and-forget: a failure must never fail the tool call it
follows.

## Interactions with other features

- Watchers ([watchers.md](watchers.md)): chat reuses the delivery gate
  (`canDeliver` over `sessionStatus` + `compacting`), the idle-flush
  pattern, and the synthetic-part + toast notification shape. The state
  model is the deliberate opposite - shared SQLite vs process memory - and
  each feature's doc explains why its side of the split is right for its
  problem.
- Session lifecycle ([session-lifecycle.md](session-lifecycle.md)):
  `session.status` feeds the delivery gate and the hosted-session set;
  `session.deleted` unregisters.
- Extraction pipeline ([extraction.md](extraction.md)): a chat notification
  turn's tool calls are buffered and extracted like any other turn.
- Multi-host ([multi-host.md](multi-host.md)): opencode-only. MCP hosts have
  no session identity, no poller, and no prompt channel.

## Defaults

Timing constants live in `src/chat.ts`: poll interval 30s, staleness
threshold 10 minutes, re-nudge window 15 minutes, nudge cap 6 per recipient
per hour. There are no environment overrides yet; add them the way
`THATCH_WATCH_POLL_SECONDS` works if a user needs them.

## Source files

- `src/chat.ts` - ChatStore (directory + inbox SQL, pool assignment),
  ChatPoller (heartbeat, gated delivery, re-nudge, rate cap), staleness
  helper
- `src/chat-names.ts` - the static display-name pool (nomenclater style)
- `src/db.ts` - the two chat tables in schema init, the NOCASE collation
  migration, delegated methods
- `src/tool-defs.ts` - the five chat tool definitions
- `src/index.ts` - poller construction, delivery closure, idle flush,
  session.deleted unregister, dispose, transcript echo in
  tool.execute.after
- `src/prompts.ts` - `chatNotificationNudge()`, `chatEchoText()`, system
  prompt Cross-Session Chat section, MCP absent-tools note
- `tests/chat.test.ts` - store, pool, migration, echo-text, and poller unit
  tests (temp-dir SQLite, injected delivery)
- `tests/qa/auto/uc-097-chat.ts` - full lifecycle against a mocked poller
- `tests/qa/live/uc-098-chat-cross-session.ts` - two real sessions exchange
  a message through the shared DB
