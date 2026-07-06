# Plan 003 — Memory Hygiene

## Synopsis

Prevents stale and fragmented memory from accumulating: a write-time
similarity warning, recall telemetry, a session-start hygiene heartbeat, and
cluster-level dedup presentation. Extends plan 002's invariant — the plugin
observes and nudges, the agent judges and writes — to store maintenance.

## Background

Before this, the only hygiene mechanism was the manual dedup loop
(`thatch_find_duplicates` → classifier skill → `thatch_dedup_mark_checked`),
which nothing ever triggered, caught only pairwise similarity, and had no
concept of staleness or usage. Memories that stopped being true, fragmented
topics below the pair threshold, and branch-scoped leftovers accumulated
unbounded.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Write-time collision **warns**, never blocks | The embedding is already computed at save time, so the store scan is nearly free. The save proceeds and the warning rides the tool response — the agent decides whether and how to reconcile. Blocking would add a special case to the remember contract and stall workflows on a heuristic. |
| `findSimilar` is separate from `recall` and records no telemetry | The collision check is the plugin looking, not the agent using; counting it as usage would make every write refresh its own neighbors. |
| Recall telemetry (`recall_count`, `last_recalled_at`) stamped inside `recall()` | Retrieval is the "used recently" signal. Stale = neither written nor recalled since the cutoff, so actively-used old memories never nag. |
| Heartbeat rides the session-start reminder | The reminder already fires once per session via `session.created`; hygiene counts piggyback with zero new machinery. Only non-zero signals are reported — a healthy store stays silent. |
| Staleness window hardcoded at 90 days | Zero-config posture. Revisit if real usage disagrees. |
| Orphaned-branch detection skips non-git worktrees | `listBranches` returning `[]` is "unknown", not "no branches"; treating it as empty would mark every scoped memory orphaned. |
| Branch cleanup is agent-driven, not automatic GC | Deleting user memories automatically violates plan 002's core invariant. The heartbeat names the orphaned branches; the agent (or user) decides. |
| Clusters are presentation-only | `findDuplicates` still returns pairs and verdicts stay pairwise (`dedup_pairs` unchanged) — connected components are computed in the tool layer for display, so no schema or verdict-model churn. |
| Column migration reintroduced | Existing databases predate the telemetry columns; `CREATE TABLE IF NOT EXISTS` alone can't add them. `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`, idempotent. |

## Architecture

```
write:    remember tool → passageEmbed → findSimilar(store, emb) ─┐
          db.remember(...) → "[saved] ..."                        │
          + "⚠ similar to: ..." warning when hits ≥ 0.85 ◄────────┘

read:     recall() → top-N → UPDATE recall_count+1, last_recalled_at

session:  session.created → hygieneReport(db, repo, worktree)
            • findDuplicates count (pending pairs)
            • staleEntryCount (90d, max(updated_at, last_recalled_at))
            • branchesInStore − listBranches(worktree) → orphan count
          → appended to sessionStartReminder as "[thatch hygiene] ..."

dedup:    findDuplicates pairs → union-find in tool layer → clusters
          cluster of 3+ → skill instructs consolidate-into-one
```

## Costs

- `hygieneReport` runs `findDuplicates` (O(n²) cosine) once per session
  start; ~100ms at a few thousand entries. Acceptable; revisit with an
  index/cache if stores grow past that.
- `recall()` now writes on read (one UPDATE per recall). WAL absorbs this.

## Dependencies

Unchanged.
