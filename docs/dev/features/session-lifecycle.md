# Session Lifecycle Management (opencode)

opencode emits bus events for session lifecycle changes. Thatch subscribes to these events to manage the extraction pipeline, send session-start reminders, and handle child session cleanup.

## What it does

- Session-start reminder + hygiene heartbeat for top-level sessions
- Child session tracking (`childToParent` map, `parentSnapshots`)
- Direct extraction: trigger child session when parent goes idle with pending buffer
- Extraction child lifecycle: created on parent idle, drains parent's snapshot on completion, deleted after
- Sub-agent lifecycle: task-dispatched sub-agents complete accepted entries but are not deleted
- Session error recovery: child errors requeue parent's accepted entries
- Session deletion recovery: child deletion requeues; parent deletion completes accepted entries

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

- If not compacting, not already extracting, and buffer has pending interactions: `triggerExtraction(sessionID)`
- On failure: log error, clear `extracting` flag (nudge path takes over as fallback on next chat.message)

### session.error (child session)

- `requeueAccepted(parentID)` -- move parent's accepted entries back to pending (the extractor never processed them)
- Clean up all maps for the child

### session.deleted -- child

- `requeueAccepted(parentID)` -- entries go back to pending (never processed)
- Clean up all maps for the child

### session.deleted -- parent

- `completeAccepted(id)` -- a deleted parent takes its accepted entries with it
- Clear `extracting` for the parent

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
