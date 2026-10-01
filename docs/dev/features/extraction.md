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
- Two paths: **direct extraction** via a plugin-created child session (the
  only opencode path) and **nudge-based extraction** (MCP hosts only)
- The MCP extraction nudge escalates: polite (0–1 missed), insistent (2),
  all-caps shouting (3+). There is deliberately no opencode nudge: the
  model-driven handshake it required raced its own state machine (acks
  before fetches, no-claim completions wiping in-flight sets, mis-targeted
  session ids making every transition a silent no-op) and was removed —
  see "Key invariants"
- `thatch_get_extraction_payload` fetches queued interactions as JSON,
  keeping the full payload out of the main session's context window; the
  fetch is also the **delivery record** (it claims the entries for that
  fetcher)
- `thatch_extraction_done` completes only the calling child's claimed
  delivery — never the whole accepted set
- AMQP-style buffer lifecycle for opencode: pending → accepted → completed,
  with requeue on failure
- File-backed JSONL queue for MCP hosts (no cross-call state)

## How it works

### Tool interaction buffering

After every tool execution, non-`thatch_*`, non-`skill`, non-`task` tool
calls are buffered for later extraction.

**opencode** — `tool.execute.after` hook (v1) / `tool.hook` (v2) in `src/runtime.ts`:

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
- Code Mode `execute` calls are **unwrapped before filtering**
  (`unwrapExecuteThatchCalls` in `src/extraction.ts`): when the call's code
  invokes `tools.thatch_*` tools, the wrapped tools' hook semantics run
  (ack, drain, metrics) and the call itself is never buffered. Matching on
  the outer tool name alone re-queued the pipeline's own dispatch/ack
  traffic every cycle — each extraction run queued the next one, producing
  an infinite dispatch/ack loop (observed live, September 2026). Execute
  calls that touch no thatch tools buffer as normal.

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

### Direct extraction (opencode, the only opencode path)

When a parent session goes idle (`session.status` idle event) with pending
buffer interactions — after `requeueStaleAccepted()` has returned any
timed-out accepted entries to pending:

1. `triggerExtraction` adds the parent ID to the `extracting` set — this
   gates re-triggering while a child runs
2. Peeks the buffer to count pending interactions
3. Creates a child session via
   `client.session.create({ parentID, title: "thatch-extraction" })`
4. The `session.created` event fires, populating `childToParent` and
   `parentSnapshots` (a snapshot of the full pending buffer at dispatch
   time — journal-recovery data only; claims subsumed the snapshot drain)
5. Adds the child ID to the `extractionChildren` set
6. Prompts the child with `extractionDirectPrompt(count, sessionID)` — the
   plugin interpolates the parent's session ID into the prompt, so no
   model ever has to copy one
7. If background sub-agents are enabled
   (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`): `promptAsync`. Otherwise:
   fire-and-forget `prompt`
8. On prompt failure: `cleanupChild` removes the child from all maps and
   deletes the child session. The entries stay pending; the next idle
   retries (there is no nudge fallback)

The child session then:

- Calls `thatch_get_extraction_payload` — the fetch **claims** the entries
  for this fetcher (claim = accept + delivery record)
- Runs the [thatch-fact-extractor](../skills.md) skill
- Writes memories via `thatch_memory_remember`
- Goes idle

On child idle (`session.status` idle event, extraction child):

1. `completeClaimed(childID)` — consumes only the entries this child
   claimed via its fetch. A no-claim idle is a no-op: a child that never
   fetched processed nothing, and its idle signal must not drop entries
   another extractor holds
2. Fires a toast with extraction metrics (only if memories were actually
   written)
3. Cleans up all maps
4. `consume(childID)` — drains the child's own buffer
5. Deletes the child session

If the extraction child is deleted before completing,
`requeueClaimed`/`requeueAccepted` returns what it held to pending. If its
completion signal never comes at all, `requeueStaleAccepted` (15 min)
returns the accepted entries to pending — the next idle re-extracts them.

### Nudge-based extraction (MCP hosts only)

Claude Code and Cursor have no SDK client to create child sessions and no
plugin lifecycle (each hook invocation is a fresh process), so extraction
there is still model-driven. When the buffer has pending interactions, the
next user prompt (`UserPromptSubmit`/`beforeSubmitPrompt`) gets an
extraction nudge telling the agent to spawn a sub-agent for the
fact-extractor skill.

- The nudge carries the session ID and fetch tool name — not the full
  payload — so the sub-agent calls `thatch_get_extraction_payload` to
  retrieve the interactions as a tool response

**Nudge escalation** (via the file-backed missed counter):

| Missed count | Tone |
|--------------|------|
| 0–1 | Polite |
| 2 | Insistent |
| 3+ | All-caps shouting |

The file-backed queue persists until the extractor completes
(`extraction_done` with the parent's `session_id`) or the parent writes a
memory itself. The parent's dispatch-time ack resets the escalation
counter but does NOT drain the queue — a drain at ack time deleted the
queue before the sub-agent fetched (the accept-before-fetch loss; the
opencode path removed the handshake for the same failure class).

### Buffer lifecycle (opencode, AMQP-style)

Buffered interactions move through four states in `ExtractionPipeline`
(`src/extraction.ts`):

- **pending** — interactions in the ring buffer. The idle trigger
  (`triggerExtraction`) fires on them; there is no model-facing nudge.
- **accepted** — moved from pending by `accept()` (a parent's legacy ack,
  or a fetcher's claim). Entries are held, not dropped, and are still
  served by the payload provider.
- **completed** — dropped by `completeClaimed()` (the fetcher's completion
  signal) or `completeAccepted()` (the parent session being deleted —
  nothing exists to replay into).
- **requeued** — moved back to pending by `requeueClaimed()` /
  `requeueAccepted()` (child error or deletion before completing) or
  `requeueStaleAccepted()` (15-minute completion timeout).

Key methods:

| Method | Action |
|--------|--------|
| `push()` | Add interaction to pending buffer (capped at 20) |
| `peek()` | Read without clearing |
| `consume()` | Delete the session's pending buffer (called on memory write) |
| `accept()` | Move pending to accepted — hold entries (non-destructive) |
| `claim()` | Accept + record WHICH fetcher received the entries — the delivery record |
| `completeClaimed()` | Drop only the completing fetcher's claimed entries |
| `completeAccepted()` | Drop accepted entries — used on parent deletion |
| `requeueClaimed()` / `requeueAccepted()` | Move held entries back to pending — extractor died |
| `requeueStaleAccepted()` | Requeue accepted entries held longer than 15 min |

### Parent-child delivery (claim semantics)

The payload fetch is the delivery record:

1. `thatch_get_extraction_payload` with a fetcher identity calls
   `claim(parentID, fetcherID)`: the pending buffer is accepted and the
   fetcher's claim records exactly which entries it received
2. The fetcher's completion signal (`extraction_done` or
   `memory_remember` from that child) calls `completeClaimed(fetcherID)` —
   consuming only the claimed entries, by reference identity
3. A completion from a fetcher with no claim is a **no-op** — it processed
   nothing, so it must not drop entries another extractor holds (a sibling
   sub-agent going idle, or a mis-ordered ack, once wiped the whole
   accepted set this way — the accept-then-racing-completion loss)
4. Entries that arrived after the fetch stay pending; the next idle
   re-extracts them

### MCP file-backed queue drain

- `drainExtractionQueue(sessionID)` calls `resetMissedCount` +
  `consumeQueue` (deletes the JSONL file)
- Triggered by: `thatch_extraction_done` called with the parent's
  `session_id` (the extractor's completion), or `thatch_memory_remember`
  called by the parent itself
- `appendBatch` in `extract-queue.ts` self-detects `memory_remember` and
  resets the counter + consumes the queue inline. It detects
  `extraction_done` too, but only resets the counter — draining at the
  parent's dispatch-time ack deleted the queue before the sub-agent
  fetched (the accept-before-fetch loss)

### The `extraction_done` tool

- No-op confirmation (`[acknowledged]`) unless `session_id` is passed and
  `drainExtractionQueue` is wired
- On the MCP path with `session_id`: resets the missed-nudge count +
  consumes (deletes) the file-backed queue
- The real state transitions happen in the host's post-tool hook
  (`tool.execute.after` for opencode, `PostToolBatch`/`appendBatch` for MCP)
- The tool exists primarily so the model has a recognizable name to key on
- On opencode there is no parent ack any more: a parent-side
  `extraction_done` is tolerated as a non-destructive accept (entries
  held, not dropped) for backward compatibility with an in-flight older
  nudge

### The `get_extraction_payload` tool

- Fetches the queued tool interactions for extraction as serialized JSON
  (`interactions`, `projectStore`, `globalStore`)
- **opencode**: peeks accepted + pending interactions, builds JSON via
  `buildExtractionPayload`
- **MCP**: peeks the file-backed queue, builds the same JSON payload
- `session_id` is optional: omitted, it resolves to the invoking session
  via `HostToolContext.sessionID` (opencode path). On MCP hosts there is no
  session context, so an omitted `session_id` returns a "pass the parent
  session's session_id" error. Explicit IDs always win - that is how a
  sub-agent drains the parent's queue
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
  (highest priority, returns early) on MCP hosts; opencode's
  `chat.message` runs the recall tier only
- [Session lifecycle](session-lifecycle.md) — direct extraction is triggered
  by `session.status` idle; child lifecycle is managed by the event handler
- [Skills](../skills.md) — the thatch-fact-extractor skill is dispatched to
  child sessions
- [Multi-host](multi-host.md) — in-memory ring buffer for opencode,
  file-backed queue for MCP hosts
- [Compaction recovery](compaction-recovery.md) — nudges are
  suppressed during compaction (tools are blocked)

## Source files

| File | Responsibility |
|------|----------------|
| `src/extraction.ts` | In-memory ring buffer (`ExtractionPipeline`), shared payload builders (`buildExtractionPayload`, `deriveTitle`, `summarizeArgs`) |
| `src/extract-queue.ts` | File-backed JSONL queue for MCP hosts |
| `src/runtime.ts` | opencode hooks: `tool.execute.after`, `session.status` idle (direct extraction trigger), `session.created`, `session.error`, `session.deleted`, `chat.message` (recall/prediction/behavior nudges; no extraction nudge) -- shared by the v1/v2 adapters |
| `bin/thatch` | `buffer-batch`, `buffer-tool`, `flush-tools` subcommands |
| `src/prompts.ts` | `extractionNudge` (with escalation), `extractionDirectPrompt` |

## Key invariants

1. **Tool filtering is absolute.** `thatch_*`, `skill`, `task`, and
   `subagent` tools are never buffered. Buffering them would echo the store
   into itself or create a feedback loop.
2. **Extraction never depends on model cooperation on opencode.** The
   plugin creates the extraction child, interpolates the session ID, and
   drives the lifecycle from events. The old model-driven handshake (model
   dispatches, parent acks, child copies the ID) raced its own state
   machine — the September 2026 dispatch-loop report (accept-before-fetch
   loss + never-terminating re-nudge) — and was removed. The opencode
   `chat.message` hook computes no extraction nudge.
3. **Completion is claim-scoped.** Only a fetcher that recorded a claim
   (via `get_extraction_payload`) can consume entries, and only the entries
   it received. No-claim completions are no-ops; no transition drops
   entries another extractor holds. The stale reaper bounds any orphan
   linger at 15 minutes.
4. **`tool.execute.after` is a plugin hook, not a bus event.** The event bus
   has no such event. Moving the buffering logic into the `event` handler
   silently never fires it.
5. **MCP host hooks must be silent.** `PostToolBatch`/`postToolUse` produce
   no stdout — only `flush-tools` prints. Any stdout delays the agent loop.
6. **The MCP queue is durable until the extractor completes.** The
   parent's dispatch-time ack must not drain it (see the invariant above);
   the drain happens at the extractor's completion or the parent's own
   memory write.
