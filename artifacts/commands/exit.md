---
description: "Flush thatch persistence, check for loose ends, then end the session if clear"
---
# User Message

$ARGUMENTS

(That section carries the text typed after the command. When it is empty, treat the user message as n/a - the command was run bare.)

# Pre-exit wrap-up

Work through this checklist before responding:

${CHECKLIST}

Do not start new work beyond this checklist. When every item is handled and nothing needs the user's attention first, call `thatch_exit` with no arguments, then end your final response. The session closes when you go idle after that call.

If anything is outstanding, list the items concisely so the user can address them, and do NOT call `thatch_exit`. The session stays open until the tool is called. If the user moves on to unrelated work after you listed blockers, do not call `thatch_exit`; the user re-runs /thatch/exit when ready.
