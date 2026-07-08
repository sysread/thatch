# UC-017: buffer-tool vs buffer-batch contract

**Preconditions**
- A Claude Code setup (`PostToolBatch` -> `buffer-batch`) and a Cursor setup
  (`postToolUse` -> `buffer-tool`)

**Steps**
1. **Claude Code**: a `PostToolBatch` fires with a `tool_calls` array (several
   tools, one a `mcp__thatch__*` call) and a `session_id`.
2. **Cursor**: a `postToolUse` fires for a single tool with a `conversation_id`.
3. Run `flush-tools` for both.

**Expected**
- `buffer-batch` (Claude Code) reads the `tool_calls` array and `session_id`,
  appends all interactions to the session's JSONL queue, filters out
  `mcp__thatch__*` calls, and caps at 20 (oldest dropped). It is **silent**.
- `buffer-tool` (Cursor) reads **one** tool call, normalizes `conversation_id`
  to a safe filename (unsafe chars -> underscore), appends that single
  interaction, filters `mcp__thatch__*`, same 20 cap. Also silent.
- Both write the same `ToolInteraction` shape to the same JSONL format, so
  `flush-tools` drains them identically and `buildExtractionPayload` produces an
  identical contract for the fact-extractor skill.
- Thatch's own tools never appear in either queue (no self-echo feedback loop).

_Automatable: yes — `extract-queue.test.ts` covers both shapes (batch with
`tool_calls` and single-tool), the `mcp__thatch__*` filter, the 20 cap, and
back-compat with `buildExtractionPayload`._
