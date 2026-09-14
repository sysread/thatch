# Session Lifecycle Management (opencode)

opencode emits bus events for session lifecycle changes. Thatch subscribes to these events to manage the extraction pipeline, send session-start reminders, handle child session cleanup, and resolve wrap-up commands.

## What it does

- Session-start reminder + hygiene heartbeat for top-level sessions
- Child session tracking (`childToParent` map, `parentSnapshots`)
- Direct extraction: trigger child session when parent goes idle with pending buffer
- Extraction child lifecycle: created on parent idle, drains parent's snapshot on completion, deleted after
- Sub-agent lifecycle: task-dispatched sub-agents complete accepted entries but are not deleted
- Session error recovery: child errors requeue parent's accepted entries
- Session deletion recovery: child deletion requeues; parent deletion completes accepted entries
- Wrap-up commands: `/thatch/compact` and `/thatch/exit` arm a greenlight check resolved on the next idle

## How it works

### Event handler (`src/index.ts`, event hook)

Subscribes to all session bus events. Dispatches based on `event.type`.

### session.created with parentID (child session)

1. Record `childToParent.set(childID, parentID)`
2. Snapshot the parent's current pending buffer: `parentSnapshots.set(childID, [...extraction.peek(parentID)])`
3. Return early -- child sessions don't get the session-start reminder

This snapshot is used by `consumeSnapshot` for snapshot-aware drain: when the child writes memories, only the snapshot entries are removed from the parent's buffer, preserving interleaved-turn entries that were added after the snapshot was taken.

### session.created without parentID (top-level session)

- Send session-start reminder via `client.session.prompt` with `noReply: true` and `synthetic: true`
- The reminder includes the hygiene heartbeat (pending dedup pairs, stale count, orphaned branch memories) when any signal is non-zero
- See [hygiene.md](hygiene.md)

### session.status idle -- extraction child

When a child created by `triggerExtraction` goes idle:

1. Drain the parent's snapshot from pending buffer via `consumeSnapshot` (if still present -- a no-save run's entries need draining so they don't replay; a save run already drained them via `tool.execute.after`)
2. Never drains the entire buffer -- interleaved-turn entries survive
3. Fire a toast with extraction metrics (new/updated/deleted counts) -- only if memories were actually written
4. `completeAccepted(parentID)`, reset `missedNudges`
5. Clean up all maps: `extracting`, `childToParent`, `parentSnapshots`, `childMetrics`, `extractionChildren`
6. `consume(childID)` -- drain child's own buffer
7. Delete the child session via `client.session.delete`

### session.status idle -- task-dispatched sub-agent

When a task-dispatched sub-agent (not created by `triggerExtraction`) goes idle:

- `completeAccepted(parentID)` -- complete the parent's accepted entries (from the nudge-path `extraction_done` accept)
- Reset `missedNudges`
- Does NOT drain the buffer or delete the session -- the task tool that dispatched the sub-agent needs to read its output

### session.status idle -- parent session

When a parent session (no parentID) goes idle:

- Wrap-up resolution first (below): a pending `/thatch/compact` or `/thatch/exit` resolves here, and a greenlit action returns early
- If not compacting, not already extracting, and buffer has pending interactions: `triggerExtraction(sessionID)`
- On failure: log error, clear `extracting` flag (nudge path takes over as fallback on next chat.message)

### Wrap-up commands (`/thatch/compact`, `/thatch/exit`)

User-invoked slash commands, shipped as command markdown synced by the plugin (see `src/commands.ts`). The template instructs the model to flush pending fact extraction (`thatch_get_extraction_payload` + `thatch_extraction_done`), finish promised memory writes, and surface unaddressed todos -- then end its response with a greenlight token (`THATCH_COMPACT_READY` / `THATCH_EXIT_READY`) only when safe to proceed. Text typed after the command is forwarded into a labeled `# User Message` section ahead of the `# Pre-*-wrap-up` checklist section (opencode's `$ARGUMENTS` substitution): the headers give the user's words provenance, so they cannot be misread as part of the wrap-up instructions. opencode's substitution is purely mechanical with no default-value form (verified against v1.18.30), so the template cannot switch on emptiness; instead the section always carries a fallback line telling the model to treat an empty section as n/a (bare command, no user text).

1. `command.execute.before` arms the session in `pendingWrapUp` when the command runs
2. On the session's next idle, the plugin fetches the session's messages via the SDK client and checks the final assistant message's trailing text for the token (trimmed, exact match)
3. Token present: trigger the TUI action and return early -- compaction is starting (the checklist drained the buffer) or the process is exiting
   - compact: `client.tui.executeCommand({ body: { command: "session_compact" } })`. The execute-command route only accepts legacy alias names; `session_compact` maps to the TUI's `session.compact` action, the same thing the built-in `/compact` runs
   - exit: unregister the session from the chat directory first (a greenlit exit's host is about to vanish; other sessions must stop addressing mail to it), then `client.tui.publish({ body: { type: "tui.command.execute", properties: { command: "app.exit" } } })`. No exit alias exists, so the TUI keymap command is published directly. The exit template's checklist also asks the model to call `thatch_chat_unregister` as its last persistence step; the plugin-side unregister is the deterministic backstop. Compaction deliberately does NOT unregister - the session continues
4. Token absent: warning toast pointing at the blockers in the response, then fall through -- the model may have buffered tool interactions that still need extraction

### Command file install

`installOpencodeCommands` syncs the command markdown into
`$XDG_CONFIG_HOME/opencode/command/thatch/` on every plugin load, writing only
files whose on-disk content differs (template updates self-heal). opencode
loads config -- including command discovery -- before plugins, so a
first-ever install is invisible until the next server start.

### session.error (child session)

- `requeueAccepted(parentID)` -- move parent's accepted entries back to pending (the extractor never processed them)
- Clean up all maps for the child

### session.deleted -- child

- `requeueAccepted(parentID)` -- entries go back to pending (never processed)
- Clean up all maps for the child

### session.deleted -- parent

- `completeAccepted(id)` -- a deleted parent takes its accepted entries with it
- Clear `extracting` for the parent
- Clear `pendingWrapUp` for the parent

### session.compacted

- Clear the `compacting` flag so chat.message nudges resume
- See [compaction-recovery.md](compaction-recovery.md)

### Internal state maps

- **childToParent**: `Map<childID, parentID>` -- maps child sessions to their parents
- **parentSnapshots**: `Map<childID, Interaction[]>` -- snapshot of parent's buffer at child creation time
- **childMetrics**: `Map<childID, {new, updated, deleted}>` -- extraction metrics per child
- **extracting**: `Set<parentID>` -- parent IDs with an active direct-extraction child (suppresses nudge)
- **extractionChildren**: `Set<childID>` -- distinguishes extraction children from task-dispatched sub-agents
- **compacting**: `Set<sessionID>` -- sessions currently being compacted (suppresses nudges)
- **pendingWrapUp**: `Map<sessionID, {token, kind}>` -- wrap-up commands awaiting their greenlight check; armed by `command.execute.before`, resolved on the next idle, cleared on session deletion
- **missedNudges**: `Map<sessionID, number>` -- extraction nudge escalation counter

## Interactions with other features

- Extraction pipeline ([extraction.md](extraction.md)): direct extraction is triggered by `session.status idle`; child lifecycle managed here
- Nudge pipeline ([nudge-pipeline.md](nudge-pipeline.md)): `extracting` set suppresses tier 1; `compacting` set suppresses all tiers
- Hygiene ([hygiene.md](hygiene.md)): hygiene report runs at `session.created` for top-level sessions
- Compaction recovery ([compaction-recovery.md](compaction-recovery.md)): `session.compacted` event clears the compacting flag
- Memory store ([memory-store.md](memory-store.md)): child sessions write memories via `memory_remember`, which triggers drain via `tool.execute.after`

## Source files

- `src/index.ts` -- event handler (all session events), `triggerExtraction`, `cleanupChild`, internal state maps

## Key invariants

- Child sessions don't get the session-start reminder (early return in `session.created` with parentID).
- `consumeSnapshot` is snapshot-aware: removes only entries captured at dispatch time, preserving interleaved-turn entries.
- Extraction children are deleted after going idle; task-dispatched sub-agents are NOT deleted (task tool reads output).
- Child errors requeue the parent's accepted entries (never processed). Child deletion also requeues.
- Parent deletion completes accepted entries (takes them with it).
