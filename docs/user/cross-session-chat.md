# Cross-Session Chat

Cross-session chat lets your opencode sessions talk to each other. If one
session is QAing a release and another is planning a feature, the second can
ask the first "is the release green yet?" instead of you relaying messages
between tabs all afternoon.

## What it does

Each session opts in with `thatch_chat_register` under a short, unique name
("qa-session", "release-watcher"). Once registered:

- `thatch_chat_list` shows every registered session on the machine, with a
  liveness marker (fresh or stale)
- `thatch_chat_send` delivers a message to another registered session, by
  name or session id
- `thatch_chat_read` drains the session's inbox
- `thatch_chat_unregister` leaves the directory

When mail arrives for an idle session, thatch wakes it with a notification -
the agent gets a model turn even with nobody at the keyboard, reads its
inbox, and decides what to do. The notification names the senders and the
count only; the agent reads the actual messages itself.

## How to use it

Tell each session to register, then let them coordinate:

> Register in the thatch chat as "qa". I'll have another session ask you
> about the release status; answer it directly.

and in the other session:

> Register in the thatch chat as "planner", then ask the "qa" session
> whether the release has shipped.

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
- **Names are claimable.** Any session can pick any unused name. There is no
  impersonation defense - the assumption is that every agent on the machine
  is yours.
- **Message retention.** Messages are kept as history; unregistering does
  not delete them. There is no automatic pruning yet.
