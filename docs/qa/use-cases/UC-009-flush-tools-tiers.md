# UC-009: flush-tools tier priority and sideband degradation

**Preconditions**
- A Claude Code / Cursor session; `.mcp.json` and hooks installed
- At least one memory for the recall tier to match
- For the failure modes: a way to stop the MCP server and to leave a stale socket file

**Steps**
1. Put buffered non-thatch tool interactions in the queue (via `buffer-tool` / `buffer-batch`),
   then run `thatch flush-tools --json`.
2. With the queue empty and the MCP server running, send a prompt matching a memory (recall tier),
   then a prompt below threshold.
3. Stop the MCP server; run `flush-tools` with an empty queue.
4. Leave a stale socket file from a crashed MCP server; run `flush-tools`.
5. Make the sideband server hang (> 2 s); run `flush-tools`.

**Expected**
- Tiers fire in strict priority — **extraction > recall > write** — at most one nudge per call:
  - extraction: queue non-empty -> JSON payload, queue file deleted.
  - recall: queue empty, socket live, match at or above `THATCH_RECALL_THRESHOLD` (default 0.55)
    -> nudge with match labels; below threshold -> no nudge.
  - write: socket unavailable, no matches, or socket error -> static
    "did you learn anything worth persisting?" nudge.
- Sideband failure **never blocks** the agent: server down, a stale socket file, and a > 2 s
  timeout all degrade to the write nudge. A stale socket file left by a crash is cleaned up on
  connection error.
- `--json` wraps whichever nudge fires for Cursor's `additional_context`; plain stdout for Claude Code.

_Automatable: yes — `flush-tools` is a deterministic CLI contract and sideband failure modes
(server down, stale socket, timeout) plus tier ordering are filesystem/IPC only, with no LLM in
the loop._