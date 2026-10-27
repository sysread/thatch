# Session Lifecycle Management (opencode)

Unless noted, `client.*` names below are the opencode v1 mapping; the v2 equivalents and degrades are in [opencode-plugin.md](opencode-plugin.md).

opencode emits bus events for session lifecycle changes. Thatch subscribes to these events to manage the extraction pipeline, send session-start reminders, handle child session cleanup, and resolve wrap-up commands.

## What it does

- Session-start reminder + hygiene heartbeat for top-level sessions
- Child session tracking (`childToParent` map, `parentSnapshots`)
- Direct extraction: trigger child session when parent goes idle with pending buffer
- Extraction child lifecycle: created on parent idle, drains parent's snapshot on completion, deleted after
- Sub-agent lifecycle: task-dispatched sub-agents complete accepted entries but are not deleted
- Session error recovery: child errors requeue parent's accepted entries
- Session deletion recovery: child deletion requeues; parent deletion completes accepted entries
- Stranded-session self-heal: sessions whose recorded directory is gone (a merged + deleted worktree) are deleted when machinery (`thatch-extraction` corpses) and moved to the project's canonical checkout when real
- Wrap-up commands: `/thatch/compact` and `/thatch/exit` arm a greenlight check; each resolves on the model's zero-arg tool call (`thatch_compact` / `thatch_exit`) and the next idle

## How it works

### Event handler (`src/runtime.ts`, shared by both adapters)

Subscribes to all session bus events. Dispatches based on `event.type`.

### session.created with parentID (child session)

1. Record `childToParent.set(childID, parentID)`
2. Snapshot the parent's current pending buffer: `parentSnapshots.set(childID, [...extraction.peek(parentID)])`
3. Return early -- child sessions don't get the session-start reminder

The snapshot is journal-recovery data only (restored child bookkeeping
after a reload); live delivery is claim-based: the child's payload fetch
records exactly which entries it received, and its completion signal
consumes only those.

### session.created without parentID (top-level session)

- Send session-start reminder via `client.session.prompt` with `noReply: true` and `synthetic: true`
- The reminder includes the hygiene heartbeat (pending dedup pairs, stale count, orphaned branch memories) when any signal is non-zero
- See [hygiene.md](hygiene.md)

### session.status idle -- extraction child

When a child created by `triggerExtraction` goes idle:

1. `completeClaimed(childID)` -- consume only the entries this child
   claimed via its payload fetch. A no-claim idle is a no-op: a child that
   never fetched processed nothing, and its idle signal must not drop
   entries another extractor holds. Held entries with no completer are
   bounded by the 15-minute stale reaper
2. Fire a toast with extraction metrics (new/updated/deleted counts) -- only if memories were actually written
3. Clean up all maps: `extracting`, `childToParent`, `parentSnapshots`, `childMetrics`, `extractionChildren`
4. `consume(childID)` -- drain child's own buffer
5. Delete the child session via `client.session.delete`

### session.status idle -- task-dispatched sub-agent

When a task-dispatched sub-agent (not created by `triggerExtraction`) goes idle:

- `completeClaimed(childID)` -- complete only what THIS child claimed via
  its payload fetch (a no-claim idle consumes nothing)
- Does NOT drain the buffer or delete the session -- the task tool that dispatched the sub-agent needs to read its output

### session.status idle -- parent session

When a parent session (no parentID) goes idle:

- Wrap-up resolution first (below): a pending wrap-up resolves here only when greenlit, and a greenlit action returns early
- `requeueStaleAccepted()` first: accepted entries whose completion signal never came (15 min) return to pending
- If not compacting, not already extracting, and buffer has pending interactions: `triggerExtraction(sessionID)`
- On failure: log error, clear `extracting` flag (the next idle retries -- there is no model-facing nudge fallback)

### Wrap-up commands (`/thatch/compact`, `/thatch/exit`)

User-invoked slash commands, shipped as command markdown synced by the plugin (see `src/commands.ts`). The template instructs the model to flush pending fact extraction (`thatch_get_extraction_payload` + `thatch_extraction_done`), finish promised memory writes, and surface unaddressed todos -- then greenlight only when safe to proceed. Text typed after the command is forwarded into a labeled `# User Message` section ahead of the `# Pre-*-wrap-up` checklist section (opencode's `$ARGUMENTS` substitution): the headers give the user's words provenance, so they cannot be misread as part of the wrap-up instructions. opencode's substitution is purely mechanical with no default-value form (verified against v1.18.30), so the template cannot switch on emptiness; instead the section always carries a fallback line telling the model to treat an empty section as n/a (bare command, no user text).

The greenlight protocol is the same for both kinds:

- The model greenlights by calling the kind's zero-arg tool (`thatch_compact` / `thatch_exit`, both opencode-only; the calling session resolves from the per-call host context, never a model-supplied argument). The tool flips `greenlit` on the arm and rewrites the journal row with the flag, so a same-pid plugin reload between the call and the closing idle cannot strand a greenlit session. The templates' rescind rule lives in the prompt channel: with outstanding blockers the model must NOT call the tool, and if the user moves on to unrelated work after blockers were listed, the user re-runs the command when ready (the arm has no runtime expiry).

Both arms are journaled to `runtime_state` (kind `wrapup`) at arming. Resolution:

1. `command.execute.before` arms the session in `pendingWrapUp` when the command runs (on v2 the registered command's `execute` runs the same arming through `onCommandExecuteBefore`). A re-arm overwrites and resets `greenlit`.
2. On the session's next idle: an un-greenlit arm does nothing -- a mid-wrap-up wait (e.g. a background fact-extractor running) must not consume it. Only a greenlit arm resolves.
3. Greenlit: trigger the host action and return early -- compaction is starting (the checklist drained the buffer) or the session is closing. The wrap-up executor deletes the arm and journal row FIRST, then runs the host sequence.
   - compact: v1 dispatches the TUI's `session_compact` command (`client.tui.executeCommand` -- the execute-command route only accepts legacy alias names; `session_compact` maps to the TUI's `session.compact` action, the same thing the built-in `/compact` runs). v2 calls `session.compact({sessionID})` on the promise domain directly (upstream #52385), runtime-guarded because the pinned dev types predate the surface -- an older host degrades to a logged no-op
   - exit: record the session's watcher deaths first (`watchers.sessionDied` -- BEFORE the unregister below, because the death row is placed by the session's chat row and the unregister deletes it; the callback also captures the project there -- the durable row write and the care-based delivery ride an async continuation, since the coordinator link is read from the dead session's spawn metadata over the host), unregister the session from the chat directory (a greenlit exit's host is about to vanish; other sessions must stop addressing mail to it; the tombstone's `exit` reason is what a later restore clears), then close the session out on the host. v1 publishes the `app.exit` TUI keymap command directly (`client.tui.publish` -- no exit alias exists). v2 emits the session-tab bridge's `exit-tab-closed` event, a TUI-ONLY close of the session's OWN tab: the daemon hosts every tab, so `app.exit` would take down unrelated sessions, and the pump deliberately never translates this event (the deaths were already recorded; a second pass would erase the durable death row). The unregister is plugin-side only, after the death recording: the template deliberately does NOT ask the model to call `thatch_chat_unregister`, because a mid-turn unregister would delete the chat row before the death placement could use it. Compaction deliberately does NOT unregister - the session continues

### Restore-rejoin

Restoring an exited session undoes the exit's chat-directory leave: the
startup resume paths (`-s <id>` / `-c`) and the prompt auto-register path
clear the session's `exit` (or `deleted`) leave tombstone and register a
fresh roster row (the "rejoined chat as ..." toast announces it). A
deliberate leave -- the `chat_unregister` tool's `explicit` tombstone --
is NOT cleared by restore; it persists until an explicit
`thatch_chat_register`. The clear lives at those call sites only
(`db.clearRejoinableTombstone`), never inside the register path's
tombstone gate, which stays reason-blind as the in-flight-race and
deleted-zombie backstop. See cross-session-chat.md's Leave tombstones
section for the full reason list.

### Command file install

`installOpencodeCommands` syncs the command markdown into
`$XDG_CONFIG_HOME/opencode/command/thatch/` on every plugin load, writing only
files whose on-disk content differs (template updates self-heal). opencode
loads config -- including command discovery -- before plugins, so a
first-ever install is invisible until the next server start.

### session.error (child session)

- `requeueClaimed(childID)` if it fetched (the delivery was never
  processed), else `requeueAccepted(parentID)` -- the error is a terminal
  death signal, so a claim-less child falls back to whole-set requeue for
  immediate recovery
- Clear `extracting` for the parent (the next idle re-triggers)
- Clean up all maps for the child

### session.deleted -- child

- Extraction child: `requeueClaimed(childID)`, else
  `requeueAccepted(parentID)` (never processed)
- Task-kind child: `requeueClaimed(childID)` only -- task children are
  deleted ROUTINELY, so a claim-less task child's deletion must not requeue
  the whole accepted set (it would yank an in-flight extractor's payload
  back to pending for duplicate extraction)
- Clean up all maps for the child

### session.deleted -- parent

- `completeAccepted(id)` -- a deleted parent takes its accepted entries with it
- Clear `extracting` for the parent
- Clear `pendingWrapUp` for the parent

### session.compacted

- Clear the `compacting` flag so chat.message nudges resume
- See [compaction-recovery.md](compaction-recovery.md)

### Stranded-session self-heal sweep

Why it exists: opencode v2 records a directory on every session row, and
opening a session whose directory is gone (a merged + deleted worktree) boots
a dead path and shows the "session location unavailable" recovery dialog.
Sessions get stranded there in two ways: extraction children leaked by hosts
older than v2.0.22 (whose session domain had no `remove`, so cleanup was a
silent no-op) and children whose idle event died with a daemon restart. The
sweep runs at setup and on an interval (`THATCH_STRAND_SWEEP_MS`), and the
rehydrate pass finalizes journaled extraction children through the host
before pruning their rows, so both the corpse population and the leak paths
are covered.

What it does, decided by `planStrandActions` (pure, unit-tested):

- Sessions in a live directory are never touched, whatever the row looks like
- Machinery (`thatch-extraction` title) in a dead directory: delete via the
  host's session delete
- Real top-level sessions in a dead directory: MOVE to the project's
  canonical checkout (`project.worktree` in opencode.db) -- the same outcome
  as the manual recovery dialog, minus the picking; history is preserved and
  user sessions are never deleted
- Host-created task children (parentId set): always skipped -- they are
  opencode's own records of subagent work and deleting them would break the
  parent transcript's subagent rendering
- Unresolvable canonical or no move endpoint: skipped and logged

The host supplies the enumeration (v1: `client.session.list`; v2: readonly
read of opencode.db, since the promise domain has no session list and the
sweep needs machine-wide rows) plus the move/delete endpoints; every leg
degrades silently. A summary toast fires only when something was healed. Set
`THATCH_STRAND_SWEEP=off` to disarm the sweep entirely (tests do, so it can
never act on a developer's real database through mocks).

### Extraction journal sweep

The `runtime_state` rows for the extraction pipeline (`buffer`, `accepted`)
can strand: their only deletion paths are the pipeline's own consume/complete
calls, which stop running when the owning session ends or its worktree is
deleted. The rehydrate pass prunes foreign-pid rows for the booting
directory, but another directory's rows wait for that directory's own
restart - and a deleted worktree never restarts (a 2026-10-14 census found
7.9MB stranded in ten dead worktrees). A sweep on the same boot + interval
timer as the strand sweep drops rows that are past the TTL
(`THATCH_RUNTIME_STATE_TTL_MS`, default 7 days - a live session rewrites its
row on every tool call, so a week of silence means nobody is coming back) or
whose directory no longer exists. It touches only thatch.db, so
`THATCH_STRAND_SWEEP=off` does not cover it, and the `-c`/`-s` startup
resume's inherited rows are always kept - the rehydrate pass deliberately
kept those, and the sweep must not contradict it. Three companion bounds
keep rows small in the first place: journaled tool outputs and top-level
string args are truncated to `INTERACTION_OUTPUT_MAX` (2000 chars; the
extractor payload reads only 500 chars of output and 120 of args), a deleted
session's pending buffer row is dropped with the session instead of
stranding until the next restart, and live sessions re-journal their
in-memory state on the next tool call, so a swept-but-alive row heals
itself.

### Internal state maps

- **childToParent**: `Map<childID, parentID>` -- maps child sessions to their parents
- **parentSnapshots**: `Map<childID, Interaction[]>` -- snapshot of parent's buffer at child creation time (journal recovery only; live delivery is claim-based)
- **childMetrics**: `Map<childID, {new, updated, deleted}>` -- extraction metrics per child
- **extracting**: `Set<parentID>` -- parent IDs with an active direct-extraction child (gates re-triggering)
- **extractionChildren**: `Set<childID>` -- distinguishes extraction children from task-dispatched sub-agents
- **compacting**: `Set<sessionID>` -- sessions currently being compacted (suppresses nudges)
- **pendingWrapUp**: `Map<sessionID, {kind, greenlit?}>` -- wrap-up commands awaiting their greenlight; armed by `command.execute.before` (a re-arm overwrites and resets `greenlit`), greenlit by the kind's zero-arg tool (`thatch_compact` / `thatch_exit`) and fired on the next idle, cleared on session deletion

## Interactions with other features

- Extraction pipeline ([extraction.md](extraction.md)): direct extraction is triggered by `session.status idle`; child lifecycle managed here
- Nudge pipeline ([nudge-pipeline.md](nudge-pipeline.md)): `compacting` set suppresses all nudges; task-dispatched sub-agents (in `childToParent`, not in `extractionChildren`) suppress all tiers
- Hygiene ([hygiene.md](hygiene.md)): hygiene report runs at `session.created` for top-level sessions
- Compaction recovery ([compaction-recovery.md](compaction-recovery.md)): `session.compacted` event clears the compacting flag
- Memory store ([memory-store.md](memory-store.md)): child sessions write memories via `memory_remember`, which completes their claimed delivery via `tool.execute.after`

## Source files

- `src/runtime.ts` -- event handler (all session events), `triggerExtraction`, `cleanupChild`, internal state maps
- `src/opencode/v1.ts`, `src/opencode/v2.ts` -- host adapters wiring the runtime into each opencode plugin API

## Key invariants

- Child sessions don't get the session-start reminder (early return in `session.created` with parentID).
- Delivery is claim-based: the payload fetch records what the fetcher received; only the fetcher's completion consumes it. A no-claim completion is a no-op, never a whole-set drop.
- Extraction children are deleted after going idle; task-dispatched sub-agents are NOT deleted (task tool reads output).
- Child errors requeue what the child held (never processed). Child deletion also requeues.
- Parent deletion completes accepted entries (takes them with it).
