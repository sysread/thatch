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
| bus events | `event` hook | `event.subscribe` (raw SSE) | client-side location filter; location-less events drop (mirrors v1's server-side filter) |
| incoming message | `chat.message` hook | `session.hook("prompt")` | the hook awaits the runtime; injections append to `prompt.text` (v2 has no synthetic parts) |
| system prompt | `experimental.chat.system.transform` | `session.hook("context")` | mutates the request's system array; the runtime pushes a raw string where v2 types SystemPart (smoke-test-gated) |
| compaction | `experimental.session.compacting` + `.autocontinue` + `session.compacted` | `session.hook("compaction")` | flag lands; context-injection surface unverified |
| wrap-up commands | `command.execute.before` + command files | `command.transform` + `CommandEditor.add` | registered in code: `execute` arms the greenlight check (`armWrapUp`) and delivers the same prompt body the v1 file carries; the runtime installs only ACTION command files on v2 (a file and a registered command with the same name would collide) |
| tools | `hooks.tool` map via `tool()` | `tool.transform` + `ToolEditor.add` | zod shapes pass as Standard Schema; results wrap as `{ content }` |
| tool buffering | `tool.execute.after` hook | `tool.hook("execute.after")` | wired: feeds the same extraction buffer; result shape smoke-test-gated |
| noReply deliveries | `promptAsync` with `noReply` | none | gated off via `HostCapabilities.noReplyDelivery` -- chat echoes and the session-start reminder are skipped on v2 (delivering them would start real model turns: a feedback loop) |
| synthetic wake deliveries | `promptAsync` with `synthetic` parts | `session.synthetic` endpoint | watcher + chat wake nudges route to v2's synthetic endpoint (TUI-hidden), matching v1 |
| child sessions | `client.session.create/promptAsync/prompt/delete` | `session.create/prompt` | create+prompt supported (shapes smoke-test-gated; a missing id throws into the extraction fallback); delete degrades (extraction children are not cleaned up on v2) |
| session status | `client.session.status` | none | returns `{}`; the wake gate treats unknown as idle and the event-fed status map does the gating |
| session list/messages | `client.session.list/messages` | none | degrade (`-c` resume listing + wrap-up greenlight lose their data source) |
| toasts | `client.tui.showToast` | none reachable | degrade (the `tui.toast.show` event has no producer surface from the promise context) |
| TUI actions | `client.tui.executeCommand/publish` | none | degrade |
| dispose | `dispose` hook | cleanup returned from `setup` | must be idempotent: v2 auto-reloads plugins on file change, and a non-idempotent cleanup doubles pollers/pumps/nudges |

## Smoke-test-gated unknowns

The v2 adapter was written against tagged source (v2.0.9) without a live
binary. Items marked SMOKE TEST in src/opencode/v2.ts were verified against
a real v2.0.15 binary on 2026-09-23: merged-default loading, tool schemas
(via pre-converted JSON Schema - see the gotcha), event shapes, the
execution-lifecycle idle signal, synthetic wake delivery, and command
registration all work. The app-exit gap (no server-side publish surface for
`tui.command.execute`) is upstream:
[anomalyco/opencode#50984](https://github.com/anomalyco/opencode/issues/50984).
Install opencode-v2 (brew formula `anomalyco/tap/opencode-v2`; conflicts
with the v1 formula's binary name, so it cannot coexist) and re-run the QA
live suite against it.

## User setup compatibility

No config file moves or changes format. The DB, model cache, version-check
files, and skills dirs are host-agnostic and shared. opencode's own config
key (`plugin` vs `plugins`) is auto-migrated by v2. The only user-owned file
with a content change is the dev-session shim, and its new dual-shape content
loads under both hosts.

## Source files

- `src/index.ts` -- dual entry, merged default export, lazy wrappers
- `src/opencode/v1.ts` -- v1 hooks adapter
- `src/opencode/v2.ts` -- v2 promise-context adapter + capability impl
- `src/capabilities.ts` -- `HostCapabilities`, `capabilitiesFromClient`
- `src/runtime.ts` -- the shared runtime (all behavioral logic)
- `src/os-args.ts` -- pure argv helpers
- `tests/opencode-v2.test.ts` -- v2 adapter contract tests (mocked context)
- `tests/plugin.test.ts` -- v1 adapter contract tests (mocked client)

## Interactions with other features

Everything downstream of the hooks is unchanged by the dual adapter:
[extraction.md](extraction.md), [nudge-pipeline.md](nudge-pipeline.md),
[session-lifecycle.md](session-lifecycle.md),
[cross-session-chat.md](cross-session-chat.md),
[watchers.md](watchers.md), [notifications.md](notifications.md). The MCP
path ([mcp-parity.md](../mcp-parity.md)) does not touch any of this.
