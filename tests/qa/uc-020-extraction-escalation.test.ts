import { registerUseCase, type UseCase } from "./runner";

/**
 * UC-020: Extraction nudge escalation and acknowledgment.
 *
 * Automatable: missedNudges counter + escalation tiers + extraction_done
 * accept are testable with the mock client and a synthetic tool call
 * sequence.
 */

const useCase: UseCase = {
  name: "UC-020-extraction-escalation",
  preconditions: [
    "- thatch active in an opencode, Claude Code, or Cursor session",
    "- For the child-sub-agent path: opencode with",
    "  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`",
  ].join("\n"),
  steps: [
    "1. Do some non-thatch tool work (read files, run commands). Do NOT write any",
    "   memories.",
    "2. Send a message. Observe the extraction nudge — polite tone (missedCount=0).",
    "3. Ignore the nudge. Send another message without writing a memory (missedCount=1).",
    "4. Repeat step 3 (missedCount=2).",
    "5. Repeat step 3 again (missedCount=3+).",
    "6. Acknowledge by calling `thatch_extraction_done` in the session.",
    "7. Send another message.",
  ].join("\n"),
  expected: [
    "- Step 2: the nudge is polite, referencing the queued tool interactions.",
    "- Step 4: after 2 consecutive misses (missedCount=2), the nudge is insistent",
    "  (directive tone).",
    "- Step 5: after 3+ consecutive misses (missedCount>=3), the nudge is ALL-CAPS.",
    "- The buffer was NOT drained at any point during steps 2-5 — the buffer",
    "  persists until a memory is written or `extraction_done` is called. The nudge",
    "  repeats each turn with escalated tone (and the payload grows if new tool",
    "  activity adds entries between nudges).",
    "- Step 6: `thatch_extraction_done` in the parent accepts the buffer (moves it",
    "  to a holding area) and resets the `missedNudges` counter. The tool returns",
    '  `"[acknowledged]"`. Held entries drop when the extractor completes (child',
    "  memory write, child `extraction_done`, or child idle); if the child errors",
    "  or is deleted first, the entries requeue and the nudge replays.",
    "- Step 7: no extraction nudge appears (buffer is accepted). If the user prompt",
    "  semantically matches existing memories, a recall nudge may appear instead.",
    "- Alternative drain path (opencode direct extraction): when the parent session",
    "  goes idle with pending tool interactions, the plugin calls",
    "  `triggerExtraction` — creates a child session via the SDK client and prompts",
    "  it directly. The `extracting` set suppresses the nudge in `chat.message`",
    "  while the child runs. The child writes memories via",
    "  `thatch_memory_remember`, which drains the parent's snapshot entries via",
    "  `consumeSnapshot`. When the child goes idle, the snapshot is drained",
    "  (covering no-save runs), the child session is deleted, and a toast fires",
    "  with the metrics. This path bypasses the nudge-and-acknowledge cycle",
    "  entirely — no `missedNudges` counter, no escalation. The nudge path is",
    "  fallback only (when `triggerExtraction` throws).",
    "- Alternative drain path (agent-initiated): if a child sub-agent (dispatched",
    "  via the `task` tool in the fallback nudge path) writes a memory via",
    "  `thatch_memory_remember`, the parent's buffer is also drained via the",
    "  `childToParent` Map — the `missedNudges` counter resets for the parent",
    "  session.",
  ].join("\n"),
  // No custom run — uses default runViaOpencode.
};

registerUseCase(useCase);
