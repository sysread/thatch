# UC-006: Cursor hook lifecycle

**Preconditions**
- `thatch setup --cursor` has run; `.cursor/mcp.json` registers the thatch MCP server
- A store with at least one memory (for the recall tier)

**Steps**
1. Start a Cursor agent session; the MCP server boots and opens its sideband socket.
2. Have the agent run a non-thatch tool (e.g. read a file). The `postToolUse` hook runs
   `thatch buffer-tool`, reading Cursor's stdin (`conversation_id`), and appends one
   interaction to the session's queue file. Stdout is empty.
3. Have the agent run a thatch tool (`mcp__thatch__memory_list`). The hook fires but filters
   it out — nothing is appended.
4. Submit a prompt. The `beforeSubmitPrompt` hook runs `thatch flush-tools --json`.
5. Submit the next prompt with no fresh tool activity since step 4.

**Expected**
- `buffer-tool` normalizes `conversation_id` to a safe session file name and appends exactly one
  interaction per call; thatch's own `mcp__thatch__*` tools never enter the queue (no self-echo).
- `flush-tools` peeks the queue first (extraction tier): prints the JSON payload wrapped for
  Cursor as `additional_context`. The queue is **not** deleted — it persists until the agent
  writes a memory or calls `thatch_extraction_done`, so ignored nudges repeat and escalate
  (polite to insistent to ALL-CAPS) on subsequent calls.
- With the queue empty and the sideband socket live, a semantically matching prompt yields a
  recall nudge using the bare `memory_recall` tool name; below `THATCH_RECALL_THRESHOLD`
  (default 0.55), no nudge.
- `buffer-tool` and `flush-tools --json` output is the shape Cursor's `additional_context`
  field consumes.

_Automatable: partial — the `buffer-tool` and `flush-tools --json` CLI contracts are fully
automatable; the live Cursor agent loop (booting the MCP server, the agent acting on a nudge)
is manual._
