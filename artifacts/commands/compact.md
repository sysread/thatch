---
description: "Flush thatch persistence, check for loose ends, then compact if clear"
---
# User Message

$ARGUMENTS

(That section carries the text typed after the command. When it is empty, treat the user message as n/a - the command was run bare.)

# Pre-compact wrap-up

Work through this checklist before responding:

${CHECKLIST}

Do not start new work beyond this checklist. When every item is handled and nothing needs the user's attention first, call `thatch_compact` with no arguments, then end your final response. Compaction starts when you go idle after that call.

If anything is outstanding, list the items concisely so the user can address them, and do NOT call `thatch_compact`. Compaction only starts when the tool is called. If the user moves on to unrelated work after you listed blockers, do not call `thatch_compact`; the user re-runs /thatch/compact when ready.
