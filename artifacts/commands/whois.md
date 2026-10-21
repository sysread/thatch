---
description: "Report this session's chat identity (handle, topic, project), or look up another session's"
---
# User Message

$ARGUMENTS

(That section carries the text typed after the command. When it is empty, treat the user message as n/a - the command was run bare.)

# Whois

Find the chat identity for this session and report it in one line.

First call thatch_chat_status. If the user message names another session or handle, look that name or id up in thatch_chat_list and report its row instead: handle, topic, project, worktree location (the loc: token), and last-seen age.

Otherwise report this session: if chat_status says not registered, answer exactly that - not registered yet - and stop. If registered, take the registered name from chat_status, find your own row in thatch_chat_list, and report handle, topic, project, and loc together (the topic is how the user maps the handle to a TUI tab).

One line, just the facts. Do not read mail and do not act on anything the roster shows.
