# Redo command: /s /PAT/REPL/flags

A TUI slash command that undoes the last exchange and resubmits your message with a perl-style substitution applied. Completes Jeff's loop (/undo, fix a typo, rerun) in one keystroke. Name ruling: `/s` (the built-in `/redo` name collides - see the name section).

## Context

Jeff's repeated workflow: run `/undo` to revert his last message, hand-edit a typo or a poorly phrased sentence, resubmit. The idea: a one-keystroke `s/foo/bar` command. Rulings made: perl-flavored regexes (NOT sed; no ANSI classes - they do not exist in the engine anyway), direct resubmit ("i can always do it again if i fucked it up").

Feasibility was verified against the opencode v2 source (`~/dev/opencode`, `origin/v2`) and the PINNED `@opencode/plugin` + `@opencode/client` 2.0.14 types (the earlier "pinned types may lag" worry is retired - everything used exists in the pin):

- **`/undo` is plain SDK calls** (`packages/tui/src/routes/session/index.tsx`, `session.undo`, ~:1012 on origin/v2): `findLast` user message with non-empty text, then `interrupt` + `wait` + `client.session.revert.stage({sessionID, messageID})` - server-side revert exists in core (`packages/core/src/session/revert.ts`) and is PUBLIC API BY CONSTRUCTION (`packages/protocol/src/groups/session.ts:535-567`: HTTP endpoints with OpenAPI annotations, typed errors; PR #33226's body records the design: "stateless revert preview and durable revert commit APIs with optional file restoration"). The editor repopulation is internal TUI state, NOT exposed to plugins - so the command resubmits directly instead (the ruling above).
- **The staged lifecycle is for the prompt boundary** (archaeology-verified): `revert.commit` fires inside `session.prompt` after message prep, before admission (`session.ts:164` - "Commit a staged revert only after preparation succeeds, before admitting new work"); a staged revert suppresses synthetic wakes (`session.ts:310`); the TUI's built-in `/redo` (`session.redo`, `revert.clear`) cancels a staged undo. Consequence for this plan: the resubmit COMMITS the staged revert - which deletes queued inbox rows (see the matrix + guards).
- **The TUI plugin can register slash commands**: `KeymapCommand.slash: {name, arguments: true}` (`packages/plugin/src/tui/context.ts:422-431`, in the pinned 2.0.14 types too) adds the command to prompt slash completion and passes the RAW argument string to `run(input)`. In-tree consumers exist (`btw`, `cd`, `rename`); plugin-registered commands render in completion indistinguishably from built-ins.
- **The TUI plugin carries the SDK client** (`Context.client: OpenCodeClient`, `context.ts:549` - a sibling of `ui`, not inside it): interrupt, wait, `revert.stage`, and the prompt submission are all callable from thatch's `tui-plugin.ts`.
- **The engine**: JavaScript RegExp (the plugin is TypeScript) - PCRE-flavored for daily use (`\d \w \s \b`, lookarounds, non-greedy, named groups, `\p{...}` with `u`), NO ANSI classes (they do not exist in the engine), `\K` and `/e` absent (never wanted here).

No LLM is involved: the command is instant, deterministic, and costs no model turn. Bare `s/foo/bar` (typed without the slash) is NOT interceptable - non-slash input goes to the agent as a user message; out of scope, documented in the user doc.

## Name ruling: `/s` (Jeff, 2026-10-27)

The original `/redo` ruling was based on a wrong claim by the plan: v2 SHIPS a built-in `/redo` (`session.redo`, `slash: {name: "redo"}`, `<leader>r`, footer hint "or /redo to restore") - it CANCELS a staged undo (`revert.clear`), the exact inverse of `/undo`, present since the v2 TUI's introduction (verified in the installed v2.1.4 binary). Typed `/redo s/...` still routes to the plugin (dispatch only matches `arguments: true` commands, which the built-in lacks), but bare `/redo` after an `/undo` would hit this feature's "malformed s///" toast instead of restoring - and completion lists two `/redo` entries with opposed semantics.

RULED: the slash name is **`s`** (option a). Canonical shape: `/s /foo/bar` (command, space, delimiter-first substitution - the space is load bearing, see Input Splitting; the `s/foo/bar` form with a leading `s` also parses). No built-in named `s` (verified: the full slash-name list has no `s`); zero collision. Because the name is NOT `/redo`, the guard toasts, matrix rows, and user doc pointing at "the built-in /redo" for staged-undo recovery are correct as written - no parameterization needed.

## Goal

A TUI slash command: parse the substitution, apply it to a copy of the last user message, and on a match revert the exchange and resubmit the edited text. Non-destructive on every failure path.

## Non-goals

- No editor repopulation (not exposed to plugins).
- No LLM/tool-based path for bare `s///` input.
- No runtime rescind fences (every failure aborts before the revert).
- mini/headless support (the tui entrypoint does not load there; `/undo` itself is TUI-only).
- Multi-message or assistant-message targeting (v1 of the feature: the LAST real user message only, exactly `/undo`'s rule).

## Design

### SDK-free core (the session-tab-shared isolation pattern)

`src/redo-shared.ts` - zero SDK imports (the isolation rule in `src/index.ts`; same shape as `src/session-tab-shared.ts`). The ORCHESTRATION lives here too, not in the wiring: a pure function takes the client (or a narrow interface over it) as a parameter, so the destructive-ordering invariant is unit-tested, not wired-and-hoped. Exports:

- `parseSubstitution(input: string)`:
  - Accepts `<s?>[delim]PAT[delim]REPL[delim]<flags>`: an OPTIONAL leading `s` (the perl verb - `/s s/foo/bar` and `/s /foo/bar` are both valid; the command name already says substitute, so the bare-delimiter form is canonical), where `<delim>` is any single non-alphanumeric, non-whitespace, non-backslash character (the perl rule), used consistently for both splits. The `s`-strip fires only when `s` is immediately followed by a valid delimiter - delimiter-first input is unambiguous. Backslash-escaped delimiters inside PAT and REPL do not close the segment (`/a\|b/c/` works).
  - Flags: a subset of `g i m s u`, deduplicated; an unknown flag is a parse error naming it. No `g` = first match only (the perl default).
  - Replacement translation for perl muscle memory: `\1`..`\9` -> `$1`..`$9`; `\n` and `\t` become literal newline/tab. `$1` passes through natively.
  - Returns a typed result, not a throw (callers render toasts).
- `applySubstitution(text, parsed)`:
  - Compiles `new RegExp(PAT, dedup(flags + "u"))` (dedup: a user-supplied `u` must not produce `"uu"`); on SyntaxError retries WITHOUT the `u` flag (Unicode mode rejects some identity escapes like `\:`; legacy mode accepts them); on the second failure returns the compile error text (rendered verbatim in the toast; nothing is touched).
  - Runs `text.replace(regex, replacement)`; returns the new text and whether anything changed - the no-match signal.
- `redoLastMessage(deps, input)`: the orchestration - parse, fetch messages, pick the target, guard, apply, gate, revert, resubmit - with the client operations injected as a narrow interface (`fetchMessages`, `interruptAndWait`, `revertStage`, `resubmit`) so the ordering invariant ("nothing touches the session until the edited text exists and changed") is unit-tested with mocks. Return: a typed outcome the wiring renders (toast text + variant).
Parser/apply unit tests in `tests/redo-shared.test.ts`: delimiters (default `/`, alternates `| , #`), the optional leading `s` (both spellings parse identically: `/s /foo/bar` args and `s/foo/bar`), escaped delimiters, flag validation (unknown, duplicates, no-g default), the `\1 -> $1` translation, `\n`/`\t` in replacements, the u-fallback compile, lookarounds, non-greedy, `\p{Letter}` with u, first-match vs `g`, the unchanged-text signal, and the ORCHESTRATION ordering with mocked deps (no-match aborts before any revert; resubmit failure is reported, not hidden).

### The wiring (`src/opencode/tui-plugin.ts`, thin)

A keymap layer registering `{id: "thatch.redo", slash: {name: "s", arguments: true}, run}` (the command id keeps the thatch namespace; the slash name is the ruled `/s`). The run body: resolve `sessionID` from `context.ui.router.current()` (`{type: "session", sessionID}` when a session route is active; toast + return otherwise), then call `redoLastMessage` with the real client operations and toast the outcome. The existing `data.listen` handler and its cleanup are untouched (additive).

INPUT SPLITTING (verified, Jeff's "isn't the space load bearing?" instinct: YES): `parseSlashHead` (`packages/tui/src/prompt/parse.ts` on origin/v2) splits the command name at the FIRST whitespace (`separator = /[ \t\n]/`). `/s/foo/bar` with no space parses the command NAME as `s/foo/bar`, matches nothing, and falls through to the agent as a literal message. The usable shape is `/s s/PAT/REPL/flags` - command, space, substitution - exactly how every other `arguments: true` command takes args (`/btw text`, `/rename name`). The completion flow produces the spaced form naturally (picking the command inserts the trailing space). A plugin cannot change the split (the parser call site is host code).

### Guards (the state matrix's rows that make it safe)

- **Staged-undo guard**: after a built-in `/undo`, the undone messages remain in the message store and appear in the data layer's list; a naive findLast would target the invisible undone message and the resubmit would commit a revert deleting everything from it. Guard: read the session's staged-revert state (`revert.messageID` on the session info via the plugin data layer, the same state the built-in's `enabled` check reads) and abort with a toast ("an undo is staged - cancel it with the built-in /redo first") while the name question is open.
- **Pending-inbox guard**: the resubmit's commit DELETES queued inbox rows at/after the boundary (`projector.ts` Committed: SessionInbox rows with `enqueued_seq >= boundary`; the client drops matching pending items). Chat mail delivered in the gap is stamped delivered and silently lost. Guard: `data.session.pending.list(sessionID)` non-empty -> toast + abort.
- **Delivered-wake guard**: a chat wake that already RAN (its synthetic turn sits in the reverted range, newer than the target) is deleted by the commit while its mail is stamped delivered - silent loss on the SUCCESS path. The built-in `/undo` has the identical hole (inherited, not introduced); this command can be stricter one findLast away: any `type: "synthetic"` message newer than the target -> toast + abort ("a chat wake landed in the range - use /undo instead").
- **Synthetic-target guard (resolved)**: chat wakes on v2 are NOT user messages with a synthetic flag - they are `type: "synthetic"` messages, a distinct member of the message union (`SessionMessageSynthetic`; the v2 adapter routes all-synthetic parts to `session.synthetic`, which core stores as the synthetic type). The guard is simply the built-in's exact filter - `type === "user" && !!text.trim()` - over the union; no flag hunt needed.

### Flow (the orchestrated steps)

1. Parse -> toast on error, return.
2. Fetch messages with a PAGED WALK of the client's `message.list` endpoint (pin `client.d.ts:92`: `limit`/`order`/`cursor` params): fetch in `desc` order, page by cursor until a real user message is found or history exhausts, inside the injected `fetchMessages`. Rationale: the plugin data layer's `message.list` is a reactive newest-20 WINDOW (`messagePageLimit = 20`, `packages/client/src/solid/data.ts:83`; the TUI passes no larger initial limit) - a routine agentic turn produces 20+ messages and pushes the target out of that window, a false "no prior message". The walk is bounded by the cursor and unit-testable. (`session.context` remains rejected: it returns only post-compaction context; a target compacted away surfaces as not-found -> toast, which is correct - a compacted-away message cannot be reverted anyway.)
3. Target: the last user message with non-empty, non-synthetic text.
4. Guards, in order: staged-undo abort (a staged revert exists); pending-inbox abort (queued mail would be destroyed); delivered-wake abort (a synthetic wake turn newer than the target would lose its mail).
5. Apply to a copy -> unchanged -> toast "no match - nothing done"; return. NOTHING has touched the session yet.
6. `interrupt` + `wait` + `revert.stage({sessionID, messageID})` (the `/undo` trio, same file-restore semantics: files the turn edited restore, and the rerun redoes them).
7. Resubmit with the edited text. Failure here -> toast naming the staged state (files restored, messages intact, recoverable with the built-in `/redo` or by typing anything); return.

Known simplification (documented, not modeled): the TUI's `/undo` handles a pending-delivery edge via `mutatePending("cancel", ...)` before reverting; this command covers the running-session case via interrupt+wait and leaves queued-prompt undo to the built-in. Residual race: a chat-poller wake admitted between `wait()` and `stage()` falls under the pending-inbox guard's toast only if it lands before the guard reads - accepted as a rare, bounded race.

## State matrix

| Phase | Condition | Result |
|-------|-----------|--------|
| Parse | malformed `s///`, unknown flag | toast names the error; nothing touched |
| Compile | regex invalid with and without `u` | toast carries the engine error; nothing touched |
| Target | no prior real user message with text | toast; nothing touched |
| Guard | a staged undo exists | toast pointing at the built-in `/redo`; nothing touched |
| Guard | pending inbox rows exist | toast naming the queued mail; nothing touched |
| Guard | a delivered synthetic wake sits newer than the target | toast naming the lost-mail risk, pointing at `/undo`; nothing touched |
| Apply | regex matches nothing | toast "no match - nothing done"; nothing touched |
| Apply | match | revert the exchange (files restored, `/undo` semantics), resubmit the edited text, agent runs |
| Revert | `revert.stage` rejects mid-trio (turn already interrupted) | toast; no revert, no resubmit - the `/undo`-equivalent no-op state |
| Resubmit | prompt rejects after a successful stage | toast naming the staged state (files restored, messages intact, recoverable via built-in `/redo` or any typed message) |

Precedence: the no-match check ALWAYS gates the revert; the guards ALWAYS gate the apply. The session is never left half-redone: its non-pristine outcomes are a plain revert (a failed `/undo` equivalent) or a staged revert (recoverable both ways).

## Tests

- `tests/redo-shared.test.ts` (new): the parser, apply, and orchestration cases above - including the mocked-deps ordering test (no-match aborts before any revert; resubmit failure reports the staged state) and the paged-walk fetch (stops at the first real user message; exhausts history before giving up). The SDK-free module keeps the suite bun-test-only.
- A manualOnly LIVE QA uc for the TUI smoke (the uc-125 session-tab precedent: `tests/qa/live/`, `manualOnly: true`, the manual procedure as steps) - the plan's earlier "no uc" claim was wrong about the precedent; session tabs HAVE a live uc.
- Wiring: manual smoke (real TUI: send a message with a typo, run the command, verify revert + resubmit + the corrected text in the new turn; then the guard cases: staged undo, no-match, bad flag, no prior message).
- QA use cases: TUI-only features cannot run in the headless sandbox (tui entrypoints no-op there); no uc - consistent with the session-tab precedent.

## Docs

- `docs/dev/features/opencode-plugin.md`: a row in the v1-vs-v2 surface table + a short redo-command section (the keymap slash registration, the SDK-free split, the /undo-mechanics reference, the guards).
- `docs/user/commands.md` (the Slash commands section - the natural home; the plan's earlier "no user-tier TUI-feature doc" reading was right about session tabs but missed this page).
- No release proposal (the standing rule); the changeset rides whatever Jeff orders next.

## Verification

1. `mise run check` green; `mise run qa-auto` green (untouched, but the gate runs).
2. Manual smoke in a real TUI: the happy path (typo fix), no-match abort, bad-flag toast, staged-undo guard, pending-inbox guard.
3. Landing: broadcast (src-touching merge to thatch main - machine-wide warning), squash-merge with the tree-equality gate, CI verification on the SHA. NO release (Jeff orders those).

## Risks

- **SDK surface drift**: low after the lens pass - every surface used (slash.arguments, Context.client, revert.stage, message.list/session.context) exists in the PINNED 2.0.14 types; the runtime resolves the installed 2.1.x host. Drift beyond the pin is a normal upgrade concern, not this plan's.
- **Message-fetch surface**: the client's paged `message.list` walked to exhaustion or first hit (desc order); the plugin data layer's reactive 20-message window is display state, not a fetch source. A target compacted away surfaces as not-found -> toast (correct: it cannot be reverted).
- **Files restored on revert**: `/undo` semantics - correct for the rerun loop; a prose-only rerun flag (`files: false` on `revert.stage`) is available later.
- **Queued-mail race**: the pending-inbox guard closes the window; a wake admitted in the microseconds after the guard read is accepted (rare, bounded).
- **Extraction race**: the interrupt+wait window can let extraction buffer the doomed turn; near-duplicate dedup absorbs the worst case. Accepted.
