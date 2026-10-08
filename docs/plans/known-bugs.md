# Known bugs and open gaps

Snapshot of verified, unfixed bugs and gaps, compiled 2026-10-07 from a
memory audit — every entry below was re-verified against the current tree
on that date. Fixed items are intentionally absent; git history and the
feature docs carry them. Fix any entry with the standard flow: worktree,
`mise run check` + `mise run qa-auto` green, merge on Jeff's green light.

## Bugs and gaps

| Area | Problem | Evidence | Impact |
|---|---|---|---|

## Upstream blockers

| Problem | Where |
|---|---|
| opencode v2 TUI publish gap | upstream opencode issue 50984 |

## Deliberate non-bugs (do not "fix")

- Pushing to main bypasses branch protection with a remote warning. Jeff's
  declared intent (Oct 2026): the PR requirement gates external
  contributors, not him. CI after push is the real gate.
- Manually registered chat sessions are never reaped on stale `last_seen`;
  only auto-registered rows sweep. Manual sessions are opt-in and pinned.
- `watch_list`/`watch_cancel` blindness after a plugin reload was a real
  bug once — fixed by the journal reconcile on every watch-tool call
  (commit 6f9ddf1); the journal-on-state-change follow-up (9286dd5) closed
  the replay vector the same path exposed.
