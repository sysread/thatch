import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-003: Fact extraction from tool activity.
 *
 * Automatable: the buffer/claim/completion contract is covered by
 * tests/plugin.test.ts against the mock client. This live case verifies the
 * end-to-end shape in a real session: tool work -> idle -> plugin-created
 * child -> memories -> toast, with NO nudge text in the user's conversation.
 */

const useCase: UseCase = {
  name: "UC-003-extraction-nudge",
  userDoc: "docs/user/extraction.md",  preconditions: [
    "- thatch plugin active in an opencode session",
  ].join("\n"),
  steps: [
    "1. Do some real work: have the agent read files, run commands, edit code —",
    "   any non-`thatch_*`, non-`skill`, non-`task`/`subagent` tool activity.",
    "2. The agent's turn ends and the session goes idle.",
    "3. Send another message to the session.",
  ].join("\n"),
  expected: [
    "**Expected (opencode — direct extraction, the ONLY opencode path)**",
    "- The plugin's `event` hook catches `session.status` idle with pending tool interactions and calls `triggerExtraction`: creates a child session via the host's session-create capability and prompts it with `extractionDirectPrompt` (the plugin interpolates the parent's session ID — the model never has to copy one).",
    "- The child loads `thatch-fact-extractor`, calls `thatch_get_extraction_payload` (the fetch records the child's CLAIM on the delivered entries — an omitted or self-named `session_id` resolves to the parent automatically), and saves durable facts via `thatch_memory_remember` — or saves nothing if the activity was routine.",
    "- Each `thatch_memory_remember` (or the child's `thatch_extraction_done`) completes the child's claimed delivery — consuming only what it received.",
    "- When the child goes idle, the plugin finalizes the claim-scoped completion, deletes the child session (v1; v2 has no delete capability — documented gap), and fires a toast with the extraction metrics (`[thatch] new: N, updated: M, deleted: K`) when memories were written.",
    "- Step 3's message carries NO `[thatch]` extraction nudge — on opencode there is no model-facing extraction nudge at all. (A recall/prediction/behavior nudge may appear if the prompt matches stored memories; that is a different tier.)",
    "- If `triggerExtraction` throws, the `extracting` set is cleared and the next idle retries from the same pending buffer. If the child errors or is deleted before completing, what it held returns to pending; if its completion signal never arrives, the 15-minute stale reaper requeues the accepted entries. Either way the next idle re-extracts — no interaction is silently lost.",
    "",
    "**Expected (MCP hosts — Claude Code, Cursor: nudge-driven)**",
    "- The agent's context for the next message includes a `[thatch]` nudge carrying the session ID and a fetch tool name — the sub-agent calls `mcp__thatch__get_extraction_payload` with that session ID to retrieve the queued tool interactions as a tool response.",
    "- The file-backed queue is **not** drained on nudge delivery, and NOT drained by the parent's dispatch-time `extraction_done` ack either (the ack only resets the escalation counter — a drain at ack time deleted the queue before the sub-agent fetched). It persists until the extractor completes (`extraction_done` with the parent's `session_id`) or the parent writes a memory itself. If the nudge is ignored, the next prompt carries a repeat nudge, escalating in urgency:",
    "  - 1st-2nd miss: polite tone",
    "  - 3rd consecutive miss (missedCount=2): insistent (directive) tone",
    "  - 4th+ consecutive miss (missedCount>=3): ALL-CAPS tone",
    "",
    "**Both paths**",
    "- Two concurrent sessions never see each other's interactions.",
    "- The agent's own `thatch_*` tool calls never appear in the queued interactions (no feedback loop). `skill`, `task`, `subagent`, and `agent` tool calls are also excluded (buffering a dispatch feeds the pipeline its own exhaust).",
  ].join("\n"),
};

registerUseCase(useCase);
