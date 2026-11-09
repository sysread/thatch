# Feature: OpenCode plugin (v2)

The opencode plugin is the v2-only host integration: one SDK
(`@opencode/plugin`), one entry shape, one adapter. The plugin requires
opencode 2.1 or newer (the `session.synthetic` `resume` option and the
typed `session.compact` / `session.remove` / `session.list` promise-domain
members). The v1 line (opencode 1.18.x and its plugin SDK) is gone -
dropped outright in the drop-opencode-v1 plan; a v1 host cannot load this
plugin at all.

## Architecture

```text
src/index.ts          plugin entry -- default export { id, setup }
                        the host's module validator decodes the default
                        export as { id, setup } and ignores named exports
  └── (lazy) → src/opencode/v2.ts   the adapter (@opencode/plugin):
                      registers tools/commands/hooks, builds
                      HostCapabilities over the promise context, pumps bus
                      events; delegates to:
                src/runtime.ts      shared runtime (nudges, system prompt,
                                    session events, extraction, bookkeeping)
                      ↑ consumes
                src/capabilities.ts HostCapabilities seam
```

### The export shape

The host's plugin-module validator decodes `default` as `{ id, effect }`
or `{ id, setup }` with Effect Schema; excess keys are tolerated and
stripped, and named exports are silently ignored. `{ id, setup }` is
therefore the whole plugin surface; `src/index.ts` lazy-imports the
adapter inside `setup` so the SDK's module side effects evaluate there,
not at plugin-load time.

### The capability seam

`HostCapabilities` (src/capabilities.ts) is the interface of host
operations the shared runtime needs - 11 members, all implemented over
the v2 promise context by `buildCapabilities` (src/opencode/v2.ts). It is
the lifecycle-level sibling of `CoreContext` (src/tool-defs.ts, the
per-tool-call seam); they stay separate on purpose. This table is the
permanent record of the contract.

| Member | Implementation | Contract notes |
|---|---|---|
| `sessionCreate({title})` | `session.create({location, title})` | no parentID on the host API: an extraction child is a top-level session in the parent's project directory, and the runtime records the parent link in its own maps; the adapter registers the child id for event forwarding (its events carry the project directory, which the pump's directory filter would otherwise drop). A missing id throws into the extraction fallback |
| `sessionDelete(id)` | `session.remove({sessionID})` (upstream #52387) | extraction-child cleanup, so the picker stays clean and `-c` resume does not land in a child; the strand sweep deletes machinery corpses through it too |
| `promptSession(sessionID, {parts, noReply?})` | text join + `session.prompt` / `session.synthetic` | the prompt endpoint takes text, not parts; nudge injections ride the prompt hook. noReply deliveries (chat echoes, session-start reminder, re-attach notice) route to `session.synthetic({ resume: false })` - enqueued WITHOUT waking execution (live-probed 2026-11-05: no execution events, the prompt hook never fires for the item, the message materializes in history at the next turn's inbox delivery; the visible delta: the bubble appears at the session's next turn rather than instantly). All-synthetic bodies (watcher + chat wake nudges) route to the WAKING synthetic (`resume` defaults true). The noReply route keys on the flag, not the parts' synthetic flags - the chat echo's part is deliberately non-synthetic, and a flag-keyed route would fall through to `session.prompt`: a real model turn that calls chat tools, which echoes again |
| `sessionGet(id)` | `session.get({sessionID})` | metadata bag rides along (the spawn stamp `thatch.coordinatorSessionID` lives there); `time.updated` (epoch ms) feeds the wake-swallow detector |
| `sessionList()` | `session.list({directory})` | directory-scoped (live-probed 2026-11-05: the filter works, rows carry `parentID` + `time.updated` epoch ms) - the `-c` continue-target resolution wants "most recent top-level session in THIS directory" |
| `enumerateSessions()` | readonly read of opencode.db | the strand sweep needs machine-wide rows (dead-worktree sessions belong to no live instance, and the never-activated directories have no live session.list caller) - the same readonly pattern as the `-c` inheritance resolution; null on schema drift, which the sweep treats as "nothing known, do nothing" |
| `sessionMove(id, dir)` | `session.move({sessionID, directory})` | the strand sweep's self-heal for real sessions stranded in a deleted worktree; the session_tab spawn flow's worktree move uses the same member |
| `sessionMessages(id)` | `session.context({sessionID})` | mapped into the `{info: {role}, parts}` shape the alert round-derivation reads (`mapSessionContextMessages`); the promise domain's session surface has no message-list endpoint |
| `showToast(toast)` | toast rpc event | the only TUI feedback channel: the `./tui` plugin's `ui.toast.show`. Best-effort by contract (the runtime's call sites catch-and-ignore): a TUI-less environment or an rpc-less SDK floor shows nothing, silently |
| `compactSession(id)` | `session.compact({sessionID})` (upstream #52385) | the wrap-up compact action - the same core compaction the built-in /compact runs |
| `exitHost(id)` | exit-tab-closed rpc event | the wrap-up exit: the runtime records the session's watcher deaths and unregisters it from chat BEFORE this runs; the emit is a TUI-ONLY close of the session's OWN tab (upstream anomalyco/opencode#50984's ask - the daemon hosts every tab, so an app-wide exit would take down unrelated sessions). The pump deliberately never translates this event (a second death pass would erase the durable death row the first one wrote). Degrades to a logged no-op without the rpc surface; a TUI with no tab for the session never acts - the event is ephemeral |

## Hook and registration surface

| Runtime need | Host surface | Strategy |
|---|---|---|
| bus events | `event.subscribe` (raw SSE) | client-side location filter; location-less events resolve via the `sessionDirs` cache or `session.get` and drop unresolvable; events for plugin-created extraction children pass by ID; `session.moved` routes to both the old and new location's instances, so it bypasses the generic gate and lets the runtime act on its own membership |
| incoming message | `session.hook("prompt")` | the hook awaits the runtime; nudge injections append to the OUTBOUND request's user message whose text matches the entry's stored prompt, in the context hook (wire `Message` carries parts in `content`, not `parts`). Entries form a per-session set (cap 3, oldest evicted) so a prompt queued mid-turn keeps its own entry instead of evicting the running turn's; a prompt whose nudge computation comes up empty clears the session's whole set, so the running turn's remaining rounds lose their block in that one case (smaller than the staleness it prevents: an entry left behind would match its own prompt text in later requests' session history and replay a stale block there) |
| system prompt | `session.hook("context")` | mutates the request's system array; the runtime's plain strings convert to `{type: "text", text}` SystemPart objects at the boundary |
| compaction | `session.hook("compaction")` | marks the session compacting AND injects the re-familiarization system context (the compaction request carries the same mutable `system` array the context hook mutates) |
| wrap-up commands | `command.transform` + `CommandEditor.add` | registered in code: `execute` arms the greenlight check (`onCommandExecuteBefore`) and delivers the template's prompt body, substituting the invocation's prompt text for `$ARGUMENTS` (`session.prompt` does no template expansion); only ACTION command files install on disk - a file with the same name as a registered command would collide, and pre-drop wrap-up files are removed at load |
| tools | `tool.transform` + `ToolEditor.add` | `thatch_` names; input schemas pre-converted to JSON Schema with our own zod (the host's `instanceof $ZodType` detection fails for ours and drops the schema); results wrap as `{ content }` |
| tool buffering | `tool.hook("execute.after")` | feeds the extraction buffer; `Tool.Result.content` is flattened (string passes through, content-part arrays contribute their text parts); the title is derived from the tool name and args (`deriveTitle`), since `Tool.Result.output` is a typed output value, not a title |
| session tabs | rpc event bridge | `thatch_session_tab` (opencodeOnly) spawns a detached subordinate session (create -> move -> chat-register -> emit `rpc.thatch-tabs.tab-opened` -> prompt); the `./tui` CLI plugin consumes the event and calls `ui.tabs.open` (open-without-focus, idempotent). `thatch_session_tab_open` reopens a tab for an EXISTING session by emitting the SAME event behind a dead-directory guard (sessionGet + fs check in the adapter's `openTab` - a session whose checkout is gone would open the TUI's "Session location unavailable" dialog, so the tool refuses). `thatch_session_tab_close` emits `rpc.thatch-tabs.tab-closed {sessionID, chatName}` - the pump translates it into the runtime's confirmed-death path |
| redo command (/s) | keymap slash command | see the redo command section below |
| dispose | cleanup returned from `setup` | must be idempotent: the host auto-reloads plugins on file change, and a non-idempotent cleanup doubles pollers/pumps/nudges. Volatile runtime state (extraction buffer + accepted entries, child bookkeeping, wrap-up arms, watcher definitions) is journaled to the `runtime_state` table - instance-scoped by the writing location's directory - and rehydrated on the next `setup()`: rows from the same process AND directory (a reload) all restore; child rows carry a kind marker (extraction vs task-dispatched sub-agent, defaulting to extraction for pre-marker rows) so only extraction children restore the `extracting`/`extractionChildren` sets; rows from a dead process are pruned unless the session is the `-c`/`-s` startup resume, which inherits recovery-safe state only (buffer requeued, no live child bookkeeping - the child died with the old process); a dead process's journaled extraction children are also DELETED through the host before the prune. Exception: a dead process's watcher definitions are kept as DORMANT rows (no polling, no delivery) instead of pruned - resuming the session re-arms them on its first message. Restored sessions get a synthetic noReply re-attach notice (the resume:false synthetic; it materializes at the session's next turn). The chat poller re-hosts the instance's journaled hosted set on reload. The embedding model is refcounted per db path, so N location instances share one resident model |
| wake gate | event-fed status map | the host exposes no live session-status endpoint to plugins; the gate reads the compacting set and the event-fed map only, and absence from the map is not evidence of busy (the `-s` startup session is hosted from init, before it emits any status event). Known gap: in the reload window - until the session's next status event - the gate is fully open |

## The redo command (/s)

A TUI-only slash command that undoes the last exchange and resubmits the
message with a perl-style substitution applied: `/s /foo/bar/g` (the space
after `/s` is load bearing - the host's `parseSlashHead` splits the command
name at the first whitespace, so `/s/foo/bar` never reaches the command).
No LLM is involved.

- **Registration**: a keymap layer in `src/opencode/tui-plugin.ts`
  (`{id: "thatch.redo", slash: {name: "s", arguments: true}, run}`),
  additive to the existing `data.listen` setup. The name is `s` because the
  host ships a built-in `/redo` that cancels a staged undo - the recovery
  path every guard toast points at, and the opposite semantic.
- **SDK-free core**: `src/redo-shared.ts` (the session-tab-shared isolation
  pattern - zero SDK imports; the client arrives as the injected
  `RedoSessionOps` narrow interface, so the destructive-ordering invariant
  is unit-tested with mocks in `tests/redo-shared.test.ts`).
- **Engine**: JavaScript RegExp with a `u`-flag fallback (Unicode mode
  rejects some identity escapes; the second compile failure is toasted
  verbatim). `\1`-`\9` translate to `$1`-`$9`; `\n` and `\t` become
  literals; flags are the subset `g i m s u`. No `g` = first match only.
- **Guards, in order, all BEFORE the revert**: a staged undo exists
  (`revert.messageID` on the session info - a naive findLast would target
  an invisible undone message and the resubmit would commit the revert);
  pending inbox rows (the resubmit's revert commit deletes queued chat
  mail); a delivered synthetic wake newer than the target (its mail is
  stamped delivered while the commit deletes its turn - the built-in
  `/undo` has the same hole; this command is stricter one findLast away).
- **The revert trio**: `interrupt` + `wait` + `client.session.revert.stage`
  (the exact `/undo` mechanics, file-restore included), then resubmit via
  `client.session.prompt`. The paged `message.list` walk (desc, cursor)
  exists because the plugin data layer's message list is a reactive
  newest-20 window, not history.
- Known simplification: queued-prompt undo stays with the built-in (which
  calls `mutatePending("cancel")` first); a wake admitted in the
  microseconds after the pending guard reads is an accepted, bounded race.

## Live verification and remaining unknowns

The adapter was written against tagged source (v2.0.9) before a live
binary was available, then verified against a real v2.0.15 binary on
2026-09-23: default-export loading, tool schemas (via pre-converted JSON
Schema - see the gotcha), event shapes, the execution-lifecycle idle signal,
synthetic wake delivery, and command registration all work; the full QA
suite runs green against a v2 serve.

Confirmed against the live binary (probe, 2026-11-05; was "static analysis
only" before that):

- `session.hook("prompt")` does NOT fire for `session.synthetic` inbox
  items: the resume:false synthetic never wakes execution, so no model
  request exists for it. (A synthetic item with the wake - the default -
  starts an execution like any prompt.) The structural bound below still
  holds for the missed-prompt-hook edge: each `pendingInjections` entry is
  bound to the prompt text it was computed from, and the context hook
  injects it only into a request user message whose joined text equals
  that prompt - a replay onto any other message (missed prompt hook,
  failed `onChatMessage`) is skipped. Text equality is the tightest
  binding available, not an airtight one: an identical prompt re-submitted
  after a missed prompt hook still matches and replays; the next
  prompt-hook run that fires is the recovery. The prompt-time block still
  re-fires on every round of its OWN turn, and the block carries a
  snapshot footer stating the labels are a submission-time snapshot and
  pointing at the live re-check tool.
- Whether `SessionGenerate.messages` are fresh objects per model call within
  a turn. The context hook appends injections to the matched message's
  content, which changes the text the binding check compares. With fresh
  objects per call (what the tests assume), the prompt-time block re-fires
  on every round of its own turn. With reused objects, round 1's
  injections would change the matched message's text, so the binding check
  would skip rounds 2 and on - within-turn replay would break after round
  1 instead of duplicating.
- Entries outliving their session: `pendingInjections` is keyed by session
  id and never swept on session end. Bounded - a per-session set capped at
  3 entries, and the map itself dies with the adapter activation - but a
  session's entries do persist after the session is gone, pre-existing.
- Cross-directory hook dispatch scope: the event pump filters events by
  directory, but the session hooks (`prompt`, `context`, `compaction`)
  have no such filter - whether a hook can fire for another directory's
  session is unverified, pre-existing.

The wrap-up exit closes the session's own tab over the session-tab rpc
bridge. Known degrade: a TUI with no tab for the session (headless run,
tabs off) never acts - the event is ephemeral, nobody is listening.

The whole-repo drift gate (`tests/no-v1-sdk.test.ts`) enforces the
one-SDK rule: no file under src/, tests/, qa/, bin/, or package.json may
reference the v1 SDK package scope, so the v1 adapter cannot quietly
return.

## User setup compatibility

No config file moves or changes format. The DB, model cache, version-check
files, and skills dirs are host-agnostic. The dev-session shim is a plain
default-export re-export (see docs/user/setup.md); the named `server`
re-export from pre-drop shims no longer exists and fails to load.

The session-tab feature needs the DIRECTORY shim form so the TUI's plugin
discovery (directories and symlinks, never plain files) can load the
`./tui` entrypoint: `thatch/index.ts` plus `thatch/tui.ts`. DELETE the old
`thatch.ts` file in the same step - a file and a directory shim
coexisting dies with `duplicate instance plugin ids: thatch` before any
plugin code runs (the duplicate check is in activation, so nothing inside
the plugin can self-heal it).

## Source files

- `src/index.ts` -- plugin entry: default export `{ id, setup }`, lazy
  adapter import
- `src/opencode/v2.ts` -- the adapter: setup, registrations, event pump,
  HostCapabilities implementation, the session-tab host flow
- `src/opencode/tui-plugin.ts` -- the TUI CLI plugin (the `./tui`
  entrypoint: consumes the session-tab rpc events, drives `ui.tabs`,
  registers the /s redo command)
- `src/session-tab-shared.ts` -- the cross-entry session-tab contract (rpc
  definition, prompt builder, validators)
- `src/redo-shared.ts` -- the /s redo command's SDK-free core (substitution
  parser, apply engine, orchestration over injected ops)
- `tests/redo-shared.test.ts` -- the redo command's parser, apply, guard,
  and ordering tests (mocked deps)
- `src/capabilities.ts` -- `HostCapabilities`, `PromptPart`, `ToastInput`,
  `DeliverySkippedError`
- `src/runtime.ts` -- the shared runtime (all behavioral logic)
- `src/os-args.ts` -- pure argv helpers
- `tests/opencode-v2-*.test.ts` -- adapter contract tests (mocked context;
  shared fixtures in `tests/mocks/opencode-v2-harness.ts` and
  `tests/mocks/v2-harness.ts`)
- `tests/plugin-*.test.ts` -- runtime behavior tests through the v2
  harness
- `tests/session-tab-shared.test.ts` -- session-tab validators, rpc
  definition shape, TUI guard logic
- `tests/no-v1-sdk.test.ts` -- the one-SDK drift gate

## Interactions with other features

Everything downstream of the hooks is unchanged by the adapter:
[extraction.md](extraction.md), [nudge-pipeline.md](nudge-pipeline.md),
[session-lifecycle.md](session-lifecycle.md),
[cross-session-chat.md](cross-session-chat.md),
[watchers.md](watchers.md), [notifications.md](notifications.md). The MCP
path ([mcp-parity.md](../mcp-parity.md)) does not touch any of this.
