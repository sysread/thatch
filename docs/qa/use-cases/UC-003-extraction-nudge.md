# UC-003: Fact extraction from tool activity

**Preconditions**
- thatch plugin active in an opencode session

**Steps**
1. Do some real work: have the agent read files, run commands, edit code —
   any non-thatch tool activity.
2. Send your next message (anything).

**Expected**
- The agent's context for that message includes a `[thatch]` nudge carrying a
  JSON payload summarizing the buffered tool interactions (tool name, title,
  truncated args/output).
- The agent loads `thatch-fact-extractor` and saves durable facts via
  `thatch_memory_remember` — or saves nothing if the activity was routine.
- The buffer is flushed: the following message carries no repeat nudge unless
  new tool activity happened.
- Two concurrent sessions never see each other's interactions in a nudge.
- The agent's own `thatch_*` tool calls never appear in a payload (no
  feedback loop).
