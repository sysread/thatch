# UC-013: Compaction context (opencode-only)

**Preconditions**
- An opencode session that grows long enough to trigger context compaction
- Several memories already stored in the repo's store

**Steps**
1. Work in the session until opencode compacts the context window.
2. Inspect the compaction output.
3. After compaction, ask the agent something that should use a memory tool.

**Expected**
- The compaction output includes the thatch re-familiarization context block
  pushed by `experimental.session.compacting` — it reminds the agent that
  `thatch_memory_recall` exists and that memories persist.
- After compaction, the agent still knows the memory tools exist and uses them
  (it does not "forget" thatch just because the window was summarized).
- This behavior is **opencode-only**. Claude Code's `PostCompact` hook is
  side-effects only and cannot inject context; Cursor has no equivalent hook.
  See `docs/dev/mcp-parity.md` for the gap and its mitigation (CLAUDE.md /
  AGENTS.md persists through compaction; the `SessionStart` recall reminder
  runs again after compaction in Claude Code).

_Automatable: no — requires a live opencode compaction event. The hook's string
content is unit-tested, but actual compaction injection is manual._
