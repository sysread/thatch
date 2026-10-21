First call thatch_get_session_info to learn this session's ID. Below, replace SESSION_ID with that value.

Dispatch a task with background: true and subagent_type: "general" (required for thatch tool access) with this prompt:

"
${CORE:extract}
"

After dispatching, call thatch_extraction_done to acknowledge.
