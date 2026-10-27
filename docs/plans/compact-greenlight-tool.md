# Compact greenlight tool

Convert `/thatch/compact` to the tool-call greenlight, completing the wrap-up protocol split started by the exit conversion (commit `7148d31`). After this, no command uses a text token.

## Context

The exit conversion (2026-10-27, `docs/plans/exit-greenlight-tool.md` in this worktree, landed as `7148d31`) established the pattern: the zero-arg opencode-only tool greenlights the armed wrap-up; un-greenlit idles leave the arm alone; the next idle after greenlit runs the close executor; rescind semantics live in the prompt channel, not runtime fences. `/thatch/compact` still runs the old one-idle token handshake and carries the same latent failure the exit conversion fixed: the checklist's flush step (a single shared string, `${CHECKLIST}`, spliced into both artifacts) dispatches the fact-extractor as a background subagent, the model idles mid-checklist, the arm is consumed token-less, and the final `THATCH_COMPACT_READY` lands on nothing - the session never compacts. Structurally identical trigger, one surviving instance: the failure is theorized for compact only because compact has not been observed hitting it yet, not because anything differs.

Why the token exists at all (git-verified archaeology): the token gates when thatch triggers the HOST's own compaction - opencode's built-in `/compact`. There is no plugin path to invoke built-in TUI commands on v2 (executeCommand has nothing to resolve against); v1 drives the TUI `session_compact` legacy alias via `client.tui.executeCommand`; v2 calls `session.compact({sessionID})` on the promise domain (upstream #52385 - the repo's own doc ties it to the installed v2.0.25, one commit message says v2.0.22+; the version floor is immaterial because the call is runtime-guarded), via `optionalDomainMethod` - an older host degrades to a logged no-op. The greenlight says "the checklist is done; fire the host action." The tool replaces the marker, not the host action.

## Goal

`/thatch/compact` arms the same kind-compact arm; the model calls a new zero-arg `thatch_compact` tool when the checklist is clear; the next idle runs `caps.compactSession`. The token machinery (`COMPACT_READY_TOKEN`, the `${TOKEN:...}` interpolation branch, the compact token scan, the blocked-path toast) dies - no users remain.

## Non-goals

- Any change to host-action mechanics: v1's `client.tui.executeCommand("session_compact")` legacy-alias route and v2's `session.compact` promise call are invoked unchanged.
- Exit-path behavior (landed in `7148d31`; this plan only collapses the now-redundant arm-kind branching where the code simplifies).
- Runtime rescind fences (per Jeff's ruling on the exit plan: prompt-level semantics; a TTL on the arm value is the escalation if a stale-arm compact is ever observed).
- Coordinator-created arms.

## Design

### Arm lifecycle

1. `/thatch/compact` executes -> `command.execute.before` arms `pendingWrapUp { kind: "compact" }` and journals it (`src/runtime.ts:1879-1894`; map set at `:1885`, journal put at `:1893`). Unchanged. `WRAPUP_COMMANDS["thatch/compact"]` drops its `token` field: `WRAPUP_COMMANDS` becomes `Record<string, { kind: "compact" | "exit" }>` (`src/runtime.ts:109-112`).
2. The model works the checklist across any number of turns. **The idle wrap-up branch collapses to one shape** (`src/runtime.ts:2313-2398`): `if (wrapUp?.greenlit)` -> delete arm + journal row FIRST (map + row, before everything, preserving the no-bridge silent-skip property), then the kind-conditional host action:
   - `exit` -> `watchers.sessionDied` -> `db.unregisterChatSession` -> `caps.exitHost` (unchanged, landed code);
   - `compact` -> `caps.compactSession(sessionID)` (unchanged call);
   both return early (skip extraction and pending deliveries - the checklist's flush step drained the buffer). Un-greenlit idles (either kind) fall through to the normal pipeline; the compact blocked-path toast and token scan die.
3. The model calls `thatch_compact` (new zero-arg opencode-only tool) when the checklist is clear. Guards mirror `thatch_exit` exactly:
   - No arm, or the arm is kind `exit` (the callback checks kind; an exit arm plus `thatch_compact` is a refusal, never a greenlight) -> teaching refusal: "No compaction in progress. This tool completes /thatch/compact's checklist; run /thatch/compact first." No side effects.
   - Already greenlit -> idempotent reply: "Already greenlit. Finish your final response; compaction starts when you go idle."
   - Arm present -> mark greenlit, journal it (disposed-guarded), reply: "Greenlit. Finish your final response; compaction starts when you go idle."
4. Disarm paths unchanged from the exit design: re-arm overwrite (fresh command resets `greenlit`), `session.deleted` cleanup (existing, kind-agnostic at `src/runtime.ts:2562-2563`), foreign-pid restart rows deleted ("too dangerous to inherit" - a greenlit compact arm inherited across a restart could auto-compact on the resumed session's next idle; the prune comment at `src/runtime.ts:983-992` already names both kinds, and its phrase "the final message may already carry the token" is touched up in the same edit - no token exists after this plan). Same-pid reload restores the arm with its flag.

### The seam

Reuse the exit plan's state-access seam pattern, with one factory and two named fields:

- `CoreContext` gains `wrapUpCompactGreenlight` beside `wrapUpGreenlight` (`src/tool-defs.ts:153-159`; the existing field's doc comment - "a compact arm reads as 'none'" - is updated when the sibling arrives). Declared on `CoreContextExtensions` (:2894-2901), passed through `buildCoreContext` (:2929), built provider-less on the MCP path (`src/mcp.ts` builds its context inline with no wrap-up callbacks today).
- In `src/runtime.ts`, both closures are built by ONE factory - `makeWrapUpGreenlight(kind)` - so the disposed-guard + `runtimeStatePut` body (the load-bearing subtle part, the closure at `src/runtime.ts:1649-1667` with the journal put at `:1665`) is written once, not copy-pasted. Two verbatim closures are how a disposed-guard drifts. The codebase's kind-family style (wrapUpCommandDescription/Content, removeWrapUpCommandFiles, v2 registration) is kind-parameterized; two explicit CoreContext FIELDS keep the tool-side guards self-contained while the factory removes the duplication.

### Rescind semantics (prompt-level, mirroring exit)

- Tool description fences: call only after the user ran `/thatch/compact` and the checklist is fully handled; never to signal a finished task or turn; does not compact by itself - it greenlights the armed wrap-up.
- Template rescind rule: if the user moves on to unrelated work after blockers were listed, do not call `thatch_compact`; the user re-runs `/thatch/compact` when ready.
- Accepted residual risk: stale arm + hallucinated greenlight triggers an unplanned compaction. Blast radius: the session's context is compacted early - recoverable (no data loss; the conversation is summarized, not destroyed), same class as today's premature token but with a longer window. Escalation path if observed: TTL on the arm value.

### What is deleted

- `COMPACT_READY_TOKEN` (`src/commands.ts:54`) and the entire `${TOKEN:...}` interpolation branch (`src/commands.ts:155-161`) - compact.md was the last user; `interpolateTemplate`'s token replace goes.
- The compact token scan in the idle branch (the `caps.sessionMessages` fetch, `endsWith`, the `token !== undefined` guard), the blocked-path toast, and the one-idle consume. `caps.sessionMessages` keeps its alerts user; `caps.showToast` keeps 11 other call sites (12 measured in src, the blocked-path one dies).
- `THATCH_COMPACT_READY` from `src/env-knobs.ts:26`'s comment and from `PROTOCOL_MARKERS` in `tests/env-knobs.test.ts:34-42`.
- The `TOKEN:` exemption in `tests/commands.test.ts:19`'s unresolved-placeholder regex - with zero token users, the exemption is a dead allowlist entry that would let a future typo'd `${TOKEN:...}` ship uncaught by the static test (the loader's leftover check would still throw, but the test must agree with the loader).
- The mid-text token pins, which have no tool-protocol analog (a tool call cannot be mid-text): uc-103 step 7 (`:41`, `:198`) and `tests/plugin-wrapup.test.ts:98` - DELETED, not mutated.
- Dead scaffolding: `tests/mocks/plugin-harness.ts` `getWrapUpMessages` (:70, :110, :119 - exists solely to feed the token scan) and the `TOAST_EVENT` import in uc-103 (the blocked-toast path is deleted).

### Template rewrite (`artifacts/commands/compact.md`)

Same shape as exit.md's rewrite: checklist (${CHECKLIST}) unchanged; the token paragraph becomes the `thatch_compact` call instruction + the blockers/rescind paragraph. Keep the pinned section labels (`# User Message` / `# Pre-compact wrap-up`, pinned by `tests/plugin-wrapup.test.ts:259`). exit.md's landed text is the twin.

### Misfire inventory

- Call with no arm, or against an exit arm: refusal, zero side effects.
- Double call: idempotent greenlit reply.
- Premature call while checklist incomplete: compaction fires early - same consequence as today's premature token, wider in-turn trigger window (any idle after the call vs trailing-text-only). Template wording is the mitigation; identical exposure class to the tool-based exit.
- Stale arm + rescinded intent: accepted risk, prompt-fenced; blast radius is an early compaction (recoverable).
- Model never calls it: session never compacts - visible, self-explanatory, user re-runs the command.

## State and transition matrix (the compact arm)

Arm state per session (in-memory `pendingWrapUp` map + `runtime_state` journal row, kind `wrapup`). The exit arm's matrix is unchanged from the landed design (docs/plans/exit-greenlight-tool.md); the compact arm now follows THE SAME transitions, with one differing row:

| State | Meaning | Reached by |
|------|---------|-----------|
| NONE | no arm | initial; or deleted |
| ARMED | `/thatch/compact` ran, not greenlit | NONE -> ARMED: command.execute.before arms + journals |
| GREENLIT | `thatch_compact` accepted | ARMED -> GREENLIT: tool call from the arm owner's own model; journal value rewritten with `greenlit: true` |

| Transition | Trigger | Effect |
|-----------|---------|--------|
| ARMED -> ARMED | a new `/thatch/compact` (or `/thatch/exit`) re-arms | overwrite, `greenlit` resets false; kind switches if the other command |
| ARMED -> GREENLIT | `thatch_compact` accepted | journal updated; reply instructs final response |
| ARMED -> NONE | `session.deleted` | journal row deleted; no compaction. Existing cleanup, kind-agnostic, unchanged |
| GREENLIT -> NONE | `session.deleted` before the closing idle | same kind-agnostic cleanup applies (the flag is not consulted); no compaction |
| ARMED -> ARMED | same-pid plugin reload | journal row restores ARMED; model re-calls the tool |
| GREENLIT -> GREENLIT | same-pid plugin reload mid-handshake | journal restores GREENLIT; next idle compacts |
| NONE (arm dropped) | full opencode process restart | foreign-pid rows deleted by design; session stays un-compacted; user re-runs |
| GREENLIT -> NONE | next `session.status` idle of that session | arm + journal row deleted FIRST, then `caps.compactSession(sessionID)`; extraction and pending deliveries skipped |

Precedence rules (unchanged from the exit design): GREENLIT gates the idle action; a wrap-up command write is authoritative (overwrites, resets greenlit); greenlit-close beats same-idle extraction.

## Deltas-from-template ledger (compact vs the exit implementation, in code at 7148d31)

| Aspect | Exit (twin, landed) | Compact (this plan) |
|--------|--------------------|--------------------|
| Arm kind | `exit` | `compact` |
| Tool | `thatch_exit` | `thatch_compact` |
| Host action | `watchers.sessionDied` -> `db.unregisterChatSession("exit")` -> `caps.exitHost` | `caps.compactSession(sessionID)` only |
| Chat roster | unregistered (deaths placed first) | unchanged - the session survives compaction |
| Watcher deaths | recorded before unregister | none |
| Session after greenlight | tab closes | session survives, context compacted |
| v1 host action | `client.tui.publish` of app.exit | `client.tui.executeCommand("session_compact")` legacy alias |
| v2 host action | exit-tab-closed TUI-only rpc event | `session.compact` promise call (degrades to logged no-op on hosts older than the API) |
| Arm value | `{ kind: "exit", greenlit? }` | `{ kind: "compact", greenlit? }` - token field gone from both |
| Tool-call semantics | identical guard triple (refusal / idempotent / greenlight) | identical, kind-routed to compact |
| Blocked path | none since 7148d31 (blockers are prose) | toast + fall-through DIE here; becomes prose + normal pipeline |

## Tests

Pin-first where unpinned; the exit pins from 7148d31 are the regression net for the branch collapse:

- `tests/plugin-wrapup.test.ts` rewrites: the compact token tests (:51 greenlight, :83 blocked-toast, :93 consume-on-idle - note :83/:93 pin the OPPOSITE of the new un-greenlit-survives behavior) become tool-protocol tests; the install tests at :234 and :253 assert the INSTALLED compact.md contains `THATCH_COMPACT_READY` and break with the template rewrite. The compact mirrors of the exit pins: un-greenlit compact arm survives an idle; refusal without arm; refusal against an exit arm; idempotent double call; compact greenlight does not unregister (:191 twin); greenlit compact runs compactSession at idle with extraction skipped. `:136`'s second half (:148-153, compact arm still greenlights via token after the exit-tool refusal) is REWRITTEN, not deleted - the cross-kind refusal matrix keeps both legs. ADD the mid-text deletion note: :98's "token present but not trailing" pin is DELETED (no tool analog).
- `tests/opencode-v2-adapter-caps.test.ts`: the :90 pin (the v2-delivered compact prompt contains `THATCH_COMPACT_READY`) converts to asserting the `thatch_compact` instruction; compact greenlit -> `session.compact` called with the session id (:166-area, tool greenlight); extraction-skip pin (:186-area) keeps covering both kinds post-collapse; the compact SDK-floor test at :348 ("older SDK without session.compact degrades to a logged no-op") converts to the tool greenlight; the :313 blocked-path test converts (the blocked path dies).
- `tests/state-persistence.test.ts`: rehydration pins (:294 same-pid restore, foreign-pid prune, :357 greenlit restore) extend to compact rows; the :1019 wrap-up row literal `{ token: "T", kind: "compact" }` updates to the new shape, together with the reload-path cast type at `src/runtime.ts:993` (same inert-but-stale class - the cast keeps `token?` after the field dies).
- `tests/tool-defs-catalog-session.test.ts`: count (:14, 40 -> 41), names, opencode-only array (:60-64), prompt-listing pin (:75 forces the src/prompts.ts Tools edit), MCP exclusion (:98).
- `tests/mcp.test.ts:100-101`: shared-tool count stays 29.
- `tests/plugin-entry.test.ts:39`: sorted hook tool names.
- `tests/commands.test.ts`: the :14 placeholder-resolution load guard must keep passing with the interpolation branch gone; the :19 regex drops its `TOKEN:` exemption (test and loader agree again).
- `tests/env-knobs.test.ts:34-42`: `THATCH_COMPACT_READY` retires from `PROTOCOL_MARKERS` with the constant; :51 (every THATCH_ var in source registered) guards the removal.
- `tests/qa/auto/uc-103-wrapup-commands.ts`: the COMPACT legs rewrite to the tool protocol - step 1's token check (:35, run body :111) and expected-list token wording (:49, :51-52), step 3-4's run (:142-153, token message at :143), step 6 (:40, run :177-195, blocked-toast), step 9 (:43), step 11 (:45, run :279-309, older-SDK floor greenlights via token - will time out unrewritten), step 12 (:46, run :311-348, v2 blocked toast); step 7 (:41, :198) is DELETED (mid-text token pin, no analog). The EXIT legs (:39, :44, :115, :155+) stay as landed - they are the twin's regression net. Drop the `TOAST_EVENT` import if the blocked-toast leg deletions orphan it.
- `tests/qa/auto/uc-059-tool-prefixing.ts`: the full-catalog `expected` array (:42; the :92-95 length check makes omission loud) gains the new bare name.
- `tests/mocks/plugin-harness.ts`: `getWrapUpMessages` (:70, :110, :119) dies with the scan.

## Docs

Concrete sweep: `grep -rn "THATCH_COMPACT_READY\|COMPACT_READY\|greenlight" docs/ README.md src/env-knobs.ts src/commands.ts` and fix every hit. Known targets:

- `docs/dev/features/session-lifecycle.md` (:89 area - the wrap-up flow; :86, :211 the compact consume description).
- `docs/dev/README.md` (:134 hook-table row; :115 module-row `${TOKEN:name}` wording - reachable only by reading the file, not the grep).
- `docs/dev/features/commands.md:79`; `docs/dev/features/opencode-plugin.md` (:69, :75 compact capability rows; :76 the blocked-wrap-ups toast wording - the toast is being deleted).
- `docs/dev/features/multi-host.md` (:247-area list gains `thatch_compact`) + `docs/dev/mcp-parity.md` (:21 tool enumeration, :25 wrap-up row).
- `docs/user/README.md` (:250-area), `docs/user/commands.md` (:49-68 compact rows), root `README.md` (:231, :236).
- `src/commands.ts:46`-area header comment (greenlight-gated commands description).
- `src/prompts.ts:559` - the mcpInstructions intentional-absence list gains `compact` (the catalog test cannot force this one: it only checks `mcp__thatch__compact` absence, which holds regardless; docs-drift discipline applies).
- Memory cleanup after landing: rewrite the "Wrap-up slash commands" memory (no tokens left anywhere; both protocols tool-based), archive the branch record with provenance.

## Verification

1. `mise run check` green (lint, tsc, unit tests).
2. `mise run qa-auto` green (uc-103 compact legs rewritten, uc-059 extended).
3. Manual smoke: scratch session, `/thatch/compact` with a pending background extractor mid-checklist; verify the mid-checklist idle leaves the arm intact, `thatch_compact` greenlights, and the closing idle runs `session.compact`. Then the trivial case: bare `/thatch/compact`, clear checklist, compaction on first idle. Then the misfire cases: `thatch_compact` with no arm and against an exit arm both refuse.
4. CI green on main; machine-wide broadcast before the push (hot-reload blip; skill-mirror churn note if the release rides).

## Risks

- Model never calls the tool: session never compacts (visible; user re-runs). Same visibility class as the exit conversion.
- Premature call: early compaction, recoverable; wider trigger window than the trailing-text token (same class the exit change accepted).
- Stale arm: accepted, prompt-fenced; escalation is an arm TTL.
- v1 wrong-target quirk (pre-existing, called out so no one mistakes it for a regression): v1's `caps.compactSession` compacts whatever session the TUI has focused - it ignores the sessionID the arm is keyed by (`src/capabilities.ts:210-215`). Combined with the stale-arm risk, a stale greenlit arm on session A could compact the user's currently-focused session B on v1. Unchanged by this plan (host-action mechanics are a non-goal); add a one-line warning comment at the call site; the v2 path is per-session and unaffected.
- v2 hosts older than the compact API: `caps.compactSession` degrades to a logged no-op - UNCHANGED by this plan; a greenlit compact on such a host consumes the arm and compacts nothing, identical to today's token greenlight on the same host (verified structurally: delete-first order precedes the `optionalDomainMethod` no-op).
- Plugin reload/restart: same journal semantics as exit (same-pid restores, foreign-pid drops).
