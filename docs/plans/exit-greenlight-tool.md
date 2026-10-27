# Exit greenlight tool

Replace the `/thatch/exit` token-watching greenlight with a tool call. Exit-only; `/thatch/compact` keeps the token protocol until this ships and works.

## Root cause (observed 2026-10-26, thog session ses_e85f252a2ffeUit14ARLGqVHZl)

The exit template promises "the session will only close when the token is present" (whenever that final response happens), but the runtime consumes the wrap-up arm on the FIRST idle after the command (`src/runtime.ts:2272`, unconditional `pendingWrapUp.delete`), then checks the last assistant message for the token. The exit checklist makes a mid-exit wait the natural path: step 1 says flush persistence, and the extraction flow dispatches the fact-extractor as a background subagent. The model correctly withheld the token while the extractor ran, went idle with a "Wrap-up is in progress" response, the arm died at that idle (token absent -> "blocked" toast -> extraction fall-through), and the final `THATCH_EXIT_READY` on the post-completion turn landed on nothing. The user closed the tab manually.

Provenance note: the session record was verified 2026-10-27 against the `session_v2` and `session_message` tables of `~/.local/share/opencode/opencode.db` (not the v1-style `session`/`part` tables).

Design principle this violates (codified behavior `1a068b35` in the behavior store): model-executed protocol steps timed against hook- or event-driven state transitions are a bug factory. The token check is exactly that: a model-written text marker whose meaning depends on WHICH idle reads it.

Archaeology (git-verified): the consume-on-first-idle semantics date to the machinery's introduction (`c9073e9`, 2026-09-14) and encode a one-idle handshake assumption - one response, one idle, token or blockers. No commit, doc, or comment records it as an anti-loop or stale-arm guard, and no recorded alternative (including a tool) was ever considered or rejected. Per-kind divergence of resolution semantics is therefore new ground but has no recorded objection; per-kind divergence of host actions, toasts, and unregister already exists.

## Goal

The model signals "done and safe to close" with a zero-argument tool call instead of a text token. The tool resolves the arm the command created; the close fires on the session's next idle via the existing close executor, in its existing order.

## Non-goals

- Converting `/thatch/compact` (deliberate follow-up after this is verified).
- Coordinator-created exit arms (a coordinator dismissing a subordinate keeps using `thatch_session_tab_close`).
- Any change to v1/v2 host-action mechanics (`app.exit` vs the `exit-tab-closed` rpc event): `caps.exitHost` is called unchanged.
- Fixing the inherited v2 no-bridge strand (see Risks).
- Mechanical stale-arm enforcement (runtime disarm rules, TTL): rescind semantics live in the prompt channel instead (see Rescind semantics).

## Design

### Arm lifecycle (the handshake)

1. `/thatch/exit` executes -> `command.execute.before` arms `pendingWrapUp { kind: "exit" }` and journals it (`src/runtime.ts:1849-1862`). Unchanged.
2. The model works the checklist across any number of turns. **Un-greenlit exit idles do nothing to the arm** (the fix; today they consume). The idle branch distinguishes by kind: a `compact` arm resolves exactly as today (token scan, consume on idle); an `exit` arm is acted on only when greenlit.
3. The model calls `thatch_exit` (new tool, zero args). The tool resolves the calling session from the per-call host context (`sessionID` on the third `ToolDef.execute` parameter, `src/tool-defs.ts:232`; the established opencode-only pattern, zero-arg precedent `thatch_get_session_info` at `src/tool-defs.ts:1601-1617`). The session ID is always resolved from host context and never trusted from a model-supplied argument.
4. Tool guards, in order:
   - No arm for this session, or the arm is kind `compact` (the callback checks kind; a compact arm plus `thatch_exit` is a "no exit in progress" refusal, never a greenlight) -> teaching refusal: "No exit in progress. This tool closes the session after /thatch/exit has armed it; run /thatch/exit first." No side effects.
   - Arm already greenlit (the callback distinguishes fresh from prior via an `already` flag) -> idempotent reply: "Already greenlit. Finish your final response; the session closes when you go idle."
   - Arm present -> mark greenlit, persist the flag to the runtime_state journal row, reply: "Greenlit. Finish your final response; the session closes when you go idle."
5. Next `session.status` idle for that session with a greenlit arm -> the existing close executor runs unchanged. Its order is: the arm and journal row are deleted FIRST (map at `src/runtime.ts:2272`, row at `:2280` - before everything, exactly as today), then `watchers.sessionDied` -> `db.unregisterChatSession` -> `caps.exitHost` (ordering is load-bearing, comment at 2302-2307). The greenlit return skips extraction and pending deliveries exactly as today's token-greenlit return does (`src/runtime.ts:2330`; rationale: the checklist's flush step drained the buffer, and the host is vanishing). Deleting first is what keeps the v2 no-bridge strand a silent skip instead of an every-idle retry loop.

### The state-access seam (the plan's main wiring obligation)

`pendingWrapUp` is module-local to `src/runtime.ts`; tool execute bodies in `src/tool-defs.ts` cannot see it, and the journal has no per-key read (`runtimeStateAll` only, `src/db.ts:1226`). The tool therefore gets a new optional `CoreContext` provider field, following the three existing precedents:

- `extractionPayloadProvider` (`src/tool-defs.ts:114`, wired from `src/runtime.ts:1614-1637`);
- `drainExtractionQueue` (`src/tool-defs.ts:120`, consumed by `extraction_done` at `src/tool-defs.ts:806-811` - the closest precedent: a tool marking runtime state via injected callback);
- `sessionTabHost` (`src/tool-defs.ts:152`, post-construction injection closing over runtime state).

Shape: one optional callback (e.g. `wrapUpGreenlight(sessionID) => { status: "greenlit", already: boolean } | { status: "none" }`), wired in `buildCoreContext` (`src/runtime.ts:1612-1640`), declared on `CoreContextExtensions` (`src/tool-defs.ts:2849-2884`), built provider-less on the MCP path (`src/mcp.ts:155-175`). The callback owns the kind check (a compact arm reads as `none`); the `already` flag drives the tool's idempotent reply. The callback closure carries the `directory` and `disposed` guard the journal write needs. `host === undefined` (MCP path, which never registers the tool anyway) returns the standard availability notice per the opencode-only pattern. The opencode systemPrompt's hand-maintained Tools list (`src/prompts.ts:174-186`) gains a `thatch_exit` bullet: the catalog test asserts every non-v2Only tool name appears there, so this edit is required, not cosmetic.

### The arm value shape

The journaled value becomes `{ token?, kind, greenlit?: boolean }`. `token` becomes OPTIONAL: compact keeps it, the exit entry omits it (its token role is gone), and the compact token-scan branch asserts its presence. The reload-path cast at `src/runtime.ts:984` is untyped; `WRAPUP_COMMANDS` at `src/runtime.ts:108-111` takes the optional field.

### Rescind semantics (prompt-level, not runtime)

An arm with no expiry persists until re-armed, `session.deleted`, a full process restart (foreign-pid rows are deleted by design), or the greenlit close. The stale-arm scenario - user runs `/thatch/exit`, blockers get listed, the user says "never mind", and days later the model calls `thatch_exit` mid-unrelated-work - is handled in the instruction channel, where the model's judgment lives:

- The tool description fences it: call only after the user ran `/thatch/exit` and the checklist is fully handled; never to signal a finished task or turn.
- The template carries the rescind rule: "If the user moves on to unrelated work after you listed blockers, do not call `thatch_exit`; the user re-runs /thatch/exit when ready."

Accepted residual risk: a stale arm plus a hallucinated exit instruction closes a live session. Blast radius is a closed tab (the session row, memories, and watcher state survive server-side; reopening re-attaches). This is the same failure class as today's premature token, with a longer window; the runtime fences it only with the arm-creation gate. Escalation path if ever observed in practice: add an `armedAt` TTL to the arm value (no protocol change; slots into the callback's kind check).

### What is deleted

- The token scan in the idle branch for exit arms: the `caps.sessionMessages` fetch, the `endsWith(token)` check, and the consume-on-idle for `kind: "exit"` (compact keeps its scan and consume).
- The blocked-exit toast for exit ("Not exiting - resolve the items listed above"): it fired on mid-exit idles and was actively misleading in the observed failure. An exit whose checklist is not complete lists its blockers as prose per the template; there is no runtime "blocked" concept to toast about. The compact toast stays.
- `EXIT_READY_TOKEN` from `artifacts/commands/exit.md` (the `${TOKEN:EXIT_READY_TOKEN}` placeholder in the template). The constant `EXIT_READY_TOKEN` (`src/commands.ts:55-56`) and its ternary arm inside the shared `${TOKEN:...}` interpolation branch (`src/commands.ts:157-161`) die too - but the interpolation branch itself SURVIVES: `compact.md` still uses `${TOKEN:COMPACT_READY_TOKEN}` (pinned by uc-103), so only the exit arm of the ternary goes.

### Template rewrite (`artifacts/commands/exit.md`)

Keep the checklist (${CHECKLIST}) unchanged. Replace the token paragraph with:

> When every item is handled and nothing needs the user's attention first, call `thatch_exit` with no arguments, then end your final response. The session closes when you go idle after that call.
>
> If anything is outstanding, list the items concisely so the user can address them, and do NOT call `thatch_exit`. The session stays open until the tool is called. If the user moves on to unrelated work after you listed blockers, do not call `thatch_exit`; the user re-runs /thatch/exit when ready.

No "call it as the very last action" wording: the close fires on idle after the call, so a final response (goodbye, summary) between the call and the idle is expected and renders.

### Misfire inventory

- Call with no arm, or against a compact arm: refusal, zero side effects (the arm is created only by the command; the callback's kind check routes compact arms to refusal).
- Double call: idempotent greenlit reply.
- Premature call while checklist incomplete: close fires early - same consequence as today's premature token, but the trigger window is WIDER: today the token does nothing unless it is the trailing text of the resolving idle's last assistant message (`src/runtime.ts:2290` `endsWith`); the tool closes on any idle after the call, so a mid-turn call followed by more work closes where today it would toast-block. No new mitigation available; the template's "do NOT call" wording is the mitigation, same as today.
- Stale arm + rescinded intent: accepted risk, prompt-fenced (see Rescind semantics); recovery is reopening the tab.
- Model never calls it: session stays open, visibly, with no arm consumption masquerading as progress.

## State and transition matrix (the wrap-up arm)

Arm state per session (in-memory `pendingWrapUp` map + `runtime_state` journal row, kind `wrapup`). `compact` arms keep today's machine unchanged; `exit` arms follow this matrix.

| State | Meaning | Reached by |
|------|---------|-----------|
| NONE | no arm | initial; or deleted |
| ARMED | `/thatch/exit` ran, not greenlit | NONE -> ARMED: command.execute.before arms + journals |
| GREENLIT | `thatch_exit` accepted | ARMED -> GREENLIT: tool call from the arm owner's own model; journal value rewritten with `greenlit: true` |

| Transition | Trigger | Effect |
|-----------|---------|--------|
| ARMED -> ARMED | a new `/thatch/exit` re-arms | overwrite, `greenlit` resets false (fresh checklist) |
| ARMED -> GREENLIT | `thatch_exit` accepted | journal updated; reply instructs final response |
| ARMED -> NONE | `session.deleted` | journal row deleted; no close (tab is gone anyway). Existing cleanup at `src/runtime.ts:2510-2511` already does this kind-agnostically - no code change |
| ARMED -> ARMED | same-pid plugin reload mid-exit | journal row restores ARMED; model re-calls the tool (`src/runtime.ts:976-984`, same-pid only) |
| GREENLIT -> GREENLIT | same-pid plugin reload mid-handshake | journal restores GREENLIT (flag is journaled); next idle closes |
| NONE (arm dropped) | full opencode process restart | foreign-pid wrapup rows are DELETED by design ("too dangerous to inherit", `src/runtime.ts:977-982`); session stays open; user re-runs the command. Same as today |
| GREENLIT -> NONE | next `session.status` idle of that session | close executor: arm + journal row deleted FIRST (`:2272` map, `:2280` row), then deaths -> unregister -> exitHost; extraction and pending deliveries skipped (same return as today's greenlit path) |
| (any) -> (any) | `/thatch/compact` while an exit arm exists | the compact arm write overwrites; kind switches to compact, compact rules apply from then |

Precedence rules:
- The idle branch checks GREENLIT first; only GREENLIT triggers a close. Un-greenlit exit idles do nothing to the arm (the fix; today they consume). There is NO runtime disarm: rescind is prompt-level (see Rescind semantics).
- A wrap-up command write is authoritative over any prior arm state: it overwrites and resets `greenlit`.
- Greenlit-close beats same-idle extraction: the greenlit return skips extraction and pending deliveries, exactly as today's token-greenlit return does.

## Deltas-from-template ledger (exit arm vs compact arm, the unchanged twin)

Verified against `src/runtime.ts:2270-2345` (resolution) and `artifacts/commands/exit.md` (template).

| Aspect | Compact (twin, unchanged) | Exit (this plan) |
|--------|--------------------------|------------------|
| Arm creation | `command.execute.before`, kind `compact`, journaled | same hook, kind `exit` |
| Idle resolution | consumes arm on first idle, unconditionally | does NOT consume; acts only when greenlit |
| Greenlight signal | `THATCH_COMPACT_READY` text token, checked on last assistant message of the resolving idle | `thatch_exit` tool call, any turn after arming |
| Blocked path | token absent -> warning toast -> fall through to extraction | no toast, no fall-through concept; blockers are prose per template; un-greenlit idles just run the normal pipeline |
| Host action | `caps.compactSession(sessionID)` | `watchers.sessionDied` -> `db.unregisterChatSession` -> `caps.exitHost(sessionID)` |
| Session survival | session survives compaction | session's tab closes |
| Token constant | `COMPACT_READY_TOKEN` stays; the shared `${TOKEN:...}` interpolation branch stays (compact.md uses it) | `EXIT_READY_TOKEN` constant + its ternary arm in the shared branch die (`src/commands.ts:55-56, 157-161`) |
| Arm lifetime | one idle (consume-on-idle) | until greenlit, re-armed, session.deleted, or restart; no runtime expiry (rescind is prompt-level) |

## Tests

Write pins BEFORE the change where the section is unpinned (the safe-to-modify audit found one such section):

- **Pin first (refactor-first dependency):** the same-pid journal rehydration in `src/runtime.ts:976-984` has NO existing pin (`tests/state-persistence.test.ts` covers DB-layer prune/survivor semantics only, at :58, :911, :927). Write the rehydration pin asserting current behavior (same-pid row lands back in `pendingWrapUp`; foreign-pid row pruned), then extend the value shape.
- `tests/tool-defs-catalog-session.test.ts` (NOT tests/tool-defs.test.ts - deleted in `9e24a99`): count at :14 (`TOOL_DEFS.length` 39 -> 40), names :16-56, opencode-only exact array :59-71, prompt listing :73+ - **a PIN, not self-adapting**: it iterates TOOL_DEFS and asserts each non-v2Only name appears in the opencode prompt's hand-maintained Tools list (`src/prompts.ts:174-186`), so that list must gain `thatch_exit` or this test fails; MCP exclusion :96.
- `tests/mcp.test.ts:88-100`: shared-tool count stays 29 (the new tool is opencodeOnly).
- `tests/plugin-entry.test.ts:39` (NOT tests/plugin.test.ts - deleted in the same split): sorted hook tool names.
- `tests/plugin-wrapup.test.ts`: the exit-token tests (:60-64, :108-112) are REWRITTEN to the tool protocol; :158 sorted names; :200-206 exit-template-must-not-mention-chat_unregister (must keep passing); :129 session.deleted clears arm. The ordering test at `tests/opencode-v2-adapter-caps.test.ts:214-264` (deaths-before-unregister, real chat + watcher rows) is the STRONGEST existing pin and the template for the new greenlit-close test - copy its harness pattern.
- `tests/opencode-v2-adapter-caps.test.ts`: exit greenlit -> `EXIT_TAB_CLOSED_EVENT` (:189), TUI-only payload (:209), extraction-skip on greenlit return (:186 compact twin); the no-bridge floor test (:349-375) greenlights via the token and MUST convert to the tool protocol; the ordering test (:214-264, deaths-before-unregister via real chat + watcher rows) also greenlights via token and gets rewritten to the tool protocol - it remains the STRONGEST existing pin and the harness template for the new greenlit-close test.
- **New pins:** exit arm survives an un-greenlit idle with no side effects; greenlit exit closes at next idle in the code's actual order (arm + row deleted first, then deaths -> unregister -> exitHost); refusal without arm; refusal on a compact arm; idempotent double call; journal reload preserves greenlit (same-pid).
- `tests/qa/auto/uc-103-wrapup-commands.ts`: pins the exit token protocol end-to-end on v1 and v2 legs - the largest named rewrite; rewrite to the tool protocol. EXIT pins: step descriptions (:39, :44), step 1 (:115), step 5 (:156-166), step 10 (:242-253). DO NOT touch the compact-leg lines (:282 step-11 floor wait, :313 step-12 blocked-compact wait) - they must keep the token per the non-goal.
- `tests/qa/auto/uc-059-tool-prefixing.ts`: opencode-only expected array.
- `tests/commands.test.ts:19`: unresolved-placeholder guard over every artifact (fails at load if exit.md and the interpolation branch disagree).
- `tests/env-knobs.test.ts:41`: `PROTOCOL_MARKERS` lists `THATCH_EXIT_READY` - retire the entry with the constant; `src/env-knobs.ts:26` comment likewise.

## Docs

Concrete sweep: `grep -rn "THATCH_EXIT_READY\|EXIT_READY\|greenlight" docs/ README.md src/env-knobs.ts src/commands.ts` and fix every hit. Known targets (from the round-1 lenses):

- `docs/dev/features/session-lifecycle.md` (:17, :68, :73-75, :81) - the primary lifecycle doc; :75 names both tokens, :202 states the resolution semantics and the old value shape `{token, kind}` (neither matches the grep - found by round 2).
- `docs/dev/README.md:134` - hook-table row describing token resolution and exit ordering.
- `docs/dev/features/commands.md:79`.
- `docs/user/commands.md:49,67`; `docs/user/README.md:250` (:232 area also covers the exit flow); root `README.md:235`.
- `docs/user/cross-session-chat.md:215,255` - greenlit-exit unregistration wording (behavior unchanged; wording check).
- `docs/dev/features/multi-host.md:247` (opencode-only features list gains `thatch_exit`) - tool count +1 lives in the tests, not these docs.
- `docs/dev/features/opencode-plugin.md` (:64, :71 caught by "greenlight"; :76 "blocked wrap-ups" toast wording - the exit toast is being deleted - reachable only by reading the file).
- `docs/dev/mcp-parity.md` (:21 opencode-only tool enumeration gains `thatch_exit`; :25 wrap-up row describes the token protocol).
- `src/env-knobs.ts:26` + `src/commands.ts:46` header comments describing the token family.
- `src/prompts.ts:556-566` - the mcpInstructions "intentionally absent" list gains `thatch_exit` (no test pins this list; docs-drift risk, do it anyway).
- Memory cleanup after landing: the vera-failure-mode memory's "re-run /thatch/exit and emit the token as the last line" protocol becomes "re-run /thatch/exit and call thatch_exit when the checklist is clear"; the wrap-up-commands memory's TOKEN GATE section needs the exit/compact split; the memory claiming the ordering test "sidesteps" chat_unregister is WRONG as stated - the real ordering test (opencode-v2-adapter-caps.test.ts:214-264) pins runtime-side ordering via DB state and is the harness template; correct that memory.

## Verification

1. `mise run check` green (lint, tsc, unit tests).
2. `mise run qa-auto` green (uc-103 rewritten, uc-059 extended).
3. Manual smoke reproducing the observed failure: scratch session with a pending background extractor during `/thatch/exit`; verify the mid-exit idle leaves the arm intact and the post-completion `thatch_exit` call closes the tab. Then the trivial case: bare `/thatch/exit` with a clean checklist closes on the first idle.
4. CI green on main; machine-wide broadcast before the push (hot-reload blip).

## Risks

- Model never calls the tool: session stays open (visible, self-explanatory), user re-runs the command. Same failure visibility as a missing token today, minus the silent-arm-consumption false negative.
- Premature tool call while blocked: same exposure as today's premature token, wider in-turn trigger window (see Misfire inventory); template wording is the mitigation.
- Stale arm + rescinded intent: accepted risk, prompt-fenced; recovery is reopening the tab. Escalation if observed: TTL on the arm value.
- Plugin reload between tool call and idle: greenlit flag journaled, so the same-pid reload cannot strand a greenlit session. A full process restart drops the arm by design (no-inherit rule, unchanged); session stays open, user re-runs.
- Inherited, not fixed here: on v2 with no TUI bridge, the close executor deletes the arm and journal row before the emit is skipped (`src/runtime.ts:2280` precedes the emit path; `src/opencode/v2.ts:994-996` no-bridge branch) - session stranded, arm gone, console error only. Identical today; noted so a reviewer does not mistake it for a regression.
