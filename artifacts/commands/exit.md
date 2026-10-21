---
description: "Flush thatch persistence, check for loose ends, then end the session if clear"
---
# User Message

$ARGUMENTS

(That section carries the text typed after the command. When it is empty, treat the user message as n/a - the command was run bare.)

# Pre-exit wrap-up

Work through this checklist before responding:

${CHECKLIST}

Do not start new work beyond this checklist. If every item is handled and nothing needs the user's attention first, end your final response with exactly this token as the very last line, with no formatting around it:

${TOKEN:EXIT_READY_TOKEN}

If anything is outstanding, list the items concisely so the user can address them, and do NOT include the token. The session will only close when the token is present.
