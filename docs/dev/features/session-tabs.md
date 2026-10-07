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
  auto-register converges on the same name. `validateTitle` rejects the
  machinery title so `isMachinerySessionTitle` can never misfire.
- **The worktree flow boots a second per-location thatch instance** (shared
  db): the subordinate's pollers, nudges, extraction, wrap-up, and alerts
  run in the worktree location's instance, and chat wake for the idle
  subordinate depends on that instance being alive.

## The cross-entry contract

`src/session-tab-shared.ts` (SDK-free, per the isolation rule in
`src/index.ts`) holds the rpc definition (`thatch-tabs`: `tab-opened`,
`tab-closed` - the latter reserved for the deferred close tool and consumed
by the generalized-session-heartbeat plan), the subordinate prompt builder,
and the validators. The TUI entrypoint may import only
`@opencode/plugin/tui` and this module.

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
  guard logic), `tests/opencode-v2.test.ts` (the execute flow's ordering via
  the `makeContext` double with `session.move` + the `rpc` domain).
- QA: uc-059 (tool list + MCP leak check), uc-014/uc-060 (skill counts).
- Live smoke: spawn from a real TUI (tab appears, subordinate runs,
  worktree + temp-dir cases, headless no-tab, tabs-off no-tab) - see the
  plan's Test plan for the numbered scenarios.
