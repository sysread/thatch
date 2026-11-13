---
description: "Drain the extraction queue now"
---
# User Message

$ARGUMENTS

(That section carries the text typed after the command. When it is empty, treat the user message as n/a - the command was run bare.)

# Extract

Dispatch a task with background: true and subagent_type: "general" (required for thatch tool access) with this prompt:

"
${CORE:extract}
"

After dispatching, call thatch_extraction_done to acknowledge.
