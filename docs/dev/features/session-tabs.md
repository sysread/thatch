# Session tabs (coordinated subordinates)

## What it does

`thatch_session_tab` (opencode v2 only) lets a coordinating LLM spawn a
detached subordinate LLM session in a new TUI tab. The subordinate is a full
peer session: it runs its own agent loop across many turns, in a directory
of the coordinator's choosing, while the coordinator keeps working. The user
sees the subordinate's tab appear beside the coordinator's, unfocused.

This is NOT the `task` tool: task subagents run inside the dispatcher's turn
and return their result inline. A tab subordinate outlives the dispatching
turn and is supervised over cross-session chat.

## How it works

```text
coordinator session (LLM)
  |  tool call: thatch_session_tab {prompt, title, worktree|directory}
  v
v2 adapter (src/opencode/v2.ts, buildSessionTabHost via CoreContext.sessionTabHost)
  |  validate (tool-defs: title, exactly-one location arg, fs existence,
  |            worktree same-main-checkout identity)
  |  1. session.create({title, metadata: {thatch: {...}}, location})
  |  2. worktree flow: session.move({directory: worktree})  (idle -> steer = immediate)
  |  3. db.registerChatSession(subordinate)   (participant, never machinery-marked)
  |  4. rpc emit rpc.thatch-tabs.tab-opened {sessionID, directory}
  |  5. session.prompt({text: preamble + task})
  v
SSE event feed (isOpenCodeEvent passes rpc.*; fans out across all locations)
  v
TUI CLI plugin (src/opencode/tui-plugin.ts, loaded from package exports "./tui")
  |  data.listen -> type filter -> directory guard (mirrors the built-in
  |  tui.* handlers: the event routes by the coordinator instance's
  |  directory) -> data.session.sync -> ui.tabs.open(sessionID)
  v
Tab strip: subordinate tab appears, unfocused
```

Key properties:

- **v2-only by construction.** The ToolDef carries `v2Only: true`; the v1
  adapter (`src/tools.ts`) and the MCP server (`src/mcp.ts`) filter it. The
  system prompt lists the tool only when the runtime is built with
  `v2Tools: true` - a prompt listing a nonexistent tool is the
  first-call-mistake class.
- **The event routes by the coordinator's location**, so the tab opens in
  the coordinator's window under any `tabs.scope` - even when the session
  lives in a worktree or temp dir. Tab ownership is by window, not by
  session location.
- **The move precedes the emit**: a failed move leaves no stranded open tab
  (placement is identical either way because routing is by coordinator
  location).
- **No ack**: a headless run, a connecting TUI, or `tabs.mode: off` means
  the event lands nowhere (harmlessly). The tool response says "tab
  requested"; the session exists and is findable in the sessions list
  regardless.
- **The subordinate is a chat participant**, deliberately never marked
  machinery: pre-registration (idempotent, like an explicit chat_register)
  gives the coordinator its chat name in the tool response, and the
  auto-register converges on the same name. Gated on the chat-enabled
  config like every other registration path: with chat off the
  subordinate still spawns, but no roster row is written and the tool
  response reports no chat name. `validateTitle` rejects the
  machinery title so `isMachinerySessionTitle` can never misfire. A
  mid-flow failure (create, move, emit, prompt) throws with the created
  session id and the completed steps in the message - v2 has no session
  delete, so the stranded session can at least be named and reported.
- **The worktree flow boots a second per-location thatch instance** (shared
  db): the subordinate's pollers, nudges, extraction, wrap-up, and alerts
  run in the worktree location's instance, and chat wake for the idle
  subordinate depends on that instance being alive. The watcher poller
  handoff is per location (`WatcherRegistry.#live` is keyed by directory):
  the subordinate's instance booting never stops the coordinator's
  poller - each location's instance polls only its own directory's
  watchers. The pump caches the subordinate's location from the
  tab-opened payload's directory field (its final, post-move directory),
  never from the rpc envelope's location stamp (that is the publisher's
  directory), so the subordinate's location-less execution events route
  to the instance that owns it.

## The cross-entry contract

`src/session-tab-shared.ts` (SDK-free, per the isolation rule in
`src/index.ts`) holds the rpc definition (`thatch-tabs`: `tab-opened`;
`tab-closed` - emitted by the close tool (below) and translated by the v2
pump into the runtime's confirmed-death path; `exit-tab-closed` - the
wrap-up exit's TUI-only close, which the runtime records the exit's deaths
itself before emitting, so the pump deliberately never translates that
one; and `toast` - every runtime toast's TUI-only feedback channel), the
subordinate prompt builder, and the validators. The TUI entrypoint may
import only `@opencode/plugin/tui` and this module.

## Interactions

- **Chat**: the subordinate registers in its final directory's repo slug (a
  worktree resolves to the main checkout's slug), so coordinator and
  subordinate share a chat scope across the move.
- **Extraction/wrap-up/alerts**: the subordinate is a normal session owned
  by its location's instance; the coordinator observes it via chat, not the
  event pump (its post-move events fail the pump's directory filter
  deliberately - the `childSessions` forwarding set is for extraction
  children, and adding moved sessions would double-process their events).
- **Session metadata**: the created session carries
  `metadata.thatch.{coordinatedBy, coordinatorSessionID, worktree?}`. The
  host inherits parent metadata onto children - the subordinate's own
  extraction children carry the marker too; treat inherited markers as
  inherited, not first-party.

## Closing a subordinate's tab

`thatch_session_tab_close {session}` (the target: the subordinate's chat
name or session id, resolved name-first through the chat roster) emits
`rpc.thatch-tabs.tab-closed {sessionID, chatName?}` over the same rpc
bridge. The TUI plugin consumes it symmetrically with open: the directory
guard applies, and `ui.tabs.close(sessionID)` closes the tab in every
window showing one (windows not showing it no-op). Close is TAB-LEVEL: the
session survives, the strip's reopen stack can restore it, and chat history
is untouched.

Two consumers ride the event: the death-detection machinery
(generalized-session-heartbeat) treats a tool-initiated close as a
CONFIRMED close - the closed session's watchers cancel immediately instead
of waiting on the 2h delivery-failure heuristic - and the coordinator's own
workflow closes dispatched subordinates once their work is verified. The
pump routes the close by the CLOSED session's own directory (resolved from
the pump's session-location cache, or live through the session API), not
by the event's location stamp: the stamp names the publishing coordinator
instance, while the watchers and status bookkeeping live in the instance
that owns the session - its post-move location.

## Install requirement (the `./tui` entrypoint)

A local FILE plugin shim gets a `server` entrypoint only
(`packages/core/src/plugin/module.ts` at v2), and the TUI's plugin discovery
loads directories and symlinks, never plain files. The dev-checkout install
must therefore be a directory shim (`thatch/index.ts` + `thatch/tui.ts`),
and the old file shim must be DELETED in the same step - coexisting shims
die with `duplicate instance plugin ids: thatch` before any plugin code can
run. npm installs need the `exports` map to include `.` (the bare-specifier
path) alongside `./tui`, and `@opencode/plugin` is an optional peer
dependency for the TUI entry's runtime resolution.

## Testing

- Unit: `tests/session-tab-shared.test.ts` (validators, definition shape,
  guard logic), `tests/opencode-v2.test.ts` (the execute flows' ordering via
  the `makeContext` double with `session.move` + the `rpc` domain).
- QA: uc-059 (tool list + MCP leak check), uc-014/uc-060 (skill counts),
  uc-119 (the live spawn flow through the docker sandbox).
- Live smoke (recorded 2026-10-08, ALL SCENARIOS PASSED): headless legs -
  directory variant, worktree variant (the move persisted in the session
  row + metadata), headless no-tab; TUI-visual legs (a real container
  attach) - the subordinate's tab appeared unfocused, the title rendered,
  the subordinate responded, and the persisted strip state matched; kill +
  re-attach restored both tabs (restart persistence). Sandbox note: mkdir
  the /qa host dir BEFORE `docker run -v` - a missing host path is created
  inside the Docker VM, invisible to the mac.
