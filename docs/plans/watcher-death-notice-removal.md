# Watcher death notices: care-based routing

A watcher-death notice is delivered only to parties that CARE about it: the owning session (while live), the coordinator of a dead subordinate (if linkable), and the user via banner. Never an arbitrary same-project peer. Ruling (Jeff, 2026-10-27, after the observed misroute - grep-goblin-00004 received modo-the-compost-king-00022's death notice): "a notice about the death of a watcher should only be delivered to sessions that *care* about it" - and the coordinator must not hallucinate intent beyond that (the earlier "remove all cross-session delivery" reading was too strong; this is the corrected intent).

## What exists today (verified in src/runtime.ts at 35bf9a7)

1. **Push at death time** - `deliverWatcherDeathNotices` (:424): a session death writes a `watcher_death` row (:544, only when `death.targets.length > 0`) and pushes the notice to the FIRST live same-project peer that passes `canPromptSession` (:441-447), deleting the row on success. The observed misroute: the "first peer" is arbitrary within the project.
2. **Pickup on prompt** - `surfaceWatcherDeaths` (:1088): each prompt takes pending `watcher_death` rows matching daemon directory + project, injects as a synthetic part, deletes the row.
3. **Dormant scan** - `scanDormantWatchers` (:1111): a resuming session re-arms its OWN rows (correct, keep) and earns death notices for OTHER still-dead same-directory sessions' rows (the same arbitrary-recipient problem).
4. The notice TEXT is `watcherDeathNotice` (src/prompts.ts:1183-1250).

## The care set

| Party | Cares because | Channel |
|-------|---------------|---------|
| The owning session | its watchers | direct (only while live - a dead owner is unreachable by definition) |
| A dead subordinate's coordinator | it dispatched the watched work; it may re-dispatch | prompt pickup on the coordinator's own next message (durable row), plus one push attempt at death time |
| The user | it is their watch; re-arm or not is their call | banner via the notify pipeline (short, source-labeled per the notification wording rule) |
| Anyone else | nothing | nothing - the row is never offered to arbitrary peers |

## Change

1. **The coordinator link already exists at spawn** - no stamping work: `thatch_session_tab`'s `session.create` writes `metadata: { thatch: { coordinatedBy, coordinatorSessionID, worktree? } }` (src/tool-defs.ts:2814, fed from the host context's sessionID at :2808; the v2 adapter passes it through at src/opencode/v2.ts:763-771). The change READS the existing `thatch.coordinatorSessionID`.
2. **Carry the link on the death row.** The death-row write is currently synchronous inside the `onSessionDeath` registry callback (watchers.ts:340); the metadata read is async (`caps.sessionGet` returns the full v2 SessionInfo including `metadata` - VERIFIED in the pinned types: `SessionInfo.metadata?: SessionMetadata` at client types.d.ts:2783; the narrow `{ title?: string }` type at capabilities.ts:77 widens to expose it). So the sync callback schedules an ASYNC enrichment: read the dead session's metadata, write the row with `coordinatorSessionID` (the field name matches the metadata key's semantic), then run the delivery attempts. The async continuation carries the established `disposed` guard (runtime.ts:474 pattern). Fallback when the metadata is absent (old subordinates, non-subordinate sessions): no coordinator field - banner only. VERIFY-with-pin (narrowed): `session.get` succeeding on a closed-tab session at death time (the session row persists through the 404-class death per watchers.ts:356-359; the type presence is settled, the live read is the pin).
3. **Replace the arbitrary-peer push** (the `deliverWatcherDeathNotices` loop) with: one banner (notify pipeline, source-labeled "watcher died: <target>") +, when the row carries `coordinatorSessionID`, one prompt push to that session (gated by `canPromptSession`; a CLOSED gate is not a throw - gate-false and throw both LEAVE a stamped row for the pickup path). Row lifecycle: a SUCCESSFUL coordinator push deletes the row (otherwise the pickup would re-inject the identical notice on the coordinator's next message - double delivery); an UNSTAMPED row is always deleted after the banner attempt (post-change nothing can ever pick it up - the pickup is coordinator-ID-scoped - so keeping one is dead weight; rehydration deletes unstamped rows too). The `!deadProject` early return must not skip the banner - unplaceable deaths still banner.
4. **Narrow the prompt pickup** (`surfaceWatcherDeaths`): a row is surfaced ONLY to the session whose ID matches `row.coordinatorSessionID`. The directory + project filters are DROPPED as gating conditions: the subordinate's own per-directory runtime instance journals the row under the WORKTREE's directory (runtime.ts:544 uses that instance's directory closure), so the coordinator's main-directory instance would never match a directory filter - and worktree spawns are the tool's preferred flow. Every surviving row is coordinator-stamped, so the field match alone authorizes pickup (the delete-after-delivery contract stays).
5. **Dormant scan**: the own-row re-arm path stays; the other-session death-notice production (:1128-1136, :1158-1161) is REPLACED with a user banner (source-labeled) - the mechanism correction: those notices derive from `watchers` DEFINITION rows, not death rows, and the two are near-mutually exclusive (a death row exists only when the registry observed the death and cancelled + emptied the journal; a dormant watchers row means NO runtime observed the death - so there is no death row for the pickup to route). Restart-killed sessions' watches therefore banner the user (who cares) instead of prompting a peer (who was the misroute). `pidAlive` STAYS (it gates the banner - a v1 sibling's live pid must not banner). Deletion collateral (all trip `noUnusedLocals`): the `notifiedWatcherDeaths` set (:1071, :1133, :1138, :1155) and the `deadSessions` map (:1117, :1134, :1138, :1159). The stale-watchers aging-out (:1120-1122) survives.
6. **Rehydration, two sites, DISCRIMINATED** (the naive unconditional delete would destroy exactly the rows the design must keep - a subordinate dying while the coordinator is busy, then a routine v2 file-change reload, would silently drop the notice): the :888 foreign-pid keep condition becomes `watcher_pending || (watcher_death && coordinatorSessionID && !expired)` (unstamped or expired death rows fall through to the generic delete); the :1007 same-pid handler keeps stamped unexpired rows and deletes unstamped ones. SURVIVING stamped rows are picked up by the coordinator's next prompt regardless of which instance wrote them (step 4's ID-only match). Age-out sweep: a GLOBAL, age-only idle pass for stamped death rows (`row.at` vs the TTL) - NOT the extraction journal sweep, whose dead-directory prune rule (:1358-1364) would eat a merged-worktree row within one interval (~6h), before the busy coordinator's next prompt; exempt death rows from the dead-directory rule explicitly. TTL: reuse the env-tunable `THATCH_RUNTIME_STATE_TTL_MS` (7-day default, env-knobs.ts:110-114) over a hard-coded constant.
7. **`watcherDeathNotice`** (src/prompts.ts:1183-1250) stays (the coordinator push + pickup render it); its docblock updates; the runtime.ts:39 import stays.

## Tests

- tests/watchers-nudge.test.ts (:2, :49-65): re-target - notice text renders for the coordinator pickup; no arbitrary-peer claim survives.
- tests/opencode-v2-adapter-pump.test.ts (:165-176): the subordinate-close test flips to asserting NO peer delivery + the coordinator row carrying the link.
- tests/opencode-v2-adapter-caps.test.ts (:236-307): the death-row placement pins extend to the coordinator field.
- tests/state-persistence.test.ts (:763-789 dormant-notice tests): the other-session notice production is gone - the tests re-target to the banner; rehydration pins cover the discriminated cleanup at both sites (unstamped deleted, stamped surviving).
- tests/plugin-wrapup.test.ts (:284) + tests/session-tab-shared.test.ts (:110) + tests/plugin-extraction-claims.test.ts (:88-91) + tests/opencode-v2-adapter-tabs.test.ts (:259): stale comment touch-ups.
- tests/qa/auto/uc-103 (:256-258) + uc-118 (docstring "the death is announced"; assertions stay green): wording touch-ups.
- New pins: the stamp lands at spawn (metadata carries the caller); death-row delivery = banner + coordinator-push only; pickup is coordinator-scoped; a row with no coordinator is banner-only and deleted after attempt.
- artifacts/skills/thatch-coordination.md (:36-40): the supervision loop's death-notice guidance updates (the coordinator now receives death rows for its subordinates' watchers directly - same advice, new mechanism).

## Docs

- docs/dev/features/watchers.md (:162-164): the death-notice section becomes the care-based routing (who hears it and why; the arbitrary-peer delivery is gone).
- docs/user/watchers.md (:161-175): user voice - you get a banner; a dead subordinate's coordinator gets the notice; nothing lands in unrelated sessions.
- docs/dev/features/session-lifecycle.md (:87), docs/dev/features/opencode-plugin.md (:78, :80 - the "tab close" row's announce-to-live-peers wording, :82), docs/dev/README.md (:134): death-notice wording updates.
- docs/plans/generalized-session-heartbeat.md: a cross-ref note in this changeset - its future pickup inherits the care-based routing.
- Memory cleanup after landing: the death-notice surfacing memories record the routing ruling.

## Risks

- **The `session.get`-at-death premise** (closed-tab sessions' metadata readable at death time): marked VERIFY-with-pin; the row persists through the 404-class death, so the read should succeed - if it does not, the death row carries no coordinator (banner-only) and the coordinator learns of the loss by other means. Graceful by construction.
- **Unpicked-row accumulation**: bounded by the 7-day age-out (the arbitrary-peer drain's replacement).
- **Resumed owners**: a closed-then-reopened session (same session ID) no longer hears its own death notice through the project match - the banner covers the user; documented.
- **Future heartbeat plan**: docs/plans/generalized-session-heartbeat.md describes a pickup consuming `watcher_death` rows - when that feature lands it inherits the care-based routing (noted there for the implementer).
- Landing: broadcast (src-touching merge, machine-wide warning), squash + tree gate, CI on the SHA. NO release.

## Verification

1. `mise run check` + `mise run qa-auto` green.
2. Grep gate: zero `watcher_death` reads outside the coordinator-scoped pickup + the discriminated rehydration cleanup; zero arbitrary-peer delivery paths.
3. Manual: exit a session with an active watcher -> banner arrives, NO notice in unrelated sessions; if it was a subordinate, its coordinator picks up the row on its next message.

## Refinement mode note

Quick mode (one fresh reviewer): the ruling fixes the semantics; the change is re-routing within an audited subsystem; the round-1 reviewer already inventoried every consumer.
