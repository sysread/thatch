import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-020: Extraction nudge escalation and acknowledgment (MCP hosts).
 *
 * The escalating extraction nudge exists ONLY on MCP hosts (Claude Code,
 * Cursor): there is no plugin lifecycle to create child sessions, so
 * extraction there is still model-driven. On opencode there is no extraction
 * nudge at all (plugin-driven at idle - see UC-003); the opencode part of
 * this case verifies the ABSENCE of escalation.
 *
 * Automatable: the escalation tiers are pinned in tests/plugin.test.ts
 * (extractionNudge escalation) and the no-drain-on-ack queue contract in
 * tests/extract-queue.test.ts.
 */

const useCase: UseCase = {
  name: "UC-020-extraction-escalation",
  userDoc: "docs/user/extraction.md",  preconditions: [
    "- thatch active in a Claude Code or Cursor session (MCP path) for the",
    "  escalation steps; an opencode session for the absence check",
  ].join("\n"),
  steps: [
    "1. Do some non-thatch tool work (read files, run commands). Do NOT write any",
    "   memories.",
    "2. Send a message. Observe the extraction nudge — polite tone (missedCount=0).",
    "3. Ignore the nudge. Send another message without writing a memory (missedCount=1).",
    "4. Repeat step 3 (missedCount=2).",
    "5. Repeat step 3 again (missedCount=3+).",
    "6. Follow the nudge: dispatch the extractor sub-agent, then acknowledge by",
    "   calling `mcp__thatch__extraction_done` in the parent session.",
    "7. Send another message BEFORE the sub-agent has fetched.",
    "8. Let the sub-agent fetch, extract, and call `mcp__thatch__extraction_done`",
    "   with the parent's `session_id`. Send another message.",
  ].join("\n"),
  expected: [
    "**MCP hosts (Claude Code, Cursor)**",
    "- Step 2: the nudge is polite, referencing the queued tool interactions.",
    "- Step 4: after 2 consecutive misses (missedCount=2), the nudge is insistent",
    "  (directive tone).",
    "- Step 5: after 3+ consecutive misses (missedCount>=3), the nudge is ALL-CAPS.",
    "- The file-backed queue was NOT drained at any point during steps 2-5 — the",
    "  nudge peeks. It repeats each prompt with escalated tone (and the queued",
    "  interactions grow if new tool activity adds entries between nudges). The",
    "  nudge carries the session ID and fetch tool name, not the full payload —",
    "  the sub-agent fetches it via `mcp__thatch__get_extraction_payload`.",
    "- Step 6: the parent's `extraction_done` ack resets the escalation counter",
    "  and returns `\"[acknowledged]\"` — but does NOT drain the queue. (A drain",
    "  at ack time deleted the queue before the sub-agent fetched: the",
    "  accept-before-fetch loss.)",
    "- Step 7: the nudge re-fires at polite tone (counter was reset, queue still",
    "  present) — this is correct, not a bug: the queue is durable until the",
    "  extractor completes. The sub-agent's fetch still finds the interactions.",
    "- Step 8: the sub-agent's `extraction_done` with the parent's `session_id`",
    "  drains the queue (`drainExtractionQueue`). The next message carries no",
    "  extraction nudge. If the prompt semantically matches existing memories, a",
    "  recall nudge may appear instead.",
    "",
    "**opencode (absence check)**",
    "- Repeat steps 1-5 in an opencode session: NO extraction nudge appears at",
    "  any step, at any tone. Extraction runs when the session goes idle via a",
    "  plugin-created child (UC-003) — no `missedNudges` counter exists, no",
    "  escalation, no model-facing dispatch instruction. A manual",
    "  `thatch_extraction_done` in the parent is tolerated as a non-destructive",
    "  accept (entries held, re-extracted by the stale reaper if never completed)",
    "  but is not part of the protocol.",
  ].join("\n"),
};

registerUseCase(useCase);
