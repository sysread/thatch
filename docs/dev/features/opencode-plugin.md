# Feature: OpenCode plugin dual-adapter (v1 + v2)

The opencode plugin supports both opencode lines from one npm package: the
1.18.x plugin API and the 2.x plugin API. The user's setup (shim file, config
key, DB, skills) is identical under either host.

## Architecture

```text
src/index.ts          dual entry -- merged default export { id, setup, server }
  │                     opencode v1 reads default.server; v2 reads
  │                     default.setup and strips excess keys. Both loaders
  │                     verified against tagged upstream source.
  ├── (lazy) → src/opencode/v1.ts   v1 adapter (@opencode-ai/plugin)
  └── (lazy) → src/opencode/v2.ts   v2 adapter (@opencode/plugin)
                     both delegate to:
                src/runtime.ts      shared runtime (nudges, system prompt,
                                    session events, extraction, bookkeeping)
                     ↑ consumes
                src/capabilities.ts HostCapabilities seam
```

### The isolation rule

`src/index.ts`'s static import graph must stay SDK-free. Each adapter
imports its host's SDK (`@opencode-ai/plugin` vs `@opencode/plugin`), and the
SDKs resolve only under their own host's install, so the entry reaches both
adapters exclusively through dynamic `import()`. A top-level await would make
either host's load block on (or fail from) the other host's adapter. The pure
helpers (`osProcessArgs`, `startupSessionId`, ...) live in `src/os-args.ts`,
which is safe to re-export statically.

### The export shape

Upstream loaders decide everything:

- **v1** (`packages/opencode/src/plugin/shared.ts`, `readV1Plugin`, identical
  across 1.18.0-1.18.32): reads only `mod.default`; uses `default.server` if
  present and never reaches the named-export ("legacy") fallback. Excess keys
  (like `setup`) are invisible to it. A default export with `id` but no
  `server` throws and the host SILENTLY SKIPS the plugin (error-publish is
  commented out in the upstream caller).
- **v2** (`packages/core/src/plugin/module.ts` @ v2.0.9): decodes `default`
  as `{ id, effect }` or `{ id, setup }` with Effect Schema; excess keys
  (like `server`) are tolerated and stripped (verified empirically at
  effect@4.0.0-rc.112, the version v2 pins).

So the merged object `{ id, setup, server }` satisfies both. A module with a
named `server` export plus a v2-shaped default does NOT work on v1 -- that
shape throws in `readV1Plugin`.

## The capability seam

`HostCapabilities` (src/capabilities.ts) is the interface of host operations
the shared runtime needs. It is the lifecycle-level sibling of `CoreContext`
(src/tool-defs.ts, the per-tool-call seam); they stay separate on purpose.

| Capability | v1 source | v2 source | v2 strategy |
|---|---|---|---|
| bus events | `event` hook | `event.subscribe` (raw SSE) | client-side location filter; location-less events resolve via `session.get` (`{sessionID}` input) and drop unresolvable (mirrors v1's server-side filter); events for plugin-created extraction children pass by ID (they live in the project directory, which differs from the instance directory on below-root launches) |
| incoming message | `chat.message` hook | `session.hook("prompt")` | the hook awaits the runtime; nudge injections append to the OUTBOUND request's last user message in the generate hook (v2 wire `Message` carries parts in `content`, not `parts`) |
| system prompt | `experimental.chat.system.transform` | `session.hook("context")` | mutates the request's system array; the runtime's plain strings convert to `{type: "text", text}` SystemPart objects at the boundary |
| compaction | `experimental.session.compacting` + `.autocontinue` + `session.compacted` | `session.hook("compaction")` | flag lands; context-injection surface unverified |
| wrap-up commands | `command.execute.before` + command files | `command.transform` + `CommandEditor.add` | registered in code: `execute` arms the greenlight check (`onCommandExecuteBefore`) and delivers the same prompt body the v1 file carries, substituting the invocation's prompt text for `$ARGUMENTS` (v2's `session.prompt` does no template expansion); the runtime installs only ACTION command files on v2 and REMOVES stale wrap-up files from earlier v1 runs (a file and a registered command with the same name would collide) |
| tools | `hooks.tool` map via `tool()` | `tool.transform` + `ToolEditor.add` | zod shapes pre-converted to JSON Schema with our own zod (v2's `instanceof $ZodType` detection fails for ours and drops the schema); results wrap as `{ content }` |
| tool buffering | `tool.execute.after` hook | `tool.hook("execute.after")` | wired: feeds the same extraction buffer; `Tool.Result.content` is flattened (string passes through, content-part arrays contribute their text parts); the title is derived from the tool name and args (`deriveTitle`), since v2's `Tool.Result.output` is a typed output value, not a title |
| noReply deliveries | `promptAsync` with `noReply` | none | gated off via `HostCapabilities.noReplyDelivery` -- chat echoes and the session-start reminder are skipped on v2 (delivering them would start real model turns: a feedback loop) |
| synthetic wake deliveries | `promptAsync` with `synthetic` parts | `session.synthetic` endpoint | watcher + chat wake nudges route to v2's synthetic endpoint (TUI-hidden), matching v1 |
| child sessions | `client.session.create/promptAsync/prompt/delete` | `session.create/prompt` | create+prompt supported (a missing id throws into the extraction fallback); delete rides `session.remove` (upstream #52387, in v2.0.22), runtime-guarded like compact -- an older host keeps the documented gap (the session picker accumulates one `thatch-extraction` entry per extraction, and `-c` "continue last session" logic that picks the newest top-level session will land in an extraction child after any session that triggered extraction) |
| session status | `client.session.status` | none | returns `{}`; the wake gate treats unknown as idle and the event-fed status map does the gating |
| session messages | `client.session.messages` | `session.context` | mapped into the v1 `{info: {role}, parts}` shape, so the wrap-up greenlight check works (the promise domain has no `message` accessor) |
| session list | `client.session.list` | none | degrade (`-c` resume listing loses its data source) |
| compaction trigger | `client.tui.executeCommand("session_compact")` | `session.compact({sessionID})` | wired behind a runtime guard: upstream [#52385](https://github.com/anomalyco/opencode/pull/52385) exposed `session.compact` on the promise domain (in the installed v2.0.25), newer than the pinned dev types - an older host degrades to a logged no-op (the wrap-up checklist and flush still run, the automatic compaction is skipped) |
| toasts | `client.tui.showToast` | toast rpc event | wired: every runtime toast call site (alerts, extraction metrics, chat registration, blocked wrap-ups, watcher rearm notices) emits the bridge's `toast` event, which the `./tui` plugin shows via `ui.toast.show`; the pump never translates it (TUI-only by nature). Best-effort by contract: a TUI-less environment or an rpc-less SDK floor shows nothing, silently |
| wrap-up exit | `client.tui.publish` | exit-tab-closed rpc event | the wrap-up exit records the session's watcher deaths synchronously (the runtime, before the chat unregister - `sessionDied` places the death row by the chat row, so the order is load-bearing) and then emits `rpc.thatch-tabs.exit-tab-closed`, a TUI-ONLY close of the session's OWN tab (the `./tui` plugin's `ui.tabs.close`): the tab-scoped semantic upstream [anomalyco/opencode#50984](https://github.com/anomalyco/opencode/issues/50984) asks for, since the daemon hosts every tab and `app.exit` would take down unrelated sessions. The pump deliberately never translates this event (a second death pass would erase the durable death row the first one wrote; the session_tab_close tool's `tab-closed` is the only death-translating event). Degrades to a logged no-op without the rpc surface; a TUI with no tab for the session (headless run, tabs off) never acts - the event is ephemeral |
| session tabs | n/a | rpc event bridge | `thatch_session_tab` (v2Only) spawns a detached subordinate session (create -> move -> chat-register -> emit `rpc.thatch-tabs.tab-opened` -> prompt); the `./tui` CLI plugin consumes the event and calls `ui.tabs.open` (open-without-focus, idempotent). `thatch_session_tab_close` emits `rpc.thatch-tabs.tab-closed {sessionID, chatName}` - the pump translates it into the runtime's confirmed-death path. The registration's third event, `exit-tab-closed` (the wrap-up exit's), is TUI-only - see the wrap-up exit row |
| tab close | n/a | no session.deleted on v2 tab close | bounded 2026-10-07: watcher death detection cancels a closed tab's watchers once its pending events age past `THATCH_WATCH_DEATH_MINUTES` (default 120) while deliveries throw 404-class errors, and announces the death to live same-project sessions; the roster row itself still lingers until the reaper. NOTE: an earlier version of this row claimed deliveries "fail their idle gate" - wrong: the v2 gate opens (the status stub reads as idle) and the PROMPT fails; same leak, different link |
| wake gate after reload | `session.status` event map | map rehydrates empty | known gap: v2's fetchStatuses stub is structural (the promise context has no session.status), so in the reload window - until the session's next status event - the proactive-prompt gate is fully open |
| dispose | `dispose` hook | cleanup returned from `setup` | must be idempotent: v2 auto-reloads plugins on file change, and a non-idempotent cleanup doubles pollers/pumps/nudges. Volatile runtime state (extraction buffer + accepted entries, child bookkeeping, wrap-up arms, watcher definitions) is journaled to the `runtime_state` table - instance-scoped by the writing location's directory - and rehydrated on the next `setup()`: rows from the same process AND directory (a reload) all restore; child rows carry a kind marker (extraction vs task-dispatched sub-agent, defaulting to extraction for pre-marker rows) so only extraction children restore the `extracting`/`extractionChildren` sets; rows from a dead process are pruned unless the session is the `-c`/`-s` startup resume, which inherits recovery-safe state only (buffer requeued, no live child bookkeeping - the child died with the old process). Exception: a dead process's watcher definitions are kept as DORMANT rows (no polling, no delivery) instead of pruned - resuming the session re-arms them on its first message (a `chat.message` scan: own rows re-arm, same-directory rows of still-dead sessions earn the live session a one-line death notice gated on the owning pid being dead, rows past the watcher TTL plus a 24h grace age out). Restored sessions on v1 get a synthetic noReply re-attach notice (v2 has no turn-free delivery and skips it). The chat poller re-hosts the instance's journaled hosted set on reload, so pending chat mail wakes sessions the reload left asleep and heartbeats keep the reaper from reaping live registrations. The embedding model is refcounted per db path, so N location instances share one resident model |

## Live verification and remaining unknowns

The v2 adapter was written against tagged source (v2.0.9) before a live
binary was available, then verified against a real v2.0.15 binary on
2026-09-23: merged-default loading, tool schemas (via pre-converted JSON
Schema - see the gotcha), event shapes, the execution-lifecycle idle signal,
synthetic wake delivery, and command registration all work; the full QA
suite runs green against a v2 serve.

Still unverified against the live binary (static analysis only):

- Whether `session.hook("prompt")` fires for `session.synthetic` inbox
  items. If it does not, `pendingInjections` from the prior real turn gets
  appended to the synthetic turn's outbound request.
- Whether `SessionGenerate.messages` are fresh objects per model call within
  a turn. If not, the generate hook pushes duplicate nudges on every tool
  round trip.
- An npm-installed copy (not the dev checkout, which has devDependencies
  present) loading under v2 - the isolation rule's real-world proof.

The wrap-up exit closes the session's own tab over the session-tab rpc
bridge - the tab-scoped close upstream
[anomalyco/opencode#50984](https://github.com/anomalyco/opencode/issues/50984)
asks for. Known degrade: a TUI with no tab for the session (headless run,
tabs off) never acts - the event is ephemeral, nobody is listening.
Install opencode-v2 (brew formula `anomalyco/tap/opencode-v2`; conflicts
with the v1 formula's binary name, so it cannot coexist) and re-run the
QA live suite against it.

## User setup compatibility

No config file moves or changes format. The DB, model cache, version-check
files, and skills dirs are host-agnostic and shared. opencode's own config
key (`plugin` vs `plugins`) is auto-migrated by v2. The only user-owned file
with a content change is the dev-session shim, and its new dual-shape content
loads under both hosts.

The session-tab feature adds a second user-owned artifact: the TUI-side
plugin entry. A local FILE plugin shim carries a `server` entrypoint only
(v2's `plugin/module.ts`), and the TUI's plugin discovery loads directories
and symlinks, never plain files - so the dev-checkout install must be a
DIRECTORY shim: `thatch/index.ts` (the dual-shape re-export, unchanged) plus
`thatch/tui.ts` (re-exporting the TUI plugin). DELETE the old `thatch.ts`
file in the same step - a file and a directory shim coexisting dies with
`duplicate instance plugin ids: thatch` before any plugin code runs (the
duplicate check is in activation, so nothing inside the plugin can
self-heal it).

## Source files

- `src/index.ts` -- dual entry, merged default export, lazy wrappers
- `src/opencode/v1.ts` -- v1 hooks adapter
- `src/opencode/v2.ts` -- v2 promise-context adapter + capability impl
- `src/opencode/tui-plugin.ts` -- v2 TUI CLI plugin (the `./tui` entrypoint: consumes the session-tab rpc events, drives `ui.tabs`)
- `src/session-tab-shared.ts` -- the cross-entry session-tab contract (rpc definition, prompt builder, validators)
- `src/capabilities.ts` -- `HostCapabilities`, `capabilitiesFromClient`
- `src/runtime.ts` -- the shared runtime (all behavioral logic)
- `src/os-args.ts` -- pure argv helpers
- `tests/opencode-v2.test.ts` -- v2 adapter contract tests (mocked context)
- `tests/session-tab-shared.test.ts` -- session-tab validators, rpc definition shape, TUI guard logic
- `tests/plugin.test.ts` -- v1 adapter contract tests (mocked client)

## Interactions with other features

Everything downstream of the hooks is unchanged by the dual adapter:
[extraction.md](extraction.md), [nudge-pipeline.md](nudge-pipeline.md),
[session-lifecycle.md](session-lifecycle.md),
[cross-session-chat.md](cross-session-chat.md),
[watchers.md](watchers.md), [notifications.md](notifications.md). The MCP
path ([mcp-parity.md](../mcp-parity.md)) does not touch any of this.
