# UC-007: Prompt-aware recall nudge

**Preconditions**
- A store with a memorable fact, e.g. "staging DB at staging-db.internal:5432"
- An opencode session AND (separately) a Claude Code / Cursor session with the MCP server
  running and the sideband socket live

**Steps**

**opencode path**
1. Send a prompt matching the memory, e.g. "where does staging data live?"
2. Send an unrelated prompt.
3. Send a prompt shorter than 10 characters.

**Claude Code / Cursor path**
4. With the MCP server running and the sideband socket live, send a matching prompt (queue empty).
5. Stop the MCP server; send a matching prompt.

**Expected**
- opencode: the `chat.message` hook embeds the prompt text (skipped when shorter than 10 chars),
  searches `db.search([repo, global])`; a match at or above 0.55 pushes a synthetic nudge part
  with labels and scores (singular wording for one match; up to two labels plus "etc." for more).
- No match above threshold produces no nudge.
- The nudge uses `db.search`, not `db.recall`, so **no recall telemetry is stamped** — usage
  tracking fires only on explicit `thatch_memory_recall` / CLI `search`, not on nudges.
- Claude Code / Cursor: `flush-tools` asks the warm MCP server via the sideband socket; the
  returned labels become a nudge using the bare `memory_recall` name. With the MCP server down,
  the recall nudge is absent (UC-009 covers the write-nudge fallback).

_Automatable: partial — the sideband embed + search round-trip and threshold logic are
unit-tested in `sideband.test.ts`; a live agent observing and acting on the nudge is manual._