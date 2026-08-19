import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-003: Fact extraction from tool activity.
 *
 * Automatable: buffer/peek/escalation contract could be tested with the mock
 * client and a synthetic tool call sequence.
 */

const useCase: UseCase = {
  name: "UC-003-extraction-nudge",
  preconditions: [
    "- thatch plugin active in an opencode session",
  ].join("\n"),
  steps: [
    "1. Do some real work: have the agent read files, run commands, edit code —",
    "   any non-`thatch_*`, non-`skill`, non-`task` tool activity.",
    "2. The agent's turn ends and the session goes idle.",
  ].join("\n"),
  expected: [
    "**Expected (opencode — direct extraction, primary path)**",
    "- The plugin's `event` hook catches `session.status` idle with pending tool interactions and calls `triggerExtraction`: creates a child session via `client.session.create({ parentID })` and prompts it via `client.session.promptAsync` (or `client.session.prompt` fire-and-forget if the env var is unset).",
    "- The `extracting` set suppresses the nudge in `chat.message` while the child runs — no nudge text appears in the user's conversation.",
    "- The child loads `thatch-fact-extractor` and saves durable facts via `thatch_memory_remember` — or saves nothing if the activity was routine.",
    "- A `thatch_memory_remember` call in the child drains the parent's snapshot entries from the buffer (via `consumeSnapshot` with `parentSnapshots`).",
    "- When the child goes idle, the parent's snapshot entries are drained (covering no-save runs where no memory was written), the child session is deleted, and a toast notification fires with the extraction metrics (`[thatch] new: N, updated: M, deleted: K`, or `[thatch] extraction complete — nothing to save`).",
    "- If `triggerExtraction` throws, the `extracting` set is cleared and the nudge fires as a fallback on the next `chat.message` (see below).",
    "",
    "**Expected (fallback nudge path — opencode when direct extraction fails,",
    "and all MCP hosts)**",
    "- The agent's context for the next message includes a `[thatch]` nudge carrying the session ID and a fetch tool name — the sub-agent calls `get_extraction_payload` with that session ID to retrieve the queued tool interactions as a tool response, keeping the full payload out of the main session's context window.",
    "- The buffer is **not** drained on nudge delivery — it persists until the agent writes a memory or accepts it by calling `thatch_extraction_done`. Accepting quiets the nudge while holding the entries until the extractor completes; a child extractor that errors or is deleted requeues them. If the nudge is ignored, the next message carries a repeat nudge, escalating in urgency:",
    "  - 1st-2nd miss: polite tone",
    "  - 3rd consecutive miss (missedCount=2): insistent (directive) tone",
    "  - 4th+ consecutive miss (missedCount>=3): ALL-CAPS tone",
    "  The counter resets when the buffer drains (memory write) or is accepted (`thatch_extraction_done`).",
    "- A `thatch_memory_remember` call in a child sub-agent session also drains the parent's buffer (via the `childToParent` Map), so dispatching the fact-extractor as a background task clears the parent's queue.",
    "- Two concurrent sessions never see each other's interactions in a nudge.",
    "- The agent's own `thatch_*` tool calls never appear in the queued interactions (no feedback loop). `skill` and `task` tool calls are also excluded (buffering them would create a nudge → skill load → buffer → nudge loop).",
  ].join("\n"),
};

registerUseCase(useCase);
