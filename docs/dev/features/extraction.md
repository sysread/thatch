# Extraction Pipeline

Automated capture of durable facts from tool interactions. The agent does not
need to remember to save — the system buffers tool calls and nudges the agent
to extract memories from them.

The facts most worth remembering overwhelmingly surface in tool call results
(file contents, command output, API responses, git state) rather than in
conversation prose. So tool calls serve as both the **trigger** and the
**queue**. A fact that exists only in conversation never enters the buffer;
the system prompt instructs the agent to call `thatch_memory_remember`
directly for conversation-derived knowledge.

## What it does

- Buffers every non-`thatch_*`, non-`skill`, non-`task` tool call for later
  extraction
- Two paths: **direct extraction** via a child session (opencode, primary) and
  **nudge-based extraction** (all hosts, fallback for opencode, primary for
  MCP)
- The extraction nudge escalates: polite (0–1 missed), insistent (2),
  all-caps shouting (3+)
- `thatch_get_extraction_payload` fetches queued interactions as JSON,
  keeping the full payload out of the main session's context window
- `thatch_extraction_done` acknowledges and quiets the nudge
- AMQP-style buffer lifecycle for opencode: pending → accepted → completed,
  with requeue on failure
- File-backed JSONL queue for MCP hosts (no cross-call state)
- Parent-child session drain: the child drains the parent's snapshot,
  preserving interleaved-turn entries added after the snapshot was taken

## How it works

### Tool interaction buffering

After every tool execution, non-`thatch_*`, non-`skill`, non-`task` tool
calls are buffered for later extraction.

**opencode** — `tool.execute.after` hook in `src/index.ts`:

- In-memory ring buffer per session (`ExtractionPipeline` in
  `src/extraction.ts`)
- Max 20 interactions per session
- For child sessions, also tracks new/updated/deleted metrics via
  `childMetrics`
- `tool.execute.after` is a **plugin hook, not a bus event**. Moving it into
  the `event` handler silently never fires it — the event bus has no such
  event
- Filtering rationale: `thatch_*` tools would echo the store back into
  itself; `skill`/`task` meta-tools would create a feedback loop (extraction
  triggers a skill load, which gets buffered, which triggers another
  extraction)

**MCP hosts** — `bin/thatch`, `src/extract-queue.ts`:

- Claude Code: `PostToolBatch` hook → `thatch buffer-batch` (reads JSON from
  stdin: `{ session_id, tool_calls }`)
- Cursor: `postToolUse` hook → `thatch buffer-tool` (reads JSON from stdin,
  single tool, uses `conversation_id`)
- File-backed JSONL queue under
  `$XDG_CACHE_HOME/thatch/queue/<session>.jsonl` (max 20, oldest dropped)
- Silent on success (no stdout) so the agent loop is not delayed
- Filters the same tools as opencode (`mcp__thatch__memory_remember`,
  `mcp__thatch__extraction_done`, `mcp__thatch__*`, `skill`, `task`, `agent`)

### Direct extraction (opencode, primary path)

When a parent session goes idle (`session.status` idle event) with pending
buffer interactions:

1. `triggerExtraction` adds the parent ID to the `extracting` set — this
   suppresses the nudge in `chat.message`
2. Peeks the buffer to count pending interactions
3. Creates a child session via
   `client.session.create({ parentID, title: "thatch-extraction" })`
4. The `session.created` event fires, populating `childToParent` and
   `parentSnapshots` (a snapshot of the full pending buffer at dispatch time)
5. Adds the child ID to the `extractionChildren` set
6. Prompts the child with `extractionDirectPrompt(count, sessionID)`
7. If background sub-agents are enabled
   (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`): `promptAsync`. Otherwise:
   fire-and-forget `prompt`
8. On prompt failure: `cleanupChild` removes the child from all maps and
   deletes the child session

The child session then:

- Calls `thatch_get_extraction_payload` to fetch the queued interactions
- Runs the [thatch-fact-extractor](../skills.md) skill
- Writes memories via `thatch_memory_remember`
- Goes idle

On child idle (`session.status` idle event, extraction child):

1. Drains the parent's snapshot from the pending buffer via
   `consumeSnapshot` — removes only entries captured at dispatch time by
   reference identity, preserving interleaved-turn entries
2. Fires a toast with extraction metrics (only if memories were actually
   written)
3. `completeAccepted(parentID)`, resets `missedNudges`
4. Cleans up all maps
5. `consume(childID)` — drains the child's own buffer
6. Deletes the child session

### Nudge-based extraction (fallback for opencode, primary for MCP)

If direct extraction was never triggered or threw an error (session not in
the `extracting` set) **and** the buffer has pending interactions:

- The next user message (`chat.message` for opencode,
  `UserPromptSubmit`/`beforeSubmitPrompt` for MCP) gets an extraction nudge
- The nudge carries the session ID and fetch tool name — not the full
  payload — so the sub-agent calls `thatch_get_extraction_payload` to
  retrieve the interactions as a tool response

**Nudge escalation** (via the `missedNudges` counter):

| Missed count | Tone |
|--------------|------|
| 0–1 | Polite |
| 2 | Insistent |
| 3+ | All-caps shouting |

The buffer persists until the agent writes a memory or calls
`thatch_extraction_done`. Ignored nudges repeat and escalate.

- **opencode**: in-memory `missedNudges` map
- **MCP hosts**: file-backed `.count` file per session

### Buffer lifecycle (opencode, AMQP-style)

Buffered interactions move through four states in `ExtractionPipeline`
(`src/extraction.ts`):

- **pending** — interactions in the ring buffer. The nudge fires on
  `chat.message`.
- **accepted** — moved from pending by `accept()`. The nudge quiets, but
  entries are not dropped yet.
- **completed** — dropped by `completeAccepted()`. Triggered by a
  `memory_remember` or `extraction_done` call in the child, or the child
  going idle.
- **requeued** — moved back to pending by `requeueAccepted()`. Triggered by
  the child session erroring or being deleted before completing.

Key methods:

| Method | Action |
|--------|--------|
| `push()` | Add interaction to pending buffer (capped at 20) |
| `peek()` | Read without clearing |
| `consume()` | Delete the session's pending buffer (called on memory write) |
| `accept()` | Move pending to accepted — quiet the nudge, hold entries |
| `completeAccepted()` | Drop accepted entries — extractor finished |
| `requeueAccepted()` | Move accepted back to pending — extractor died |
| `consumeSnapshot()` | Remove only entries that were in the snapshot (by reference identity). Used for child-parent drain. |

### Parent-child session drain

When a child session writes a memory via `thatch_memory_remember`:

1. `tool.execute.after` detects the memory write
2. If in a child session (`childToParent.has(sessionID)`): track metrics,
   `completeAccepted(parentID)`, drain the parent's snapshot via
   `consumeSnapshot`, reset the parent's `missedNudges`
3. `consume(sessionID)` — drains the child's own buffer

`consumeSnapshot` is **snapshot-aware**: it removes only entries that were
in the parent's buffer at dispatch time (by reference identity).
Interleaved-turn entries — added after the snapshot was taken, while the
child was extracting — survive. This prevents data loss when the parent
continues working while the child extracts.

### MCP file-backed queue drain

- `drainExtractionQueue(sessionID)` calls `resetMissedCount` +
  `consumeQueue` (deletes the JSONL file)
- Triggered by: `thatch_extraction_done` called with the parent's
  `session_id`, or `thatch_memory_remember` called
- `appendBatch` in `extract-queue.ts` self-detects
  `memory_remember`/`extraction_done` calls and resets the counter +
  consumes the queue inline

### The `extraction_done` tool

- No-op confirmation (`[acknowledged]`) unless `session_id` is passed and
  `drainExtractionQueue` is wired
- On the MCP path with `session_id`: resets the missed-nudge count +
  consumes (deletes) the file-backed queue
- The real state transitions happen in the host's post-tool hook
  (`tool.execute.after` for opencode, `PostToolBatch`/`appendBatch` for MCP)
- The tool exists primarily so the model has a recognizable name to key on

### The `get_extraction_payload` tool

- Fetches the queued tool interactions for extraction as serialized JSON
  (`interactions`, `projectStore`, `globalStore`)
- **opencode**: peeks accepted + pending interactions, builds JSON via
  `buildExtractionPayload`
- **MCP**: peeks the file-backed queue, builds the same JSON payload
- Returns `null` when no interactions are queued
- Read-only — it peeks the queue; it does not consume it. Consumption is
  `extraction_done`'s job

### Background sub-agent support (opencode)

- Experimental flag: `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` (set in
  `mise.toml`)
- When enabled: `promptAsync` for child session creation (async extraction)
- When disabled: fire-and-forget `prompt` (synchronous but unawaited)

## Interactions with other features

- [Memory store](memory-store.md) — extraction writes memories via
  `thatch_memory_remember`
- [Nudge pipeline](nudge-pipeline.md) — the extraction nudge is tier 1
  (highest priority, returns early)
- [Session lifecycle](session-lifecycle.md) — direct extraction is triggered
  by `session.status` idle; child lifecycle is managed by the event handler
- [Skills](../skills.md) — the thatch-fact-extractor skill is dispatched to
  child sessions
- [Multi-host](multi-host.md) — in-memory ring buffer for opencode,
  file-backed queue for MCP hosts
- [Compaction recovery](compaction-recovery.md) — extraction nudge is
  suppressed during compaction (tools are blocked)

## Source files

| File | Responsibility |
|------|----------------|
| `src/extraction.ts` | In-memory ring buffer (`ExtractionPipeline`), shared payload builders (`buildExtractionPayload`, `deriveTitle`, `summarizeArgs`) |
| `src/extract-queue.ts` | File-backed JSONL queue for MCP hosts |
| `src/index.ts` | opencode hooks: `tool.execute.after`, `session.status` idle, `session.created`, `session.error`, `session.deleted`, `chat.message` (nudge tier 1) |
| `bin/thatch` | `buffer-batch`, `buffer-tool`, `flush-tools` subcommands |
| `src/prompts.ts` | `extractionNudge` (with escalation), `extractionDirectPrompt` |

## Key invariants

1. **Tool filtering is absolute.** `thatch_*`, `skill`, and `task` tools are
   never buffered. Buffering them would echo the store into itself or create
   a feedback loop.
2. **The nudge peeks, never flushes.** The buffer persists until a memory
   write or `extraction_done`. Ignored nudges repeat and escalate.
3. **`consumeSnapshot` is snapshot-aware.** It removes only entries captured
   at dispatch time (by reference identity), preserving interleaved-turn
   entries added while the child was extracting.
4. **`tool.execute.after` is a plugin hook, not a bus event.** The event bus
   has no such event. Moving the buffering logic into the `event` handler
   silently never fires it.
5. **MCP host hooks must be silent.** `PostToolBatch`/`postToolUse` produce
   no stdout — only `flush-tools` prints. Any stdout delays the agent loop.
6. **The no-save drain runs unconditionally.** The child-idle handler drains
   the remaining snapshot regardless of whether the child wrote memories,
   covering no-save extraction runs.
