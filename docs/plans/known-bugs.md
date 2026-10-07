# Known bugs and open gaps

Snapshot of verified, unfixed bugs and gaps, compiled 2026-10-07 from a
memory audit — every entry below was re-verified against the current tree
on that date. Fixed items are intentionally absent; git history and the
feature docs carry them. Fix any entry with the standard flow: worktree,
`mise run check` + `mise run qa-auto` green, merge on Jeff's green light.

## Bugs and gaps

| Area | Problem | Evidence | Impact |
|---|---|---|---|
| Chat on Cursor | Any Cursor conversation can claim another session's identity via the `as` tool argument and read its mail. Claude Code closed this hole with the host-pid anchor (`recordHostPid`); Cursor's shared extension host makes ppid ambiguous, so `as` stays the identity source there. | comment at `src/chat.ts` (recordHostPid) | Medium — silent cross-session mail access on MCP hosts. Design decision pending Jeff |
| Watchers on v2 tab close | Closing a v2 tab fires no `session.deleted`, so the closed tab's watchers keep polling until their TTL while their deliveries queue behind the idle gate, never delivered. | known-gaps table in [opencode-plugin.md](../dev/features/opencode-plugin.md) | Low — wasted polls, phantom pending state; restart dormancy covers the daemon-restart case only |
| MCP stdio server teardown | `runMcpServer` has no dispose, shutdown, or signal handling — cleanup relies entirely on process death, unlike the plugin path (which runs watchers dispose + db close). | `grep dispose\|shutdown\|process.on\|SIGINT src/mcp.ts` is empty | Low — embedding sessions and the DB never close explicitly |
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
