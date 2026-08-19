# Compaction Recovery (opencode)

opencode compacts long sessions by generating a summary and replacing the conversation history. Without intervention, a compacted session would lose awareness of thatch -- the agent would stop using memory tools, extraction would stop, and nudges would fire during summary generation where tools are blocked.

## What it does

- Suppresses nudges during compaction (tools are blocked during summary generation)
- Injects compaction context so the agent retains awareness of thatch after compaction
- Clears the compacting flag on success (three mechanisms, belt-and-suspenders)
- Handles compaction failure (clears stale flag if autocontinue never fired)

## How it works

### Four hooks/events

1. **experimental.session.compacting** (hook) -- fires when opencode starts compacting. Adds sessionID to the `compacting` set. Pushes `compactionContext(repo)` into `output.context`. The context tells the agent to preserve what's been learned and decided this session so there's continuity after compaction.

2. **experimental.compaction.autocontinue** (hook) -- fires after compaction succeeds and the auto-continue turn fires. Removes sessionID from the `compacting` set so nudges resume.

3. **session.compacted** (event) -- fires on successful compaction. Clears the `compacting` flag. Belt-and-suspenders: if autocontinue didn't fire or wasn't installed, the event still clears the flag.

4. **Compaction failure fallback** (chat.message hook) -- if a non-compaction chat.message arrives while the session is in the `compacting` set, compaction failed (autocontinue never fired). The hook clears the stale `compacting` flag and proceeds normally. Without this, the session would be stuck with nudges off forever.

### Why nudges are suppressed during compaction

During summary generation, tools are blocked. A nudge that instructs the agent to use `thatch_memory_recall` or `thatch_memory_remember` would cause a blocked-tool error. The `compacting` set is checked at the top of the chat.message hook -- if the session is compacting, all nudges are skipped.

### Compaction context

`compactionContext(repo)` in `src/prompts.ts` generates text that tells the agent: you are using thatch, here's what you've learned and decided this session, preserve this context after compaction. This is pushed into `output.context` (not `output.system`) so it's part of the compaction output, not the permanent system prompt.

## Interactions with other features

- Nudge pipeline ([nudge-pipeline.md](nudge-pipeline.md)): compaction guard is the first check in the chat.message hook; suppresses all 4 tiers
- Session lifecycle ([session-lifecycle.md](session-lifecycle.md)): `session.compacted` event is handled in the event handler
- Multi-host ([multi-host.md](multi-host.md)): compaction recovery is opencode-only. Claude Code and Cursor do not have this feature. Mitigation: `CLAUDE.md`/`AGENTS.md` persists through compaction, and SessionStart hooks fire after compaction.

## Source files

- `src/index.ts` -- all four hooks/events (experimental.session.compacting, experimental.compaction.autocontinue, session.compacted event, chat.message compaction guard)
- `src/prompts.ts` -- compactionContext function

## Key invariants

- The `compacting` set is checked at the top of chat.message. If set, all nudges are skipped.
- Three mechanisms clear the flag (autocontinue, session.compacted event, chat.message fallback). Belt-and-suspenders.
- Compaction failure fallback: a non-compaction message during compacting = compaction failed. Clear and proceed.
- opencode-only feature. MCP hosts rely on static instructions persisting through compaction.
