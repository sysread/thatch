# UC-003: Fact extraction from tool activity

_Automatable: buffer/peek/escalation contract could be tested with the mock
client and a synthetic tool call sequence._

**Preconditions**
- thatch plugin active in an opencode session

**Steps**
1. Do some real work: have the agent read files, run commands, edit code —
   any non-`thatch_*`, non-`skill`, non-`task` tool activity.
2. Send your next message (anything).

**Expected**
- The agent's context for that message includes a `[thatch]` nudge carrying a
  JSON payload summarizing the buffered tool interactions (tool name, title,
  truncated args/output).
- The agent loads `thatch-fact-extractor` and saves durable facts via
  `thatch_memory_remember` — or saves nothing if the activity was routine.
- The buffer is **not** drained on nudge delivery — it persists until the agent
  writes a memory or calls `thatch_extraction_done`. If the nudge is ignored,
  the next message carries a repeat nudge, escalating in urgency:
  - 1st-2nd miss: polite tone
  - 3rd consecutive miss (missedCount=2): insistent (directive) tone
  - 4th+ consecutive miss (missedCount>=3): ALL-CAPS tone
  The counter resets when the buffer drains (memory write or
  `thatch_extraction_done`).
- A `thatch_memory_remember` call in a child sub-agent session also drains the
  parent's buffer (via the `childToParent` Map), so dispatching the
  fact-extractor as a background task clears the parent's queue.
- Two concurrent sessions never see each other's interactions in a nudge.
- The agent's own `thatch_*` tool calls never appear in a payload (no
  feedback loop). `skill` and `task` tool calls are also excluded (buffering
  them would create a nudge → skill load → buffer → nudge loop).
