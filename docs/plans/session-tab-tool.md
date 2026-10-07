# Plan: session-tab tool (coordinated subordinate sessions in the opencode v2 TUI)

## Synopsis

A new `thatch_session_tab` tool, available only on opencode v2, that lets a
coordinating LLM spawn a subordinate LLM session in a new TUI tab. The tool
creates the session, pre-assigns its thatch chat name, delivers a task prompt
framed with the coordinator's authority, and asks the user's TUI to open a tab
for it. A companion `thatch-coordination` skill defines the coordinator role.
Tab closing, config-gated visibility, and ack round-trips are deliberately
deferred.

## Reviewer orientation

This plan adds one tool, one TUI-side plugin, one shared module, one skill,
and one package export. The tool spawns a detached peer session (not a `task`
subagent); the only host-reachable way to make a tab appear is an rpc event
consumed by a TUI CLI plugin. Everything below was verified against the
opencode v2 sources. Read the Decisions table first; the Verified host
mechanics section carries the source pointers.

## Background

opencode v2's TUI has tmux-like session tabs (cwd-scoped by default). Today a
subordinate session exists only as a child of the dispatcher's turn (the
`task` tool, which blocks the parent's turn and returns its result inline) or
as an unmanaged top-level session the user happens to open. There is no path
for an LLM to hand work to a detached session the user can watch in the tab
strip.

This feature closes that gap for coordination workflows: the coordinator
decomposes work, spawns one detached session per piece, supervises each over
cross-session chat, and tracks them in its own task list. The tab strip is the
user's window into the fleet.

All opencode v2 mechanics cited here were verified against the installed tag
`v2.0.15` and the `origin/v2` branch tip (`82bb5ff88a`) in
`/Users/jeff.ober/dev/opencode`. The opencode working tree sits on `dev`, so
host code must be read via `git show origin/v2:<path>` or the tag.

## Verified host mechanics

These are the load-bearing facts. Each carries its source pointer so an
implementer can re-derive it.

### Tab primitives live in the TUI, reachable only from a CLI plugin

The tab strip is TUI-local state. The v2 CLI-plugin surface
(`packages/plugin/src/tui/context.ts`, the `UI` interface) exposes exactly the
primitives needed:

```ts
context.ui.tabs.enabled(): boolean
context.ui.tabs.open(sessionID): boolean      // opens a tab WITHOUT focusing it
context.ui.tabs.focus(sessionID): boolean     // opens when needed, then focuses
context.ui.tabs.move(sessionID, index): boolean
context.ui.tabs.close(sessionID?): boolean
```

`open` is idempotent: it returns early when the session already has a tab
(`packages/tui/src/context/session-tabs.tsx`, `open(sessionID)`). The
open-without-focus semantics were built deliberately for background tabs
(upstream PR #48129, "decompose tab controls", whose docs use a
`backgroundSessionID` variable). CLI plugins load from a plugin package's
`./tui` entrypoint and import `@opencode/plugin/tui` (resolved at runtime by
the host). Documented at `opencode.ai/v2/docs/build/plugins/cli`.

### The server-to-TUI bridge is an rpc event

A server-side v2 plugin cannot publish `tui.*` events: the plugin event domain
is subscribe-only (`packages/plugin/src/promise/event.ts`), and the v2 HTTP
surface has no event-publish or TUI route at all (the `event` group is
subscribe-only; a sweep of all protocol route groups finds zero `tui`
endpoints). The sanctioned publish channel is
`context.rpc.register(definition)`: the returned registration's
`events.emit(name, data)` publishes an ephemeral `rpc.<definitionID>.<name>`
bus event, tagged with the REGISTERING plugin instance's location — the
emitter cannot choose the location (`packages/core/src/rpc.ts`; upstream
PR #46105 introduced rpc custom events as the designed channel, "location-
scoped implementations... subscribe through the existing event stream").

The server's SSE event feed forwards it to every client:
`isOpenCodeEvent` passes any type starting with `rpc.`
(`packages/protocol/src/groups/event.ts:68`; the endpoint description says
events fan out "across all server locations"). The TUI CLI plugin receives it
via `context.data.listen(...)` and applies the same directory guard the
built-in `tui.*` handlers use: the event's `location.directory` must match the
window's directory (`packages/tui/src/app.tsx`, the `tui.*` handler block).
That guard is a convention copied from the built-ins, not a documented
contract — its upstream rationale is unrecorded.

Consequence: the event always routes to windows at the COORDINATOR's
directory, so the tab always opens in the coordinator's window (and any
sibling window at the same directory), regardless of where the created
session lives. Tab ownership is by window, not by session location — under
`scope: cwd` the entry lands in the window's own cwd bucket; under `scope:
global` in the single global bucket.

### Session creation, moving, and prompting carry everything the tool needs

- `context.session.create({ title, metadata, location })` accepts a title, a
  free-form host-owned metadata record
  (`packages/schema/src/session-metadata.ts`: "durable and opaque to core";
  children and forks INHERIT the parent's metadata), and a directory.
  Location defaults to the plugin instance's directory, which is the calling
  session's cwd.
- `context.session.prompt({ sessionID, text })` durably admits the message
  and schedules the agent loop without waiting for it (fire-and-forget). The
  v2 prompt input takes a single `text` string, not parts — the adapter's
  existing `promptSession` already joins text parts with `\n\n` into one
  body for this reason (`src/opencode/v2.ts`, the capabilities block).
- `context.session.move({ sessionID, directory })` moves a session to another
  project directory. The server's move defaults `delivery` to `"steer"`
  (`packages/core/src/session/move.ts`), which on an idle session applies
  immediately. The move validates the destination itself
  (`DestinationNotFoundError`, `DestinationNotDirectoryError`,
  `DestinationUnavailableError` — the probe boots the destination's instance
  context, which is itself load-bearing, see Blast radius).

### Tabs config is NOT readable from the plugin, and does not need to be

The tabs settings (`tabs.mode`, `tabs.scope`) live only in
`~/.config/opencode/cli.json` plus the `OPENCODE_CLI_CONFIG_CONTENT` env
override. The TUI reads nothing from `opencode.json`
(`packages/tui/src/app.tsx`: `Config.resolve(input.config.get())`). A plugin
cannot replicate this resolution: it would need the per-window environment of
each TUI process, and the plugin runs in the daemon's worker thread with the
daemon starter's env (direnv per-repo overrides are invisible).

The design therefore avoids config detection entirely (see Decisions).

### Worktree chat scoping already works

Chat sessions register by repo slug. `detectRepo` (`src/git.ts`) resolves
`git remote get-url origin` inside a linked worktree to the same slug as the
main checkout, and `resolveMainCheckout` (parent of
`git rev-parse --git-common-dir`) gives worktree-to-main identity. A
coordinator in the root checkout and a subordinate moved into a worktree land
in the same chat scope. No new plumbing.

## Decisions

| Decision | Rationale |
|----------|-----------|
| v2-only via a `v2Only` flag on `ToolDef`, following the `opencodeOnly` precedent | Mirrors the established filter idiom (`mcp.ts` `opencodeOnly` filter; `get_extraction_payload`'s host-gated execute). Keeps the tool inside `TOOL_DEFS`, so the registration-invariant tests (counts, names, MCP surface) keep covering it. A bespoke registration path was rejected: it escapes those tests and forks the registration idiom. |
| The tool's host needs ride a `sessionTabHost?` optional seam on `CoreContext` | Same pattern as `watchers?` and `chatDerivedIdentity?`: an optional field wired only by the adapter that can support it. The v2 adapter closes over its plugin context (create/prompt/move/emit); the shared execute stays host-agnostic and degrades with a clear message where the seam is absent. |
| Two optional location args (`worktree`, `directory`), exactly one required | Avoids reading tabs config. The tab co-locates with the coordinator under any `tabs.scope` either way (see Verified mechanics); the args differ in validation and intent, not in tab placement. The coordinating LLM picks per its judgement. |
| `worktree` flow: create at coordinator cwd, move, emit tab-open, then prompt | The tab-open event routes by the COORDINATOR's location, so emitting after the move places the tab in the coordinator window's bucket identically — while a failed move no longer strands an open, empty tab. The move targets an idle session, so it applies immediately (steer default), and the subordinate's whole first turn runs in the worktree (upstream #48129's "loads location metadata when an open session moves" test shows the strip tolerates moves; smoke test 3 remains the gate). |
| `worktree` validation by main-checkout identity, not path equality | The coordinator may itself run in a worktree. Validate `resolveMainCheckout(worktreeDir)` equals the coordinator's own main checkout, reusing `src/git.ts` helpers and comparing realpaths (macOS `/tmp` resolves to `/private/tmp`). |
| Do NOT add the subordinate to the v2 adapter's `childSessions` forwarding set | That set exists for plugin-created extraction children and below-root launches (`v2.ts` comments; the moved-session case never existed when it was designed). Adding the subordinate would make two instances process its events (double nudges, double extraction dispatch). The worktree-location instance owns the subordinate's machinery after the move. |
| Tab-open signal is an rpc event, consumed by a TUI CLI plugin | The only server-to-TUI channel available (the event domain is subscribe-only; no HTTP publish route exists). |
| `ui.tabs.open`, not `focus` | Opening without stealing focus keeps the coordinator on screen. The user switches when ready. Idempotent, so no dedupe state is needed in the plugin. |
| Pre-register caller and subordinate chat names in the tool | `registerChatSession` is idempotent and reclaims existing names, so the tool response can carry the subordinate's chat name and the preamble can name the coordinator. The auto-register path does not toast or rename for an already-registered session, so the pre-registration is invisible to the subordinate's first turn. |
| Title: required, soft target 50 chars, hard max 80 | opencode imposes no schema constraint (title is an unbounded optional string) and the strip truncates visually. A hard fail at 50 buys nothing and costs retry friction. |
| Preamble in the first user message; no subordinate skill | Per the original ask. The tool composes the framing text with the coordinator's chat name; the subordinate needs no skill because the preamble carries its instructions. |
| Durable metadata marker on the created session | `metadata: { thatch: { coordinatedBy, coordinatorSessionID, worktree? } }`. Cheap archaeology, and the hook for future hardening (durable tab-open recovery). Note: the host inherits parent metadata on children — the subordinate's own extraction children will carry the marker too; no code reads it today. |
| The tool response reports "tab requested", never "tab opened" | There is no ack path: a headless run, a still-connecting TUI, or `tabs.mode: off` all mean the event lands nowhere (harmlessly). The session exists regardless and remains findable in the sessions dialog. A retry after the user manually closed the tab re-opens it — consistent with "requested" wording. |
| `thatch-coordination` ships in `OPENCODE_ONLY_SKILLS` | Its core instruction is dispatching `thatch_session_tab`, which exists only on opencode v2. `SHARED_SKILLS` would install it for Claude Code and Cursor users with no such tool; `OPENCODE_ONLY_SKILLS` (today only `thatch-code-review`) is the closest existing bucket. The skill's description states the v2 requirement. v1 opencode users also lack the tool; the description covers that too. |
| Ship a `./tui` package entrypoint; convert the local shim to a directory; DELETE the file shim | Local plugin FILES get a `server` entrypoint only (`packages/core/src/plugin/module.ts`), and the TUI's plugin discovery accepts directories and symlinks, never plain files (`packages/tui/src/plugin/discovery.ts`). The current install shim `~/.config/opencode/plugins/thatch.ts` is a file and cannot carry a `tui` entrypoint. Adding the directory shim WITHOUT deleting the file shim kills plugin activation outright: opencode dies on `duplicate instance plugin ids: thatch` before any plugin code runs, so the migration cannot self-heal from inside the plugin — it is a documented, explicit install step (and a `thatch setup` CLI step if the setup CLI grows shim management). |
| The rpc event schema is a literal JSON Schema object | `PortableEventValueSchema` accepts `StandardSchemaV1` or a JSON Schema object with `type: "object"` (a zod object would also qualify). A literal object keeps the shared module dependency-free. |
| The TUI plugin returns its `data.listen` unsubscribe as its Cleanup | Hot reload runs cleanup-then-setup with fresh state; an unsubscribed listener would leak one per reload. Dedupe Sets are dead weight (`ui.tabs.open` is idempotent), so the plugin keeps no state. |

## Architecture

### Module layout

```text
src/tool-defs.ts              adds the thatch_session_tab ToolDef (v2Only: true)
                              and the sessionTabHost? seam on CoreContext
src/opencode/v2.ts            wires sessionTabHost (closes over the plugin context:
                              session.create/prompt/move, rpc register + emit);
                              filters v2Only defs out of nothing (v2 registers ALL defs)
src/tools.ts                  v1 adapter: filters v2Only defs out of createTools
src/mcp.ts                    filters v2Only defs out of tools/list and dispatch
                              (the def carries v2Only only — NOT opencodeOnly —
                              so the filter test is `opencodeOnly || v2Only`)
src/session-tab-shared.ts     NEW: SDK-free module: rpc definition (JSON Schema literal),
                              prompt builder, validators
src/opencode/tui-plugin.ts    NEW: TUI CLI plugin (imports @opencode/plugin/tui + the shared rpc definition)
src/git.ts                    exports pathExists (module-private today) for reuse
artifacts/skills/thatch-coordination.md   NEW: the coordinator role skill
package.json                  adds exports { ".", "./tui" } (no exports field exists today)
```

`session-tab-shared.ts` must stay SDK-free under the same isolation rule as
`src/index.ts`: both the server entry and the TUI entry import it, and the
TUI entry may only import `@opencode/plugin/tui` and this module. The prompt
builder and validators could live in `src/prompts.ts` / `src/tool-defs.ts`
by house convention, but co-locating them with the rpc definition in one
shared module keeps the cross-entry contract in one file; if the module grows
beyond those three concerns, split it along the existing house lines.

### The rpc definition

```ts
// session-tab-shared.ts (shape, not final code)
{
  id: "thatch-tabs",
  methods: {},
  events: {
    "tab-opened": {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, directory: { type: "string" } },
        required: ["sessionID", "directory"],
      },
    },
  },
}
```

The event type on the wire is `rpc.thatch-tabs.tab-opened`. The schema is a
literal JSON Schema object (`PortableEventValueSchema` accepts exactly that),
so both the server (emit) and the TUI (consume, via `data.listen` filtering
on the type string — a cast, since `rpc.*` types are not in the client event
union) share one definition. `register(definition, handlers)` requires the
handlers argument; pass `{}` for an events-only definition.

A second event is RESERVED in the same definition for the deferred
tab-close tool, designed jointly with the generalized-session-heartbeat plan
(branch `generalized-session-heartbeat`), whose death-detection consumes it
as an instant confirmed-close signal for tool-initiated closes:

```ts
"tab-closed": {
  schema: {
    type: "object",
    properties: {
      sessionID: { type: "string" },
      chatName: { type: ["string", "null"] },
    },
    required: ["sessionID", "chatName"],
  },
}
```

`chatName` is nullable because the chat row may have been reaped; the
heartbeat plan imports this definition rather than duplicating the schema.
User-initiated closes are deliberately NOT detected here (that would need a
standing reactive diff of `ui.tabs.list()` in every TUI window) — the
heartbeat plan's delivery-persistence heuristic covers them.

### Tool spec

`thatch_session_tab` args:

| Arg | Required | Spec description (summary) |
|-----|----------|---------------------------|
| `prompt` | yes (zod + runtime) | The task for the subordinate. Delivered as its first user message. |
| `title` | yes (zod max 80 + runtime) | Short session title, about 50 characters; renders in the tab strip. |
| `worktree` | one of `worktree`/`directory` | Path to a git worktree of the current repository. The subordinate runs there; its tab opens in this window's tab strip. Preferred for repo work. |
| `directory` | one of `worktree`/`directory` | Any existing directory. Use for unrelated locations (temp dirs, other checkouts). The tab opens in this window's strip regardless of where the directory is. |

Exactly one of `worktree`/`directory` must be present; a clear validation
error says which rule was violated. Both variants open the tab in the
coordinator's window: the tab-open event carries the coordinator instance's
location, which is what routes it.

### Execute flow

```text
validate args (exactly-one location arg; fs check; title length)
worktree? resolveMainCheckout(worktree) == own    -> else reject
resolve caller's chat name (db lookup; falls back to the session id)
session.create({ title,
                 metadata: { thatch: { coordinatedBy, coordinatorSessionID, worktree? } },
                 location: worktree flow ? own cwd : { directory } })
worktree flow: session.move({ sessionID, directory: worktree })
registerChatSession(created, finalDirectory)      -> subordinate chat name
rpc.events.emit("tab-opened", { sessionID, directory })
session.prompt({ sessionID, text: preamble + prompt })   # one text body
return "registered as <subordinateName> ... tab requested ..."
```

Ordering notes: the caller's chat name is resolved in the tool (it has the
db handle). The subordinate's registration lands AFTER the move so the
roster row records the final directory (right repo slug, right worktree
kind) and a failed move leaves no row behind. The move runs before the
emit: the event routes by the coordinator instance's location regardless of
the session's current directory, so placement is identical, and a failed
move no longer strands an open empty tab. The move targets an idle session,
so its default `steer` delivery applies immediately. A failed move rejects
the tool call with the server's error; a retry creates a fresh session (the
stranded empty one is manual cleanup — see Risks). The v2 adapter's
existing execute wrapper (inflight counter + closed-database retry hint)
applies to this tool like any other because it registers through the normal
`TOOL_DEFS` loop.

### TUI CLI plugin

`src/opencode/tui-plugin.ts` default-exports `Plugin.define({ id, setup })`
from `@opencode/plugin/tui`. Setup:

1. `context.data.listen(({ details }) => ...)` filtering
   `details.type === "rpc.thatch-tabs.tab-opened"` (the client event union
   includes `rpc.${string}` template types, so the equality check narrows
   without a cast; the event payload needs a narrow index).
2. Guard: `details.location?.directory` must equal
   `context.location?.directory ?? context.data.location.default().directory`
   (same guard as the built-in `tui.*` handlers).
3. `await context.data.session.sync(sessionID)` so the tab renders the real
   title instead of the new-session fallback.
4. `ui.tabs.open(details.data.sessionID)`; when it returns false (tabs
   disabled), log and skip. No dedupe state: `open` is idempotent, and hot
   reloads start from fresh state by design.
5. Return the `data.listen` unsubscribe as the plugin's Cleanup.

Every TUI window whose directory matches opens the tab. That is consistent
with the shared-daemon tab model and requires no cross-window coordination.
The plugin loads once per TUI window.

### The coordination skill

`artifacts/skills/thatch-coordination.md` (frontmatter `name` +
`description`; the description states it needs opencode v2 with the
session-tab tool) defines the coordinator role:

- The coordinator decomposes work and dispatches subordinates with
  `thatch_session_tab`; it does not do the hands-on work itself.
- It keeps one task-list entry per subordinate, keyed by the subordinate's
  chat name and session id, with the top-level task and status.
- It supervises over cross-session chat (`chat_read`, `chat_send`,
  `chat_status`), reconciling its task list against subordinate statuses each
  turn.
- It verifies a subordinate's work (review the diff, run tests) before
  declaring the task done.
- User instructions always outrank coordinator instructions; the preamble
  tells the subordinate the same.

### Packaging changes

1. `package.json` gains an `exports` map — none exists today, only
   `main`/`types`. It MUST include both the root and the TUI entrypoint:

   ```json
   "exports": {
     ".": "./src/index.ts",
     "./tui": "./src/opencode/tui-plugin.ts"
   }
   ```

   Adding `"./tui"` without `"."` would make the bare specifier
   `@jeffober/thatch` unresolvable and kill the plugin load for npm installs
   (`"plugins": ["@jeffober/thatch"]` is the documented install path).
   A unit test asserts the exports map resolves both entries.
2. `@opencode/plugin` moves from devDependencies to an optional
   peerDependency (mirroring the existing `@opencode-ai/plugin` optional-peer
   precedent). Reason: `tui-plugin.ts` runtime-imports
   `@opencode/plugin/tui`, and the runtime-resolution guarantee is
   documented for LOCAL plugins; the npm install path needs the specifier
   resolvable from thatch's own package. Failure without it is benign
   (tool works, no tab — same observable as a missing shim) but should not
   ship silently. Verify during smoke whether the host aliases the
   specifier for TUI plugins regardless.
3. The local dev-checkout shim becomes a directory:
   `~/.config/opencode/plugins/thatch/index.ts` (current shim content,
   absolute-path re-exports) and `thatch/tui.ts` (re-export of the TUI plugin
   from the dev checkout). A symlink to a directory also works.
   **The old `thatch.ts` file shim must be DELETED in the same step** —
   coexisting shims kill plugin activation (`duplicate instance plugin ids: thatch`
   fires before any plugin code can run, so this cannot self-heal). The user
   docs (`docs/user/setup.md`) carry the conversion as an explicit step with
   that warning.

## Blast radius and consumers

- `TOOL_DEFS` consumers (all four enumerated): the v1 adapter
  (`src/tools.ts`), the v2 adapter (`src/opencode/v2.ts`), the MCP server
  (`src/mcp.ts`), and the registration-invariant tests. The `v2Only` flag is
  consumed by two of the four; the count-bearing tests are updated in the
  same change.
- The `thatch` session-metadata key: nothing reads session metadata today;
  the host inherits it onto the subordinate's children. Future consumers
  must not treat inherited markers as first-party.
- The `rpc.thatch-tabs` definition id: per-location registrations are stored
  per instance in an array keyed by definition id, so two plugin instances
  (coordinator location + worktree location) cannot collide; dispose removes
  only its own entry. Every thatch instance's event pump receives the
  `rpc.*` event and drops it in the event translation's default case —
  harmless; the drop happens after the pump caches the event's
  sessionID-to-directory mapping, which is how the coordinator's instance
  learns the subordinate's post-move location for its event filter.
- The worktree move boots a SECOND thatch runtime for the worktree location
  in the daemon process (per-location plugin instances, shared database —
  the designed multi-instance mode): its own pollers, event pump, nudges,
  extraction, wrap-up, and alerts run there. The coordinator's instance
  drops all post-move subordinate events (directory filter, not in
  `childSessions`) — the coordinator observes the subordinate via chat, and
  chat WAKE for an idle subordinate depends on the worktree instance being
  alive. Whether opencode evicts quiet location contexts (an inactivity
  sweeper exists) is an open question gated by smoke test 8.
- Tab storage: the strip's persisted store (`tabs`), the reopen stack, and
  the `-c`/`-s` resume paths are untouched; a moved subordinate cannot
  hijack the coordinator's `-c` (resume resolution is directory-scoped SQL).
  One cosmetic staleness: the subordinate's chat-roster row records the
  worktree kind from the coordinator's location at registration; the move
  does not update it. Nothing scopes on that column, so no fix.

## Migration and rollback

- **Ship**: additive everywhere — one new tool def, one flag, one seam, one
  new module, one new file, one export. The only destructive step is the
  local shim conversion, which is a documented one-time user step (delete
  `thatch.ts`, add `thatch/`).
- **Roll back**: revert the commit; re-create the file shim if the directory
  shim is removed. Sessions created by the tool persist as ordinary
  top-level sessions — no cleanup needed, no schema migrations to undo, no
  orphaned state (chat registrations age out with the standard reaper).

## Intent breadcrumbs

Comments the implementation writes, and the question each answers:

- `ToolDef.v2Only` doc comment: why the flag exists and which consumers
  filter on it (answers "why doesn't this tool appear on v1/MCP?").
- `CoreContext.sessionTabHost` doc comment: which adapter wires it and what
  breaks when absent (answers "why do some hosts refuse this tool?").
- The execute-flow block comment in `v2.ts`: why register-create-move-emit-
  prompt is ordered this way (answers "why is the emit after the move?" —
  the event routes by the coordinator's location, so placement is unchanged,
  and a failed move no longer strands an open empty tab).
- The `childSessions` comment gets one added line: why a moved subordinate
  is deliberately NOT added (answers "why does the coordinator's pump drop
  the subordinate's events?" — the worktree instance owns them).
- `tui-plugin.ts` header: why the directory guard mirrors the built-ins and
  why there is no dedupe state (answers "is this a contract or a
  convention?" — convention).

## Dependencies

- Runtime: none new for the server path. The TUI path needs
  `@opencode/plugin` resolvable at runtime from the package (optional peer
  dependency, see Packaging changes) — verified against the host during
  smoke; the dev-checkout install already resolves it from the checkout's
  node_modules.
- Host: opencode v2 with the CLI-plugin surface. All cited APIs exist at
  v2.0.15, the oldest v2 line in use here. v1 hosts never load the v2
  adapter, so nothing gates on version at runtime.
- Dev: tests need `@opencode/plugin` types for the v2 adapter (already a
  devDependency) and bun test only. Note: `@opencode/plugin`'s `./tui`
  entrypoint imports `solid-js`, which is an uninstalled optional peer —
  tests must not import `src/opencode/tui-plugin.ts` transitively; the pure
  guard/filter logic lives in `src/session-tab-shared.ts` instead.

## Implementation order

1. `src/session-tab-shared.ts`: rpc definition (JSON Schema literal), prompt
   builder (`buildSubordinatePrompt(coordinatorName, prompt)`), validators
   (`validateTitle`, `validateExactlyOneLocation`, `isSameMainCheckout`
   wrapping the existing `resolveMainCheckout`, realpath-compared). Export
   `pathExists` from `src/git.ts` for the fs check. Unit tests.
2. `src/tool-defs.ts`: the `thatch_session_tab` ToolDef (`v2Only: true` only
   — it does not carry `opencodeOnly`, so the exact-`opencodeOnly`-names
   assertion in `tests/tool-defs.test.ts` is untouched), the
   `sessionTabHost?` seam on `CoreContext`; `src/tools.ts` and `src/mcp.ts`
   filter on `opencodeOnly || v2Only`. Update both `TOOL_DEFS.length` and
   the exact-names array in `tests/tool-defs.test.ts` (both are literals),
   and the raw `TOOL_DEFS` loops in `tests/mcp.test.ts` to exclude `v2Only`
   defs from the must-appear-in-MCP group (the `toBe(29)` compile count is
   unchanged); `tests/opencode-v2.test.ts`'s registration assertions adapt
   automatically. Add a one-line assertion in `tests/tools.test.ts` that the
   v1 `createTools` output excludes the tool.
3. `src/opencode/v2.ts`: wire `sessionTabHost` (rpc register at setup,
   tracked and disposed with the other registrations); extend the test
   double's `makeContext` with `session.move` and the `rpc` domain (both are
   missing today), then add the execute-flow test asserting register caller
   -> create -> move -> register subordinate -> emit -> prompt ordering.
4. `src/opencode/tui-plugin.ts` + the `exports` map (with `.`) + the exports
   unit test.
5. `artifacts/skills/thatch-coordination.md` in `OPENCODE_ONLY_SKILLS`;
   update the derived-count QA sites that assert opencode skill totals
   (`tests/qa/auto/uc-014-skill-install-drift.ts`, `uc-060-feature-availability.ts`)
   and the skill tables in `docs/dev/skills.md`, `docs/user/` (tables only,
   no counts in prose). The shared-skill 35-count literals elsewhere stay
   valid because the skill is opencode-only.
6. Docs: user-facing guide section and a dev feature doc
   (`docs/dev/features/session-tabs.md`), the shim-directory conversion in
   `docs/user/setup.md` with the duplicate-ID warning, and staleness fixes
   this change creates in `docs/dev/features/opencode-plugin.md` (the "no
   TUI surface" rows for toasts/exit gain the known lift candidate; the
   user-setup compatibility section; the source-file list) and in
   `docs/dev/mcp-parity.md` (the tool-surface matrix gains a v2-only class);
   optionally note the subordinate's chat registration in
   `docs/user/cross-session-chat.md`; plus the stale "no v2 surface"
   comments in `src/opencode/v2.ts` itself.
7. `tests/qa/runner.ts`: the fixture keeps the FILE shim - v1's auto-discovery
   is a `*.{ts,js}` file glob (a directory shim is invisible there, which
   deterministically killed UC-100's v1 chat canary), and the QA suite is
   headless, so no TUI process ever loads `./tui`. The real-install
   directory-shim conversion is a docs step (see 5), verified by live
   smoke, not by the fixture.
8. Live smoke test (below), then any fixes the smoke surfaces.

## Test plan

Unit (bun test, no host needed):

- Preamble builder embeds the coordinator name and the authority framing
  verbatim, and preserves the user prompt byte-for-byte (including `$`
  sequences).
- Title validation: empty, 80/81 chars.
- Exactly-one-location validation: neither, both, worktree-only,
  directory-only.
- `isSameMainCheckout`: same repo via worktree and main checkout (real temp
  git repos per the `tests/git-integration.test.ts` convention,
  realpath-compared), mismatched repos, non-worktree plain directory.
- Exports map resolves both `.` and `./tui`.
- TUI plugin guard/filter as pure functions in the shared module: event-type
  filter, directory guard accept/reject.
- v2 adapter (via the `makeContext` double): the tool registers with a JSON
  Schema input; the execute flow orders create -> move -> register
  subordinate -> emit -> prompt (the registration lands after the move so
  the roster row records the final directory); the rpc registration is in
  the dispose chain; a `sessionTabHost`-less CoreContext degrades with the
  documented refusal message.
- MCP surface: `thatch_session_tab` absent from `compileTools()`.

Live smoke (manual, `mise run qa-live` style, v2 binary on PATH):

1. Tool visible on v2; absent from `tools/list` on v1 and from the MCP server
   surface.
2. Open a tab from a coordinator session at a repo root: tab appears in the
   strip (not focused), subordinate runs the prompt, chat name in the tool
   response matches the roster.
3. Worktree variant: tab stays in the root repo's window strip while the
   subordinate's session directory is the worktree; chat between coordinator
   and subordinate round-trips; `/thatch/compact` in the subordinate tab
   arms the greenlight (confirms the worktree instance owns subordinate
   machinery).
4. Temp-directory variant: session runs; tab appears in the coordinator's
   window (event location routes it there under both scopes — this is the
   corrected expectation).
5. Headless (`opencode run`): tool call succeeds, no crash, no tab.
6. Tabs off (`tabs.mode: off` in cli.json): tool call succeeds; no tab; the
   TUI plugin logs the disabled `ui.tabs.open`.
7. Config edges: title over 80 rejected; both location args rejected;
   nonexistent `directory` rejected with a clear error; `worktree` pointing
   at an unrelated repo's checkout rejected.
8. Chat-wake an idle worktree subordinate after several minutes: mail
   delivers (verifies the second-instance liveness assumption behind the
   supervision model; if eviction swallows it, this test fails and the
   keep-alive question comes back to the user).

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Double-shim install kills plugin activation (`duplicate instance plugin ids: thatch` fires before plugin code runs) | Migration is a documented explicit step (delete the file shim); the user docs and the plan both carry the warning in bold. No self-heal is possible from inside the plugin. |
| The move-then-prompt ordering misbehaves on some v2 patch (move not immediate despite steer-on-idle) | Smoke test 3 gates the worktree variant. Fallback: prompt first and move with `delivery: "steer"` so the move lands at the next turn boundary, accepting one turn in the wrong directory. |
| The worktree location's thatch instance is evicted while the subordinate idles, silently stranding chat wake | Smoke test 8 gates the supervision model. If eviction is real, the follow-up (keep-alive heartbeat or hosted-write) comes back to the user as a design question; the plan does not pre-build it. |
| The tab strip renders a moved session oddly (location differs from the window) | Upstream's move-tolerant strip test and the smoke test 3 both cover it; cosmetic issues degrade to a mislabeled indicator, not a broken feature. |
| rpc events never reach the TUI in practice | Verified at the source level (feed passes `rpc.*`; the emit path is upstream's designed plugin channel) and by smoke test 2. Failure mode: session still spawns; tab absent. |
| The `./tui` shim is not installed (user keeps the file shim) | The tool still works; the response's "tab requested" wording stays true, and the docs make the conversion a required install step. A BROKEN `./tui` import is loud, not silent: the TUI shows a "Plugin failed" toast on load failure; absence (no file at all) is the quiet case, diagnosable from the TUI plugin log line. |
| Adding the `exports` map breaks existing npm installs | The map includes `.` in the same change; a unit test asserts both entries resolve (there is no other automated net — the QA suite bypasses package resolution via absolute-path shims). |
| `@opencode/plugin/tui` unresolvable on the npm install path (runtime-import of a devDependency) | Optional peer dependency added alongside; smoke step 2 verifies the real resolution. Failure mode is the benign no-tab case, already worded honestly in the tool response. |
| A failed move or prompt strands an empty session | A failed MOVE leaves: a session created and chat-registered at the coordinator's cwd, NO tab (the emit runs after the move), no prompt. A failed PROMPT leaves: a moved, chat-registered session with an open tab and no first message. Either way a retry creates a fresh session, so the stranded one is manual cleanup (close the tab if any, delete the session). Accepted for v1 — the windows are single awaits. |
| The stranded empty session hijacks `-c` resume | Until deleted, a stranded subordinate is the newest top-level session in the coordinator's directory, so the next `opencode -c` there resumes IT instead of the coordinator. The plan's `-c` safety claim (directory-scoped resume) holds only for successfully created-and-prompted subordinates; the skill tells the coordinator to clean up stranded sessions explicitly. |
| A coordinate-heavy workflow spams sessions the user did not want | The coordinator skill instructs dispatch discipline (task list first, one tab per task). The user can close tabs manually; tab closing via the tool is deferred, not impossible. |

## Deliberately deferred

- **`thatch_session_tab_close`**: natural follow-up once the flow proves out;
  the rpc bridge and `ui.tabs.close` make it small. The `tab-closed` event
  shape is already reserved in the shared rpc definition (see Architecture)
  and has a committed consumer: the generalized-session-heartbeat plan uses
  it as the instant confirmed-close signal for tool-initiated closes.
- **Config-gated visibility** (`tabs.mode: off` hides the tool): needs a
  lenient `cli.json` reader plus (for full fidelity) a TUI-to-server report of
  `ui.tabs.enabled()`. Ship with the tool always visible; add the reader only
  if tabs-off users complain.
- **Ack round-trip** (TUI confirms the tab opened): the TUI plugin could
  `rpc.call` back a server-registered method; adds coupling for a nicety the
  response wording already covers.
- **Durable tab-open recovery** (metadata marker consumed by the TUI plugin on
  session events) for missed-event cases: the session remains reachable via
  the sessions dialog meanwhile. Note a durable marker would turn the
  benign missed-event case into stale tab re-opens after TUI restarts,
  needing an age guard — not obviously a win.
- **`agent`/`model` args** for the subordinate: add when a real workflow needs
  them.
- **Keep-alive for evicted worktree instances**: depends on smoke test 8's
  outcome; do not pre-build.
