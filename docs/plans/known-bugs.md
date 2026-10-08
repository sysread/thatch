# Known bugs and open gaps

Snapshot of verified, unfixed bugs and gaps, compiled 2026-10-07 from a
memory audit — every entry below was re-verified against the current tree
on that date. Fixed items are intentionally absent; git history and the
feature docs carry them. Fix any entry with the standard flow: worktree,
`mise run check` + `mise run qa-auto` green, merge on Jeff's green light.

## Bugs and gaps

| Area | Problem | Evidence | Impact |
|---|---|---|---|
| Watcher lost across plugin reload (hypothesis-grade) | A watcher and its runtime_state journal row vanished across a v2 plugin hot-reload (observed 2026-10-07: watch_qn449jio gone after the 09b805f reload; sibling sessions' rows survived; its CI notification was silently lost - CI was green, verified by hand). robot-devil-00012 verified its own diff touches zero watcher-lifecycle code and that the only 'watchers'-row deleter is the registry journaling an EMPTY set. Strongest loss vector (its finding): pending events live only in the in-memory #pending queue and one-shot watchers delete their journal row at DETECTION time - a reload between detection and delivery loses the notification with no trace. **Fix in flight**: pending-event durability shipped (20937f2 - watcher_pending journal kind, delete-after-delivery); the exact empty-emit for the original loss is still unconfirmed - repro via the qa/opencode-sandbox dockerized daemon with THATCH_DEBUG=1. | runtime_state (watchers row absent), ~/.config/thatch/debug.log stale | Medium — silent notification loss; forensics blind without debug logging |
| MCP server after upgrade | The tool list is compiled from `TOOL_DEFS` at server start and never reloads. After upgrading thatch, a running Claude Code session's hooks fire extraction nudges referencing tools the old server does not expose, escalating every prompt until the session restarts. | src/mcp.ts startup sequence; GitHub issue #6 (closed with the restart workaround) | Medium annoyance — Claude Code / Cursor only |

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
