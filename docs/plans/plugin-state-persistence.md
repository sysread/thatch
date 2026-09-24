# Plan: plugin state persistence across restarts and reloads

Status: IMPLEMENTED on branch `opencode-v2-migration` (PR sysread/thatch#16);
graduates at merge with the rest of the v2 plan. Implementation notes below
are the record; the dev feature doc's dispose row carries the user-facing
summary.

## Problem

v2 hosts the plugin per location (`Location.Ref = {directory, workspaceID}`),
and rebuilds that graph on plugin file change (`PluginSupervisor` + the
module file watcher) or config reload. The rebuilt plugin starts from empty
memory. A v1 process restart has the same effect. State the runtime keeps in
memory is therefore lost across both events:

- the extraction buffer and the direct-extraction bookkeeping
  (`childToParent`, `parentSnapshots`, `extracting`, `extractionChildren`,
  `childMetrics`) - an in-flight extraction child is orphaned, the parent's
  buffer never drains, and the parent re-triggers a duplicate extraction on
  its next idle;
- watcher registrations - watches vanish silently;
- `pendingWrapUp` - an armed wrap-up never fires;
- `resumedSession` - a scalar ("the" resumed chat session), wrong when one
  instance serves multiple sessions (shared-server tabs in one directory).

## Design

### 1. Runtime state journal (SQLite, instance-scoped)

New table in ThatchDB:

```sql
CREATE TABLE IF NOT EXISTS runtime_state (
  kind       TEXT NOT NULL,   -- 'buffer' | 'accepted' | 'child' | 'wrapup' | 'watchers'
  session_id TEXT NOT NULL,
  directory  TEXT NOT NULL,   -- the writing instance's location - the scoping key
  value      TEXT NOT NULL,   -- JSON
  pid        INTEGER NOT NULL,-- writer's process id
  created_at TEXT NOT NULL DEFAULT (strftime('%s','now'))
);
```

Write-through at the mutation points (buffer push/consume/accept/complete/
requeue, child create/adopt/clear, wrap-up arm/resolve, watcher membership).
The pid AND directory columns together are the partition key: one v2 serve
hosts one plugin instance PER LOCATION in one process, so pid alone cannot
scope rehydration (instance B would hydrate instance A's watchers and poll
them N-fold).

### 2. Rehydrate-and-prune on setup

`createRuntime` partitions the journal by (pid, directory):

- **Same pid + same directory (reload)**: restore everything - buffers,
  child bookkeeping, pendingWrapUp - and re-arm the watchers (the registry
  rebuilds its pollers from the persisted definitions). The v2 adapter also
  re-seeds its event-forwarding child set from the runtime's rehydrated
  child map, so below-root launches keep receiving child events.
- **Same pid + other directory**: a live sibling instance's rows - untouched
  (never hydrated, never pruned).
- **Foreign pid (restart)**: sessions die with their harness. Only a
  startup-resumed session (`-s`/`-c`) in this directory inherits
  recovery-safe state: the buffer rehydrates, and a dead extraction child's
  snapshot is requeued as plain pending entries (extraction stays available;
  `extracting` is NOT restored - the child's events died with the process
  and a live `extracting` entry would suppress both extraction paths
  forever). Armed wrap-ups and child bookkeeping are dropped across a
  restart: an inherited wrap-up could auto-fire compact/exit on the resumed
  session's first idle.

Restored sessions get a synthetic, noReply re-attach notice so they know
the plugin is back (the reload happened outside their event stream).

This replaces "silent loss" with "reload = resume, restart = crash recovery
for the resumed session".

### 3. resumedSession scalar -> Set

The startup paths (`-s`, `-c`, and `continuesLastSessionId`) append to a
Set; the ChatPoller's `hostedSessions` reads all of them.

### 4. Shared embedding model, refcounted

`BgeEmbeddingModel` instances are cached per db path at module level with a
refcount. `createRuntime` acquires; `dispose()` releases and only calls
`model.dispose()` at zero (its ONNX sessions must still be explicitly
disposed before process exit - Bun's NAPI finalizers panic otherwise, see
src/embeddings.ts). This removes one model copy per location instance in a
shared v2 server. The MCP server keeps its own (separate process, separate
sideband).

### 5. v1 impact

Write-through and setup pruning add a few local SQLite reads/writes per
lifecycle event - no behavior change. Restore-on-startup is a v1 improvement
in one case: `-c` after a crash inherits the dead process's buffer. The
refcounted model is behaviorally identical for v1's single instance.

## Out of scope (recorded, not fixed here)

- Double-hosting when two instances share a `directory` with different
  `workspaceID`s (the runtime's filter ignores workspaceID) - unverified
  whether the TUI produces that shape; revisit if seen.
- Sharing the warm model ACROSS processes (the sideband already does this
  for MCP hook processes; extending it to plugin instances is a separate
  piece of work).
