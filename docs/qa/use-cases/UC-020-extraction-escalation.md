# UC-020: Extraction nudge escalation and acknowledgment

_Automatable: missedNudges counter + escalation tiers + extraction_done drain
are testable with the mock client and a synthetic tool call sequence._

**Preconditions**
- thatch active in an opencode, Claude Code, or Cursor session
- For the child-sub-agent path: opencode with
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`

**Steps**
1. Do some non-thatch tool work (read files, run commands). Do NOT write any
   memories.
2. Send a message. Observe the extraction nudge — polite tone (missedCount=0).
3. Ignore the nudge. Send another message without writing a memory (missedCount=1).
4. Repeat step 3 (missedCount=2).
5. Repeat step 3 again (missedCount=3+).
6. Acknowledge by calling `thatch_extraction_done` in the session.
7. Send another message.

**Expected**
- Step 2: the nudge is polite, referencing the queued tool interactions.
- Step 4: after 2 consecutive misses (missedCount=2), the nudge is insistent
  (directive tone).
- Step 5: after 3+ consecutive misses (missedCount>=3), the nudge is ALL-CAPS.
- The buffer was NOT drained at any point during steps 2-5 — the buffer
  persists until a memory is written or `extraction_done` is called. The nudge
  repeats each turn with escalated tone (and the payload grows if new tool
  activity adds entries between nudges).
- Step 6: `thatch_extraction_done` drains the buffer and resets the
  `missedNudges` counter. The tool returns `"[acknowledged] extraction buffer
  drained"`.
- Step 7: no extraction nudge appears (buffer is empty). If the user prompt
  semantically matches existing memories, a recall nudge may appear instead.
- Alternative drain path: if a child sub-agent (dispatched via the `task`
  tool) writes a memory via `thatch_memory_remember`, the parent's buffer is
  also drained via the `childToParent` Map — the `missedNudges` counter resets
  for the parent session.
