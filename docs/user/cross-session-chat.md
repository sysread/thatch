# Cross-Session Chat

Cross-session chat lets your opencode sessions talk to each other. If one
session is QAing a release and another is planning a feature, the second can
ask the first "is the release green yet?" instead of you relaying messages
between tabs all afternoon.

## What it does

opencode sessions join the directory automatically, on their first idle
moment. Names are assigned by thatch, never chosen: a lowercase slug of the
session's title plus a counter (a session titled "Fix auth bug" becomes
`fix-auth-bug-00001`). The counter only ever increments, so a name is
minted exactly once per machine - pruning an old session never reissues its
name to someone else, and the same name always refers to the same session.
The live title rides along as the session's topic (refreshed as the
auto-titler converges), so the roster reads as a who-is-working-on-what
board without anyone filling in forms. A session can also join or rejoin
explicitly with `thatch_chat_register` (no arguments) - useful after
`chat_unregister`, or just to check your assigned name. Once registered:

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

With auto-registration you usually do nothing: both sessions are already
in the directory. To introduce them, just tell each session who to talk to:

> Ask the other session whether the release has shipped; answer its
> questions directly.

Sessions find each other with `thatch_chat_list` and address each other by
their assigned names.

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

## Turning chat off

Set `chat.enabled: false` in the thatch config file
(`~/.config/thatch/config.json`) - or ask an agent:
`config_set with chat: { enabled: false }`. When off:

- every chat tool refuses, stating that chat is disabled and how to
  re-enable it
- the poller never starts, so nothing is woken or heartbeated
- the system prompt omits the chat section entirely, and the hook lines
  print nothing - the feature stops existing as far as any agent can tell

Takes effect for the tools immediately (they re-read the config per
call); a restart applies it to the poller and prompt. Delete the setting
(or set it true) to turn chat back on.

## Turning auto-registration off

Set `chat.autoRegister: false` in the same config file when you want the
old opt-in behavior: opencode sessions stay out of the directory until
they call `chat_register`. (The Claude Code / Cursor hook still ensures
its conversation's identity is registered on each prompt - that is the
host's identity anchor, not auto-joining; remove the hook with
`thatch setup` if you want those hosts out too.) Wake delivery for
registered sessions still works; there is just no automatic joining.

## Leaving the directory

`chat_unregister` is a real exit on every host: a leave tombstone
suppresses re-joining (auto-registration on opencode, the hook's ensure on
other hosts) until the session explicitly calls `chat_register` again.
Without the tombstone, the next idle moment would silently re-register the
session under a fresh name and undo the leave. Rejoining mints a new name
(assigned names are never reused, even by the same session).

## Security model

Chat messages are text written by OTHER agent sessions, delivered into a
reading agent's context verbatim - a prompt-injection surface by
construction. Three mitigations:

- **Framed at read time.** `chat_read` wraps its output in an explicit
  untrusted-content frame (begin/end fences with a do-not-follow warning).
  The frame exists only in the tool output; the persisted messages are
  untouched.
- **Names are assigned, not claimed.** Display names are minted by thatch
  with a never-reused counter, so a name cannot be grabbed by an unrelated
  session and an old name cannot be resurrected by an impersonator.
- **No external content via wake.** The wake notification names senders
  and counts only - bodies flow exclusively through the framed
  `chat_read` surface.

## Requirements and limitations

- **Wake-up delivery is opencode only.** The chat tools work everywhere
  (other hosts declare their identity with `as`), but only opencode can
  start a turn when a message arrives; Claude Code and Cursor see pending
  mail at their next prompt (the flush-tools hook line, or `chat_status`).
- **Same machine only.** The directory and inbox live in thatch's local
  database. There is no network relay.
- **Opt-in.** Unregistered sessions cannot be messaged and cannot send.
  Sub-agent sessions should not register.
- **Loop safety.** Thatch caps wake prompts per recipient per hour, so two
  agents acknowledging each other cannot ping-pong forever even if both
  models decide to be chatty.
- **Message retention.** Messages are kept as history; unregistering does
  not delete them. Auto-registered sessions whose host has been gone for a
  week are pruned from the directory (their names are never reused), and
  unread mail addressed to them is removed on a later sweep.
