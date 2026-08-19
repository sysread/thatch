# Fact Extraction

Thatch buffers your session's tool calls and extracts durable facts from
them into memories. This happens automatically, without any prompt from
you.

## How it works

1. **Buffering**: As the session runs, thatch records tool calls (read,
   edit, bash, grep, etc.) in an in-memory ring buffer (up to 20 per
   session). The buffer is a parallel data structure, not derived from
   conversation history.

2. **Extraction**: When the session goes idle (after the agent's turn
   completes), the plugin creates a child session and prompts it to run
   the `thatch-fact-extractor` skill. The child fetches the buffered
   tool interactions via `thatch_get_extraction_payload`, extracts
   durable facts, and writes them as memories via
   `thatch_memory_remember`.

3. **Cleanup**: When the child finishes, the parent's buffer is
   drained and a toast notification shows the results (`[thatch] new: 2,
   updated: 1`). The child session is deleted.

You see the toast. You do not see the nudge or the child session. The
extraction runs in the background and does not interrupt your
conversation.

## Fallback path (Claude Code and Cursor)

On MCP hosts (Claude Code, Cursor), there is no SDK client to create
child sessions. The extraction nudge is injected into the next user
message instead. The agent dispatches a sub-agent to run the
fact-extractor skill, then calls `thatch_extraction_done` to acknowledge.

## What gets extracted

The fact-extractor skill decides what is worth saving. It looks for:

- Durable project facts (architecture, conventions, design decisions)
- Non-obvious gotchas and footguns
- Data model relationships
- User preferences and corrections

It does NOT save:

- Point-in-time facts (current file locations, line numbers, function
  names)
- Commit hashes or branch-specific history
- Anything re-derivable from the codebase faster than recalling it

## Configuration

- `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`: enables async
  extraction (child sessions run in the background, fire-and-forget).
  Without this, extraction still works but the child session runs
  synchronously (blocking the turn briefly). Put it in your shell rc,
  `mise.toml [env]`, or `.envrc`. OpenCode only; not needed for
  Claude Code or Cursor.

## Limitations

- The buffer caps at 20 tool interactions per session. If the session
  runs long, older interactions are dropped before the extraction fires.
- Extraction only runs when the session goes idle. If the agent is
  continuously active, the buffer grows until 20 and then stops
  recording.
- The fact-extractor is an LLM. Its quality depends on the model.
  Weak models may miss durable facts or save point-in-time noise.
- Compaction does not affect the buffer. The buffer is a parallel
  data structure that survives conversation compaction.

See [memory.md](memory.md) for the memory system the extractor
writes to.
