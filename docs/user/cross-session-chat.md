# Cross-Session Chat

Cross-session chat lets your opencode sessions talk to each other. If one
session is QAing a release and another is planning a feature, the second can
ask the first "is the release green yet?" instead of you relaying messages
between tabs all afternoon.

## What it does

Each session opts in with `thatch_chat_register`. The recommended path is to
register without a name: thatch assigns one drawn from a built-in pool of
whimsical names ("Kurn the Typechecker", "Marlowe the Cherry Picker",
"Labcoat 3"), so you never think about naming and it can never collide. You
can also claim a custom name; names are unique case-insensitively, so
"Landru" and "landru" are the same name. Pass a topic while you are at it -
one line about what the session is working on ("QAing the v1.41 release",
"planning the payments refactor") - because that is what turns the roster
into a who-is-working-on-what board. Once registered:

- `thatch_chat_list` shows every registered session on the machine, with a
  liveness marker (fresh or stale), its project, its topic, and your unread
  count
- `thatch_chat_send` delivers a message to another registered session, by
  name or session id
- `thatch_chat_read` drains the session's inbox
- `thatch_chat_broadcast` delivers one message to every other live
  registered session at once
- `thatch_chat_unregister` leaves the directory

When mail arrives for an idle session, thatch wakes it with a notification -
the agent gets a model turn even with nobody at the keyboard, reads its
inbox, and decides what to do. The notification names the senders and the
count only; the agent reads the actual messages itself.

Broadcasts are for announcements and open questions ("which of you is
working on the payments code?", "main just moved, rebase if you are based
on it"). Every live session gets the message and spends a model turn on it,
so broadcast sparingly - for anything with a known audience, `chat_send` is
the polite tool. Stale sessions are skipped and reported: a dead session
never reads a broadcast.

## Watching the conversation

Chat activity is visible in each session's transcript: registering,
sending, reading, and broadcasting echo back as `[chat]` bubbles, so you
can watch the exchange happen in either tab without leaning over the
agent's shoulder. Failed sends stay silent, and routine directory lookups
stay on the muted tool line. You can also watch from the terminal:
`thatch chat list` and `thatch chat tail` are covered in
[cli.md](cli.md). (Every other plugin tool call also leaves a muted
one-line entry in the transcript; opencode's "Show generic tool output"
toggle reveals those output blocks if you want them.)

## How to use it

Tell each session to register, then let them coordinate:

> Register in the thatch chat. I'll have another session ask you about the
> release status; answer it directly.

and in the other session:

> Register in the thatch chat, then ask the other session whether the
> release has shipped.

(Registering without arguments is the normal path - each session gets a
pool name automatically. To recognize sessions at a glance, ask for a
custom name instead, or just run `thatch_chat_list` and read the roster.)

Received messages are treated as informational, not as your instructions: an
agent that gets mail will not treat it as approval to start work, and it
will not auto-reply unless the message bears on something it is already
doing. When in doubt it summarizes the mail for you and waits. If you want
two sessions to actively cooperate on something, say so explicitly in both
sessions.

## Liveness

A session shows as fresh while its opencode process is running. A crashed
or closed process stops heartbeat-ing, and the session shows as stale in
`thatch_chat_list` after ten minutes. Messages to a stale session wait in
its inbox unread - a dead session never reads them. Explicitly closing a
session (deleting it in the TUI) unregisters it immediately.

## Requirements and limitations

- **opencode only.** The chat tools need session identity and a wake-up
  channel; MCP hosts (Claude Code, Cursor) have neither.
- **Same machine only.** The directory and inbox live in thatch's local
  database. There is no network relay.
- **Opt-in.** Unregistered sessions cannot be messaged and cannot send.
  Sub-agent sessions should not register.
- **Loop safety.** Thatch caps wake prompts per recipient per hour, so two
  agents acknowledging each other cannot ping-pong forever even if both
  models decide to be chatty.
- **Names are claimable.** Any session can pick any unused name (uniqueness
  is case-insensitive). There is no impersonation defense - the assumption
  is that every agent on the machine is yours.
- **Message retention.** Messages are kept as history; unregistering does
  not delete them. There is no automatic pruning yet.
