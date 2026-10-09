# Plan: watcher death detection for closed v2 tabs

Status: v3.1 - empirical premise VERIFIED live (2026-10-07: prompt_async
to a closed v2 tab returns 404; no silent success; the session row
persists, so the pre-cancel re-check keys on the throw class). The
build's gate is open. Two refinement rounds converged (round 2: BUILD,
no blockers).

## Problem

v2 tab close fires no `session.deleted`, so the closed tab's entry in
the runtime's `sessionStatus` map (src/runtime.ts:217-222, keys "leave
only in session.deleted") never leaves, the chat poller keeps hosting
and heartbeat-ing the dead tab's row (src/runtime.ts:363-368,
src/chat.ts:879-883), and its watchers poll until the 8h TTL with
deliveries queuing forever. The session.deleted handler itself names
the failure mode: "a leaked status key would keep heartbeat-ing a dead
session as permanently fresh" (src/runtime.ts:1891).

## Rejected: heartbeat-staleness death detection (the original plan)

The original design gated the heartbeat stamp on `fetchStatuses`
presence so a closed tab would age out. Round 1 proved the premise
inverted: the live status map carries only ACTIVE (mid-turn) sessions -
the host deletes idle entries (thatch's own wake-gate contract,
src/chat.ts:366-368; host source session/status.ts:42-46) - so absence
means "idle OR closed". Gating stamps on presence would mark every
idle-open tab stale in 60s (regressing e486148, whose grace exists
precisely because idle-open tabs emit nothing) and death-cancel the
watchers of every idle session. And on v2 - the only host with the bug
- `fetchStatuses` is a permanent `{}` stub (src/opencode/v2.ts:524;
"session.status exists in v2's schema but nothing publishes it",
v2.ts:417), so the mechanism does not exist where the bug lives.
Chat-off sessions (chatPoller.start gated on chatOn,
src/runtime.ts:407-409) get no stamps at all - a third false-death
path.

Conclusion: the heartbeat cannot carry tab-death detection on v2. The
heartbeat keeps its current role (roster liveness for chat, unconditional
stamps for hosted sessions); death detection needs a different clock.

## New design: delivery-persistence death detection

The signal that DOES distinguish a closed v2 tab from a live one, with
no host API: **what happens to a pending watcher event.**

- A live v2 session with queued events consumes them: the delivery gate
  opens (on v2 the stub map reads as idle) and `promptAsync` succeeds -
  there is no busy-rejection on the v2 prompt path. Queues drain.
- A closed v2 session: every `deliver()` attempt throws (the session no
  longer exists server-side) and the queue retries forever
  (src/watchers.ts:1296-1298 - failed delivery stays pending).

So: **death = a session's pending watcher queue has been non-empty for
longer than the threshold AND recent delivery attempts have THROWN**
(not been skipped - a skipped attempt is a busy/compacting session and
must never count). The heartbeat is untouched; this is one extra clock
on one queue, per session.

- Threshold: 2 hours default (env `THATCH_WATCH_DEATH_MINUTES`). Far
  above any legitimate busy turn; far below the 8h TTL, which remains
  the hard backstop. The failure counter counts CONSECUTIVE thrown
  deliveries per session (side map keyed by session id - WatcherEvent
  carries no timestamp); a SKIPPED attempt (busy/compacting) or a
  success RESETS it - skips are never death evidence.
- Pre-cancel re-check (round 2): when the threshold fires, re-verify
  the session via `caps.sessionGet` before cancelling - only a
  not-found-class result confirms death. A wedged server or 500-loop
  throws exactly like a dead session does, and without the re-check a
  two-hour API outage would mass-cancel every hosted watcher.
- v1 is out of scope: v1 fires session.deleted on tab close (the
  known-gaps table), so v1 tabs already clean up; crashed v1 daemons
  are covered by the dormant-row machinery.
- On death: cancel the session's watchers (watchers.cancelSession -
  also drops the pending queue, src/watchers.ts:1195-1201), emit a
  death notice via the existing promptAsync path to other live
  same-project sessions (`watcherDeathNotice`, src/prompts.ts:1051;
  dedup per dead session like notifiedWatcherDeaths,
  src/runtime.ts:801-806), and persist a `watcher_death` runtime_state
  row (generic runtimeStatePut/All/Delete - no new db helpers).
- Reader for the persisted row (round 2): the rehydration switch
  (src/runtime.ts:609-713) must learn the `watcher_death` kind
  (foreign-pid rows KEPT like dormant watcher rows, not deleted) and
  the dormant-scan path (src/runtime.ts:779-825) surfaces pending
  death rows to the scanning session, deduping against
  `notifiedWatcherDeaths`, deleting the row on surfacing. Without this
  the persistence half is write-only: unknown foreign-pid kinds are
  deleted on restart (:615-641) and `dormantScanned` runs once per
  session per process.
- Scope guard: only sessions this process HOSTS via the
  `hostedSessionIds` helper (src/runtime.ts:363-370) are eligible -
  sibling v1 processes and MCP sessions are never touched.
- Residual case (round 2, documented): a tab closed MID-TURN whose
  host never emits a terminal execution event keeps its mapped status
  `busy` forever - deliveries skip forever, death never fires, TTL
  covers it. Accepted; the notice will not fire for that shape.
- The roster zombie (a closed tab's row shows Active for days; the
  7-day auto-reaper bounds auto rows) is NOT fixed by this plan - no v2-
  reachable signal distinguishes it. Documented as a known limitation;
  the reviewer confirmed no last_seen consumer treats staleness as a
  trigger today, so the honest heartbeat stays unconditional.
- Death notice payload (session-tab coordination, wanda-warpdrive-00009
  2026-10-07): the notice carries the dead session's CHAT NAME and
  session id, not just the watch targets, so a coordinator session
  running the thatch-coordination skill can mark its task-list entry
  failed and respawn keyed by chat name, no SDK lookup.

### Confirmed-close fast path (integration with session-tab)

The session-tab tool (docs/dev/features/session-tabs.md; merged to main
as 5abb381) emits `rpc.thatch-tabs.tab-closed {sessionID,
chatName?}` from its TUI plugin when a close is TOOL-initiated (shared
module session-tab-shared.ts; user-initiated closes stay out of scope
there - the delivery-persistence heuristic covers those). When the
event lands for a session with watchers, treat it as a CONFIRMED
close: skip the 2h heuristic entirely and run the death path
immediately. The rpc definition is imported from session-tab-shared
(same package). Fallback layering: confirmed close (instant) >
delivery-persistence heuristic (2h) > TTL (8h).

## Empirical premise: VERIFIED (2026-10-07, live probe via the session-tab smoke flow)

Jeff closed a real v2 tab (session chatting as rosie-unit-one-00007,
session ses_ee7ec0baeffeziwE83AT2mgLxI) with a command watch armed
before the close. Probe results against the serve daemon's /api surface
(Basic auth: username `opencode`, password from
~/.config/opencode/service.json; unprefixed /session/* paths are the
TUI SPA fallback - 200 HTML for anything, do not trust them):

- POST /api/session/{id}/prompt_async -> HTTP **404** (clean, no body):
  the delivery throw is real and 404-class.
- Message count in the closed session before/after: 0 / 0 - **no silent
  success, no headless turn**.
- GET /api/session/{id} -> 200 with the full record: the session ROW
  persists server-side after tab close, so existence checks cannot
  confirm death.

Consequence for design point 2's pre-cancel re-check: key on the throw
CLASS (404 = route/session gone) not on sessionGet existence - a
sessionGet 200 is expected even for dead tabs. Wedged-server 5xx loops
still do not count as death; only 404-class delivery throws do.

Location-scoping nuance (wanda-warpdrive-00009, post-probe): the v2
prompt route is session-location-middleware'd, so the probe's
cross-location 404 may encode location scoping rather than closed-ness
per se. The death signal keys on the HOSTING poller's own deliveries
throwing - same-location throws are the evidence that counts, and the
session-tab `tab-closed` event papers over the ambiguous cases. The
pre-cancel re-check and the threshold both run against the hosting
instance's observed throw class.

## Surfaces touched

### Pending-event durability (from the 2026-10-07 reload-loss incident)

A reload between DETECTION and DELIVERY silently eats notifications:
pending events live only in the in-memory `#pending` queue, and one-shot
watchers delete their journal row at detection time ("ends at first
detection, not first delivery") - so the durability layer is gone
exactly when undelivered events exist (observed: watch_qn449jio's CI
notification lost in the 09b805f reload window). Fix folded into this
build: journal PENDING EVENTS per session (alongside the watcher
definitions), delete them on successful delivery - which the death
detection needs anyway for its pending-age signal to survive reloads.
(Found by robot-devil-00012's code-verified analysis; my own watcher
was not one-shot, so its exact deletion path stays unproven until a
THATCH_DEBUG=1 repro.)

## Surfaces touched

- `src/watchers.ts` - per-session delivery-failure tracking (consecutive
  throws + oldest-pending age) and a death-scan hook the poller calls.
- `src/runtime.ts` - wire the death callback: notice delivery to live
  same-project sessions, the `watcher_death` runtime_state row, dedup.
- `src/db.ts` - runtime_state row helpers for the death record.
- `tests/watchers.test.ts` - death detection (throwing deliver + old
  pending vs skipped-deliver + old pending), threshold env, MCP-owner
  exclusion.
- `tests/qa/auto/uc-118-watcher-death-detection.ts` (new,
  barrel-imported).
- Docs: `docs/user/watchers.md` (death notices), `docs/dev/features/
  watchers.md` (detection subsection), `docs/dev/features/
  opencode-plugin.md` known-gaps row (bounded by death detection),
  `docs/user/cli.md` + `docs/dev/features/cli.md` (new env var).

## Acceptance criteria

1. A closed v2 tab's watchers are cancelled within the threshold once
   deliveries have been failing; a live same-project session hears the
   death notice.
2. A busy or idle LIVE session never triggers death (skipped delivery
   attempts never count; successful delivery drains the queue).
3. A transient delivery failure (< threshold) cancels nothing.
4. MCP-owner and non-hosted sessions are never touched.
5. `mise run check` + `mise run qa-auto` green.

## Review rounds

- Round 1 (fresh reviewer): DO-NOT-BUILD on the heartbeat mechanism -
  inverted premise (status absence means idle, not dead; v2 stub
  returns {}), chat-off and sleep false-death paths, dormantScanned
  once-per-session guard, incomplete death cleanup. The revision
  replaces the mechanism with delivery-persistence detection
  (v2-scoped) and drops the roster-zombie claim.
- Round 2 (fresh reviewer): BUILD conditional on the empirical probe;
  all premises verified (thrown deliveries stay pending at
  src/watchers.ts:1344-1349, live sessions drain at runtime.ts:1866-
  1874), with three required adjustments folded in: the death-row
  reader + rehydration handling, the pre-cancel existence re-check,
  and the known-gaps doc correction. Consensus to build - AFTER the
  probe.

