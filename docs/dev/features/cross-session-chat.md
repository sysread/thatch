# Cross-Session Chat

Unless noted, `client.*` names below are the opencode v1 mapping; the v2 equivalents and degrades are in [opencode-plugin.md](opencode-plugin.md).

Cross-session chat lets independent opencode sessions on one machine message
each other through thatch: sessions join a shared directory (automatically,
under assigned names), see each other in the list, and messages land in
inboxes. An idle recipient is woken with a prompt when mail arrives, so
coordination does not route through the human ("ask the other session
whether the release is green" instead of "Jeff, go ask").

User-facing behavior is documented in
[docs/user/cross-session-chat.md](../../user/cross-session-chat.md).

## What it does

- `thatch_chat_register` / `thatch_chat_list` / `thatch_chat_send` /
  `thatch_chat_read` / `thatch_chat_unregister` / `thatch_chat_broadcast`
  tools (shared across hosts; opencode injects identity, MCP hosts pass the
  name their thatch hook printed as the `as` argument)
- Automatic registration: the plugin inserts a top-level session's
  directory row on its first idle event, with an assigned never-reused
  name (`chat.autoRegister: false` opts out)
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
  to sessions it hosts (those it has seen `session.status` events for,
  plus the `-s` startup session) and prompts them through its own SDK
  client. A sender never prompts a session
  in another process.

This preserves the watcher rationale's core property - no process prompts a
session it does not host - so each message has exactly one possible
deliverer. There is no claiming logic, no double-delivery race, and no
orphaned delivery state. The cost is the mirror of watchers': chat state
outlives a process, so liveness needs a signal beyond process lifetime.

## How it works

### Registration and identity

Sessions are auto-registered by the plugin: a top-level session's first
real user message inserts its directory row (the `chat.message` hook,
which fires before the model runs - so the session is addressable within
its very first turn), and the first `session.status` idle event remains a
backstop that also converges the topic once the auto-titler lands. A
session continued via `-s <id>` or `-c` registers at harness start
(below). All paths are skipped when `chat.autoRegister: false` or when the
session left explicitly (a leave tombstone, see below). Names are assigned, never
claimed: a pool draw (`CHAT_NAME_POOL`, src/chat-names.ts) plus a
per-base counter row (`chat_name_counters`, src/db.ts) that only ever
increments - drawn atomically via INSERT ... ON CONFLICT ... RETURNING.
Pool names are deliberately short: they appear in every wake prompt and
roster line, and the session's descriptive identity lives in the topic
column instead (the live session title, refreshed on every idle by
`refreshAutoTopic` - auto rows only; legacy rows keep their old model-set
topics; placeholder titles never become topics or names). A name is
minted exactly once per machine: pruning an auto-registered row (host
silent for CHAT_AUTO_TTL_DAYS = 7 days, swept hourly by the poller) can
never reissue its name, which is what makes the prune safe.
Registration also captures the checkout kind (`worktree` column):
`detectWorktreeKind` (src/git.ts) classifies the session's serving
directory once at registration - a `.git` file means a linked git
worktree, a `.git` directory means the project root, no `.git` reads as
undetected. The roster shows it as a `loc:` token so sessions coordinating
on a shared tree can tell who sits where.

### Startup registration and reclaim

A session continued via `opencode -s <id>` gets no event when it comes
back up (resume writes nothing session-scoped), so the plugin reads the
session id from the harness's command line at init and registers it then.
The plugin does not see the CLI flags in `process.argv`: opencode hosts
the server in a worker thread whose argv is just the worker script. The
thread shares the process pid, so the plugin reads the OS-level command
line for its own pid instead (`/proc/self/cmdline` on Linux, `ps -o
args=` on macOS) and parses `-s`/`--session` from that.
Registration is keyed by session id: the row already exists, so the name
is RECLAIMED (names are owned by the session id, minted once, never
renamed) and the row's heartbeat is refreshed - hosting is the
heartbeat, so the serving harness beats and delivers for the row again.
`-c/--continue` resolves no id on the command line, so the plugin
resolves the same target the harness does: `client.session.list()`
(directory-scoped, the plugin's client carries the directory), sorted by
`time.updated` descending like the TUI does, first row without a
`parentID`. That registration is not synchronous at init (the list call
is a server round trip), but it lands within a beat of startup - the
heartbeat is live long before the first prompt. Asleep-mail: the
startup path kicks a delivery pass when it finishes, so the continued
session learns what it missed at startup instead of waiting out the
first poll cycle.

`chat_register` (no arguments) is the explicit path: idempotent ensure for
opencode (identity is the host session ID, which the model cannot know or
forge), a fresh identity per conversation on MCP hosts, or a reclaim of an
existing name via `as`. Re-registering keeps the name. Unregistered
sessions are invisible and unmessageable in both directions. Only
top-level sessions should register - sub-agent children are ephemeral -
which the tool descriptions and system prompt state; there is no
mechanical barrier, a documented trust posture.

### Leave tombstones

Every exit path - `chat_unregister`, `session.deleted`, and a greenlit
`/thatch/exit` (the plugin unregisters the exiting session before
publishing `app.exit`, so the roster stops advertising a host that is
about to vanish; the exit template's checklist step asks the model to do
the same earlier) - writes a
`chat_leave_tombstones` row in the same transaction that deletes the
directory row. The tombstone is what makes a leave stick: all
registration paths consult it (the plugin's idle and prompt auto-registerers are
suppressed outright; the MCP hook's ensure-register prints the leave line
instead of rejoining), so a leave cannot be silently undone by the next
idle moment. The gate lives in `ChatStore.register` via `#tombstoneGate`
(src/chat.ts), which also closes the in-flight race: an auto-register
IIFE whose session was deleted during its title-fetch await finds the
tombstone and stops instead of resurrecting a dead session. An explicit
`chat_register` clears the tombstone before re-registering (fresh name -
assigned identities are never reused), and tombstones age out in the
hourly prune (7-day TTL; a resumed session after expiry simply
auto-registers under a fresh name).

Because names are system-minted and never recycled, the impersonation
surface shrinks to whatever the operator runs: every agent on this machine
is the operator's agent.

### Topics

The topic is the roster's "who is working on what" signal. For
auto-registered sessions it is the live session title, refreshed on every
idle event - the auto-titler usually lands a real title within a turn or
two, so the roster converges to the actual work with nobody filling in
forms. Legacy rows (from the claimed-names era) keep whatever topic was
set at their registration: free text, sanitized to one roster line
(whitespace runs collapse, 80-character cap, advisory - oversizing degrades
rather than errors). There is no tool path to set a topic anymore - topics
are title-derived for everything the current code mints. Broadcast senders
benefit most: `chat_broadcast` answers "which of you is working on X?"
with the roster already in hand.

### Messages

`chat_send` addresses a recipient by display name or session ID. Both
endpoints must be registered and distinct. `chat_read` drains the calling
session's inbox oldest-first and stamps rows read. Message history survives
unregistration; a departed sender degrades to an unknown name in the
reader's view (the endpoints are deliberately not foreign keys - leaving the
directory must not be blocked by history).

`chat_broadcast` posts one message to every other registered session at
once, one inbox row per recipient - the existing wake machinery (grouping,
gating, rate cap) treats each as ordinary mail. Stale sessions are skipped
and reported rather than messaged: a host that has stopped heartbeat-ing
will never read the mail, and dead mail to a dead process is just clutter.
The sender is excluded. It is a separate tool rather than a magic
`chat_send` recipient because "send to all" changes the behavior (fan-out,
stale skipping, no address resolution), and a function that changes
behavior drastically on a parameter value is two functions.

### Polling, heartbeat, staleness

A `setInterval` loop (default 30s) runs one cycle per process: heartbeat
the HOSTED sessions (those seen as events in this harness plus the `-s`
startup session - idle sessions keep beating, so a session stays fresh
while its harness lives), then deliver their mail. A crashed process
fires no `session.deleted`, so its rows would linger - staleness catches
them: a row that has missed two consecutive beats (`CHAT_STALE_MS`, 60s
at the default interval) is stale, meaning its harness stopped. Two beats
rather than one so a single late poll cycle does not flap the roster.
Heartbeat age is the ONLY liveness signal, by design. A host process id
cannot serve: the same session is re-hosted by a new process on every
`-s` resume, so a pid stamped on the row lies as soon as a different
harness beats it (it says dead while the heartbeat proves alive). `isStale`
(src/chat.ts) is the single rule; `chatLiveness`, the `chat_send` note,
and the broadcast skip all call it, so they cannot disagree. `chat_list`
groups the result into Active and Stale sections - the stale section's
explainer says what stale means - and `chat_send` states the recipient's
liveness at send time, so a sender mailing a ghost learns it immediately
instead of waiting on a wake that will never fire. Both roster surfaces
order rows with `sortChatRoster` (also src/chat.ts): project first,
alphabetical, with no-project rows last; most recently seen first within
a project. The CLI roster bounds
the stale display to one day by default (`--stale N` in days, `--stale all`
unbounded), collapsing older rows into a hidden-count note; the tool
surface stays unbounded so an agent always sees the full directory.
`session.deleted` is the graceful-exit fast path that unregisters immediately.

### Delivery, re-nudge, and the rate cap

A message needs a wake prompt when it is unread and either never delivered
or delivered more than the re-nudge window ago (default 15 minutes).
Delivery is gated by the same `canDeliver` predicate watchers use - the
recipient must be idle and not compacting - and the idle event handler
flushes pending mail directly so it lands promptly instead of waiting for
the next cycle. Failed deliveries stay pending and retry. Only registered
recipients are ever selected: unregistering stops wake prompts for
kept-but-unread mail, which is the `chat_unregister` tool's promise.
Delivery is at-least-once - a crash after the wake prompt but before the
delivered_at stamp re-nudges the same batch on the next cycle.

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
(`chatEchoText()` in `src/prompts.ts`: register, send, read, broadcast) and
delivers it as a non-synthetic, `noReply` promptAsync part: rendered as a
visible bubble in the transcript, no model turn started (the server's
prompt path returns before the completion loop). Failed calls never echo;
`chat_list` and `chat_unregister` stay on the muted tool line. Broadcasts
echo their fan-out count with the clipped body.

The trade-off: non-synthetic is what makes the TUI render the part, and it
also means later turns see the echo in context - a small duplication of the
tool call it mirrors, accepted for visibility. Echo bodies are clipped
(send: the body; read: the formatted inbox; broadcast: the body) so a
bubble stays cheap. Echo delivery is fire-and-forget: a failure must never
fail the tool call it follows. Because the opencode server fires the
`chat.message` hook for every prompt part before the `noReply`
early-return, the plugin's `chat.message` handler skips messages whose
visible text is entirely `[chat]`-prefixed bubbles (`isChatEchoParts`) -
otherwise every echo would run the nudge machinery for a message no model
turn reads. The accepted edge: a real user message whose every visible
part starts with the prefix is skipped the same way, losing that one turn's
advisory nudges.

### The untrusted-content frame

Message bodies are other agents' text delivered verbatim into the reading
model's context - a prompt-injection surface by construction. The watcher
privacy model solves the same surface with pointer-only notifications, but
chat's payload IS the body, so `chat_read` frames the boundary instead:
`chatInboxFrame()` (src/prompts.ts) wraps the message lines in
begin/end fences with an explicit do-not-follow warning. The frame exists only in
the tool output - persisted rows are untouched - and pairs with the wake
nudge's anti-loop rule and the isChatEchoParts skip as the feature's three
injection-hygiene layers.

### CLI access

The user watches the conversation without an agent: `thatch chat list`
renders the roster as aligned columns under a header row (TTY-gated
color; `formatChatRoster()` in `bin/thatch`), and `thatch chat tail`
follows the message stream as JSONL: one event per line, `sent` and
`read` as separate events linked by message id, bodies verbatim.
The backlog prints only the
last `CHAT_TAIL_DEFAULT_LIMIT` (20) messages via `chatTailBacklog()`;
`filterChatTailRows()` narrows every feed snapshot (backlog and follow
polls alike) by body regexes, participant-name substrings, and a
half-open time window. The diff itself is `chatTailDiff()` (unit-tested
in `tests/chat.test.ts`): sent events on first view, then new sends and
newly-read messages per poll, with the diff state seeded from the full
feed so neither the limit nor a mid-follow rename/unregister can
resurface old rows as sent events. `chat_messages.via_broadcast` marks
fan-out rows so each copy's `sent` event carries `broadcast: true`
alongside its real recipient. The
CLI takes no chat write actions (the wake machinery owns those paths);
the only writes it can trigger are the schema migrations that run
whenever any thatch process opens the database.

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
- Extraction pipeline ([extraction.md](extraction.md)): chat tool calls
  are `thatch_*` tools and excluded from buffering like all thatch tools;
  non-thatch tool calls made during a chat notification turn are buffered
  and extracted like any other turn's.
- Multi-host ([multi-host.md](multi-host.md)): the chat tools are shared -
  MCP hosts get their identity from the thatch hook, which ensure-registers
  the conversation's stable session ID (`mcp_<hash of host session id>`)
  and prints the assigned name plus unread count at session start and on
  every prompt; chat
  tools take that name as `as`. Wake-up delivery remains opencode-only: no
  MCP server can start a turn in the client's conversation.

## Multi-host delivery tiers

Chat works on every host, and can be disabled entirely: `chat.enabled:
false` in the thatch config makes every chat tool refuse (a `[disabled]`
reply naming the re-enable path), stops the poller at init, omits the
system prompt's chat section, and silences the hook lines. The tools
re-read the config per call, so a toggle applies immediately; the poller
gate is read once at init and needs a restart. The hook lines gate on the
same config, so a disabled feature never advertises itself through any
surface.

Chat works on every host. Earlier designs for the MCP path - a JSONL
temp-file inbox, a socket or daemon - were rejected: the DB already is the
inbox, and MCP hosts cannot hold connections across turns, so both
degenerate to the turn-granularity polling the tools already provide. The
wake analog is the existing hook channel.

| Host        | Send/receive | New-mail signal                                        | Echo bubbles |
|-------------|--------------|--------------------------------------------------------|--------------|
| opencode    | yes          | promptAsync wake (idle-gated)                          | yes          |
| claude code | yes          | Stop-hook reminder at turn end + flush-tools hook line | no           |
| cursor      | yes          | flush-tools hook line + chat-notify follow-up at turn end | no        |

MCP identity is anchored by the host hook: `chatHookLine(sessionID)` in
`bin/thatch` ensure-registers `mcp_<sha256(host session id)[0:12]>` at
session start (the reminder reads the hook's stdin) and on every prompt,
and prints the assigned name plus unread count, so the
identity is stable across the ephemeral conversations those harnesses run
(and a conversation without the hook gets a fresh per-conversation
identity from `chat_register`). `chat_status` is the quiet check

**Anti-spoofing layer (Claude Code).** MCP tool calls carry no session
context, so without help the caller-claimed `as` would be the only
identity source. On Claude Code the hooks record `(parent pid -> session)`
into `chat_host_pids` from payloads the model cannot influence, and the
MCP server - a child of the same Claude Code process - resolves its own
parent pid against that table (`chatDerivedIdentity` on CoreContext,
freshness-capped at 600s to bound pid reuse). A second model-proof layer
is `CLAUDE_CODE_SESSION_ID`, which the host sets in the stdio server's
environment at spawn. `resolveChatIdentity` priority: opencode host
context > ppid mapping > env id > claimed `as`. Cursor's hooks and MCP
servers share one workspace process (ambiguous ppid, no per-session env),
so Cursor keeps the claimed-`as` path, documented in the user doc's
security model.

**Continuation adoption (Claude Code).** Claude Code forks the session id
on resume - and has been observed to fork spontaneously (agent-team
conversion, self-update, config reload) - which would strand the old
identity and mailbox. When a hook registers an UNKNOWN session id,
`resolveRegisteredPredecessor` reads the hook's `transcript_path` and
scans sibling transcripts' tails for a `continued-in` record naming the
new id (the chain walk adopts the nearest registered ancestor, bounded at
10 hops); `ChatStore.continueSession` then migrates the old row's key to
the new session id - name, mail (sender and recipient columns),
host-pid anchors, and leave tombstones all follow.

`chat_status` is the quiet check
(registered flag + pending/total); the flush-tools hook line names the
caller's identity and mailbox, and is absent entirely when chat is
disabled - absence is silent by construction.
Staleness semantics differ by kind: an opencode row's stale age means its
harness stopped beating (broadcast skips it), while an mcp row's age only means
"between turns" (broadcast always delivers).

## Defaults

Timing constants live in `src/chat.ts`: poll interval 30s, staleness
threshold two missed beats (60s), re-nudge window 15 minutes, nudge cap 6 per recipient
per hour, auto-row TTL 7 days. There are no environment overrides yet; add
them the way `THATCH_WATCH_POLL_SECONDS` works if a user needs them.

## Source files

- `src/chat.ts` - ChatStore (directory + inbox SQL, assigned-name draw:
  pool pick, slugify, counter bump, insert, prune, topic refresh), ChatPoller
  (heartbeat, gated delivery, re-nudge, rate cap, hourly prune sweep),
  staleness helper
- `src/chat-names.ts` - the static display-name pool (nomenclater style),
  the base for every assigned name
- `src/db.ts` - the chat tables in schema init (including
  chat_name_counters and the auto column), the NOCASE collation migration
  and topic column migration, delegated methods
- `src/tool-defs.ts` - the chat tool definitions
- `src/runtime.ts` - poller construction, delivery closure, `-s` startup
  registration (`osProcessArgs`, `startupSessionId` from `src/os-args.ts`), idle
  auto-registration + topic refresh, idle flush,
  session.deleted unregister, dispose, transcript echo in
  tool.execute.after
- `src/debug.ts` - the `THATCH_DEBUG` diagnostic log; `chat:startup` is
  the chat consumer
- `src/prompts.ts` - `chatNotificationNudge()`, `chatEchoText()` /
  `isChatEchoParts()`, system prompt Cross-Session Chat section, MCP
  absent-tools note
- `tests/chat.test.ts` - store, pool, migration, echo-text, liveness, tail
  diff/backlog, and poller unit tests (temp-dir SQLite, injected delivery)
- `tests/qa/auto/uc-097-chat.ts` - full lifecycle against a mocked poller
- `tests/qa/auto/uc-099-chat-cli.ts` - `chat list` roster and `chat tail`
  JSONL contract over a seeded DB
- `tests/qa/live/uc-098-chat-cross-session.ts` - two real sessions exchange
  a message through the shared DB
