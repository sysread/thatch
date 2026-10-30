# Chat name reclaim on reopen

**Status: PROPOSED - explicitly unscheduled (parked 2026-10-30; refinement happens when scheduled).**

## Problem

`/thatch/exit` retires a session's chat name forever (row deleted, tombstone written, name never returns to the drawable pool). When the SAME session id is later reopened - Jeff's nak case: exit a session, discover a bug in its work, reopen it so it keeps full context and fixes itself - the restore clears the exit tombstone and auto-registration mints a NEW name. Cross-session continuity breaks: counterparties knew the session under the old name; the reopen arrives as a stranger.

Field case: the nak session was wenlock-00016 on Oct 29, Jeff `/thatch/exit`'d it, reopened it Oct 30 to fix a bug in its work, and it re-registered as osgar-00016 (same underlying session id `ses_e7701cf3`).

## Design

**Rule: an exit tombstone plus the same session id returning is provably the same session - reclaim the name.**

- On registration (either auto path or explicit `chat_register`), if a `chat_leave_tombstones` row exists for the SAME session_id with reason `exit`, the registration reclaims the tombstoned name instead of drawing a new one. The tombstone still clears (existing restore-rejoin behavior).
- `explicit` tombstones are NOT reclaimed (the chat_unregister tool is a deliberate goodbye; coming back is a genuine rejoin - new name, per the current design).
- This does NOT violate the never-reuse invariant: the name never returns to the POOL and is never REASSIGNED to a different session. Same-session reclaim is continuity, not reuse. The invariant's test suite needs its phrasing tightened, not its behavior changed.
- The `deleted` tombstone reason: reclaim applies there too (the session row coming back with the same id is the same session). `explicit` stays the only never-reclaim case.
- Deliberate echo of the dropped alternative: the restore-rejoin design (f141b04) considered name continuity and DROPPED claim-writes at unregister ("claims would pin names permanently"). This plan resurrects continuity by a narrower mechanism that needs no claims: the tombstone row itself carries the identity (VERIFY its columns at implementation - if it lacks the name, read the prior name from the chat message history or extend the tombstone schema; prefer the tombstone column).

## Open questions (resolve at implementation)

- Tombstone columns: does `chat_leave_tombstones` carry the name, or only session_id + reason? If only the id, the prior name comes from chat history (the session's own outgoing mail) or a schema extension.
- A fork-chain (Claude Code) whose ancestor was exit'd: the fork-migration mapping and the reclaim should compose, not fight - the derived-identity path checks tombstones already.
- Does the reclaim survive a project move (the session returns under a different project)? Leaning yes - the name is the continuity, the row's project updates as usual.

## Surfaces (expected)

- `src/chat.ts`: the reclaim check at both registration paths (prompt-register + idle auto-register), tombstone-clear integration.
- `src/db.ts`: tombstone read/write helpers if the name column is needed.
- Tests: reclaim pin (exit tombstone + same id -> same name), explicit-tombstone no-reclaim pin, never-reuse invariant phrasing update, the fork-chain composition case.
- Docs: docs/user/cross-session-chat.md + docs/dev/features/cross-session-chat.md (the continuity semantics: reopen-after-exit keeps the name; unregister-then-register does not).

## Refinement

One quick fresh-reviewer round when this gets scheduled (the design is one mechanism; the open questions above gate the implementation, not the design).
