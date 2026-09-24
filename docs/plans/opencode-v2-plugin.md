# Plan: opencode v2 plugin support (dual v1/v2 adapter)

Status: IMPLEMENTED on branch `opencode-v2-migration` (PR sysread/thatch#16);
this plan graduates at merge - the architecture record is
docs/dev/features/opencode-plugin.md. One design item was dropped during
implementation: the shim-shape reminder (Design 1) - the shim lives in the
user's config dir (src/prompts.ts registers the canonical content instead).

## Problem

opencode 2.0 (separate install: `anomalyco/tap/opencode-v2` brew formula,
`@opencode/cli` npm) rewrote the plugin system. Thatch's plugin is v1-shaped
and fails to load on v2. Users on either opencode line must keep working, and
the fix must ship as the same `@jeffober/thatch` package -- no fork.

Concretely, at v2 the plugin dies at load. The v2 module validator
(packages/core/src/plugin/module.ts, tag v2.0.9) requires a **default export**
of `{ id, setup }` (promise API) or `{ id, effect }` (Effect API) and rejects
everything else with `PluginModule.LoadError: Plugin must export a default
definition with an id and an effect or setup function.` Thatch exports a named
`server` function returning a v1 Hooks object (src/index.ts:165).

The SDK package also renamed: v2 ships `@opencode/plugin`; `@opencode-ai/plugin`
is frozen at 1.18.32 on npm. Thatch imports the old name (src/index.ts:4,
src/tools.ts:1).

Upstream intent is documented and unambiguous (verified in the opencode
monorepo at v2.0.9): the v2 migration guide
(`services/www/src/docs/content/migrate-v1.mdx`,
`build/plugins/migrate-v1.mdx`) states "Port plugins, because V1 plugin
implementations do not run in V2" and that "V2 has three intentional breaking
changes": the plugin API, the server API, and terminal client config
(`tui.json` -> `cli.json`, auto-migrated). The first break is this plan; the
third does not affect thatch (it reads neither file -- verified). No v1 compat
shim exists in v2 plugin code. The plugin port is on us.

The README currently flags v2 as unsupported (commit 60ece01). This plan
removes that limitation.

## Verified loader facts (both sides, tags v1.18.32 and v2.0.9)

These decide the export shape. Each was checked against the tagged source;
the two load-bearing ones were additionally re-verified by an independent
reviewer (round 2).

1. **v2 reads only the default export** (packages/core/src/plugin/module.ts,
   v2.0.9). The `Module` schema decodes `default` as `{ id, effect }` or
   `{ id, setup }`. Named exports are not read.
2. **Excess keys on the default object are tolerated and stripped.** Verified
   empirically with stock `effect@4.0.0-rc.112` (the exact version opencode
   pins; no patch override in its root package.json): a default export
   `{ id, setup, server }` decodes successfully through the setup union
   member; the decoded value keeps only `id` and `setup`. A v1-only default
   `{ id, server }` (no `setup`) fails the v2 validator, as expected.
   Milestone 2's smoke test against the real binary stays as
   belt-and-suspenders.
3. **v1 (1.18.x) reads `default.server` first** (packages/opencode/src/plugin/
   shared.ts:272, `readV1Plugin`, shasum-identical from v1.18.0 to v1.18.32).
   It reads only `mod.default` and only the `server`, `tui`, and `id` keys.
   With a `server` function present, it returns it and `applyPlugin`
   (packages/opencode/src/plugin/index.ts:114-124) calls
   `plugin.server(input, options)` and returns before the named-export
   ("legacy") fallback loop. An excess `setup` key is invisible to it. If the
   default export has `id` but no `server`, `readV1Plugin` itself throws
   TypeError at its `kind === "server" && server === undefined` guard
   (shared.ts ~296), and the caller swallows the error, silently skipping
   the plugin (error-publish commented out at plugin/index.ts:225-243).
4. **Consequence: the dual shape is a merged default export object**
   `{ id, setup, server }`. v1 consumes `.server`; v2 consumes `.id`/`.setup`
   and strips `.server` (fact 2). A named `server` + default `{ id, setup }`
   module breaks v1 (fact 3). The v1-shaped default `{ server() }` has been
   canonical since commit f3997d8082 ("Single target plugin entrypoints").
5. **Runtime SDK resolution is per-host.** v1 auto-installs plugin packages
   into the config dir and provides `@opencode-ai/plugin`; v2 runtime source
   has zero references to it (v2 docs pages still mention the old name, but
   no runtime package imports it). v2's npm install skips optional
   peers (packages/util/src/npm.ts:209-278), so an optional-peer-only
   `@opencode/plugin` may not be installed by a v2-hosted plugin install.
   The dependency strategy in Design 4 follows from this.
6. **Promise API surface** (packages/plugin/src/promise/, the variant the CLI
   commands reference). A plugin is `{ id, setup(context) -> Cleanup | void }`.
   The context carries domain objects:
   - `session` (SessionDomain, packages/plugin/src/promise/session.ts:153):
     exactly `create`, `get`, `switchAgent`, `switchModel`, `prompt`,
     `generate`, `command`, `synthetic`, `interrupt`, `update`, `move`,
     `wait`, `context`, plus `hook: ModelHooks<SessionHooks>`. NOT in the
     domain: `delete`, `list`, `messages`, `status` -- each needs a declared
     strategy (capability table).
   - Session hook names: `prompt`, `context`, `compaction`, `generate`,
     `title`, `model.request`, `http.request`, `http.response`,
     `experimental.ws.*`, `retry`.
   - `tool` (ToolDomain): `transform(Transform<ToolEditor>)` to register tools
     (`editor.add/remove/update`, `namespace`), `hook` for `execute.before` /
     `execute.after`, `list`, `reload`.
   - `event`: `subscribe` (raw SSE bus async iterable; NOT directory-scoped --
     see capability table).
   - Plus `agent`, `command` (list + transform only), `mcp`, `permission`,
     `provider`, `reference`, `skill`, `storage`, `rpc`, `vcs`, `websearch`,
     `worktree` domains, and in full: `aisdk`, `model`, `shell`, `generate`,
     `plugin` (list-only), plus `app` (`{ name, version, channel }`) and
     `location`. There is no raw SDK client or serverUrl on the promise
     context.
7. **Tool inputs and context.** `Tool.ValueSchema` is
   `Effect Codec | StandardSchemaV1 | JsonSchema` (packages/schema/src/tool.ts:44);
   zod v4 implements Standard Schema, so `TOOL_DEFS`' zod shapes
   (src/tool-defs.ts) feed `ToolEditor.add` unconverted. v2's `Tool.Context`
   carries `sessionID`, `agent`, `messageID`, `id`, `progress`
   (packages/schema/src/tool.ts:14-20) -- the names `HostToolContext` needs
   exist.
8. **Toasts moved.** No `tui.showToast` client endpoint exists in v2. The
   surface is now a `tui.toast.show` ephemeral event
   (packages/schema/src/tui-event.ts). No publish mechanism is reachable from
   the promise Context today -- degradation is the default assumption.
9. **Config key migrated automatically.** v2's normalize step decodes the
   legacy `plugin` array and merges it into `plugins`
   (packages/core/src/config/normalize.ts:185-190). Existing user configs
   keep working; config compat does NOT cover the module-shape break.
10. **Skills unchanged.** v2 SKILL.md frontmatter is `name` / `description` /
    `metadata` (unknown keys tolerated). Discovery scans the config dir and
    project `.opencode/` entries for `skills/`. Thatch's artifacts and
    `installSkills` need no changes.
11. **Runtime.** opencode v2 embeds Bun 1.4.2 (v1: 1.3.14). Plugin code runs
    inside the host's embedded Bun, so thatch code must work on both. XDG
    path resolution is preserved. v2 adds plugin auto-reload via file
    watchers (making `setup` cleanup correctness-critical, not hygiene) and
    `opencode plugin add/list/check/update` commands.
12. **v1 keeps working.** The v1 CLI (1.18.x) still loads v1 plugins; the v2
    binary is a separate install. Migration can land before any user
    upgrades.

## Design

### 1. Layout: shared core, two adapters, one dual-shape entry

```
src/index.ts          -- thin dual entry (see export shape below)
src/opencode/v1.ts    -- current plugin body moves here unchanged
                         (imports @opencode-ai/plugin)
src/opencode/v2.ts    -- new promise-API adapter
                         (imports @opencode/plugin)
src/*                 -- everything else already host-agnostic: db,
                         embeddings, extraction, tool-defs, prompts, skills,
                         version-check, sideband, watchers
```

**Export shape.** src/index.ts defines the merged default export and keeps
named exports for tests and the QA use cases. Two rules keep the isolation
airtight:

1. **The entry's static import graph must stay SDK-free.** A static named
   re-export (`export { server } from "./opencode/v1"`) would pull the v1
   adapter -- and its runtime `import { tool } from "@opencode-ai/plugin"`
   -- into the graph that v2 evaluates. So both adapters are reached only
   through dynamic import, and each adapter's SDK import evaluates only
   under the host that calls it. A top-level await is likewise out: it
   would make either host's load block on (or fail from) the other host's
   adapter.
2. **The pure helpers move to their own SDK-free module.** `osProcessArgs`,
   `startupSessionId`, `startupSessionIdFromArgv`,
   `continuesLastSessionFromArgv`, `continuesLastSessionId` are
   host-agnostic pure functions with injected deps; they live across
   src/index.ts:75-163 (mixed into the v1 body, some before it). They move
   to e.g. `src/os-args.ts`; both the entry (static
   re-export, safe -- no SDK in that graph) and `src/opencode/v1.ts` import
   them from there.

```ts
// src/index.ts -- the dual entry
export { osProcessArgs, startupSessionId, ... } from "./os-args"; // pure, SDK-free
export const hygieneReport = ...;                                  // unchanged
export const server = async (input) =>                             // lazy wrapper,
  (await import("./opencode/v1")).server(input);                   // signature-compatible

export default {
  id: "jeffober-thatch",
  setup: async (ctx) => (await import("./opencode/v2")).setup(ctx),
  server: async (input, options) =>
    (await import("./opencode/v1")).server(input, options),
};
```

**The shims must be edited.** The dev-session shim
(`~/.config/opencode/plugins/thatch.ts`, currently a single
`export { server } from "/Users/jeff.ober/dev/thatch/src/index"` line) and the
QA runner's generated shim (tests/qa/runner.ts:156) are named-only re-exports.
Under v2, the module the host loads IS the shim, so a named-only shim still
dies with the LoadError. Both become dual-shape:

```ts
export { server } from "<target>";   // named, for anything importing the name
export { default } from "<target>";  // v1 default.server / v2 default.setup
```

The QA runner change is in the plan's scope; the dev shim is user-machine
state, updated manually at rollout. Because a stale named-only shim silently
disables thatch on v2, the version-check nudge gains one extra line reminding
about the shim shape when the running host is v2.

### 2. Capability seam, not an abstraction layer

The core (extraction pipeline, nudge logic, child-session bookkeeping,
toasts) consumes a narrow `HostCapabilities` interface; each adapter
implements it. The codebase already uses this exact shape four times
(deps-object injection: `ChatPollerStore` src/chat.ts:1272-1279 with optional
members "so test fakes stay minimal", `ChatPollerOptions` src/chat.ts:1281,
`WatcherRegistryOptions` src/watchers.ts:262, `OsArgsDeps` src/index.ts:125).
`HostCapabilities` is the plugin-lifecycle sibling of `CoreContext`
(src/tool-defs.ts:59-95, the per-tool-call seam both hosts already wire) --
document the relationship so nobody merges them. `CoreContext` construction
(src/tools.ts:24-32) is shared between adapters; only the v1 `tool()` wrapper
stays v1-only.

Capability table (call sites verified in src/index.ts; v2 equivalents from
the tagged promise API):

| Capability | v1 source | v2 source | Strategy |
|---|---|---|---|
| subscribe to bus events | `event` hook (:1018) | `context.event.subscribe` | v2 is NOT directory-scoped (raw SSE); adapter filters client-side on `event.location?.directory`, dropping location-less events -- mirrors v1's server-side filter |
| incoming-message signal | `chat.message` hook (:776) | `session.hook("prompt", ...)` | implemented: the hook AWAITS the runtime and appends injections to prompt.text; echo/synthetic re-entry semantics verified at milestone 2 |
| system prompt injection | `experimental.chat.system.transform` (:604) | `session.hook("context", ...)` mutates `system: Array<SystemPart>` | implemented; the runtime pushes a raw string (smoke-test the SystemPart typing) |
| compaction guard | `experimental.session.compacting` (:611), `experimental.compaction.autocontinue` (:618), `session.compacted` event (:1309) | `session.hook("compaction", ...)` + bus | flag implemented; context-injection surface verified at milestone 2 |
| wrap-up commands | `command.execute.before` (:771) + command files | `command.transform` + `CommandEditor.add` | UPGRADED from degrade: v2 registers the wrap-up commands in code (`armWrapUp` + the same prompt body); the runtime installs only ACTION command files on v2 |
| register tools | `hooks.tool` map via `tool()` helper | `context.tool.transform(editor => ...)` | implemented (fact 6) |
| tool execute.before/after | hook entries (:650) | `context.tool.hook` | implemented: feeds the same extraction buffer; result shape verified at milestone 2 |
| create child session | `client.session.create` | `context.session.create` | implemented; a missing id throws into the extraction fallback |
| prompt child (async) | `client.session.promptAsync` / `prompt` | `context.session.prompt` | implemented; background variant (delivery?) verified at milestone 2 |
| synthetic wake deliveries | `promptAsync` with `synthetic` parts | `session.synthetic` endpoint | UPGRADED from degrade: watcher + chat wake nudges route to v2's synthetic endpoint (TUI-hidden) |
| noReply deliveries (echo + reminder) | `promptAsync` with `noReply` | none | GATED OFF via `HostCapabilities.noReplyDelivery: false` on v2 -- delivering them would start real model turns (echo feedback loop); re-enable if v2 grows a noReply surface |
| session delete | `client.session.delete` (:552, :1104) | NOT in SessionDomain | DEGRADE: child-session cleanup degrades on v2 -- extraction children leak. Mitigation: title-based sweep where the API allows, else record as known gap and keep the bookkeeping maps consistent so the nudge path still works |
| session status (wake gate) | `client.session.status` (:236) | NOT in SessionDomain | fetchStatuses returns {}; the wake gate treats unknown as idle and the event-fed map gates |
| session list / messages | `client.session.list` (:405), `client.session.messages` (:1128) | NOT in SessionDomain | DEGRADE: `-c` resume listing and wrap-up greenlight check lose their data source on v2 |
| session get (title/topic) | `client.session.get` (:371, :1202) | `context.session.get` (in domain) | implemented |
| tui executeCommand/publish | `client.tui.*` (:1158, :1162) | NONE reachable | DEGRADE catch-and-ignore (matches today's headless behavior) |
| toast | `client.tui.showToast` | `tui.toast.show` publish (fact 7) | DEGRADE catch-and-ignore; re-check at milestone 2 |
| dispose | `dispose` hook (:1337) | cleanup returned from `setup` | CORRECTNESS under v2 auto-reload: cleanup must be idempotent and reload-safe (duplicate pollers/watchers/nudges are the failure mode); test the double-setup path |
| directory / worktree | `PluginInput` | `context.location` | low |

Where v2 has no equivalent, the adapter degrades the way the v1 code already
degrades headless (catch-and-ignore), and the plan records the lost feature
in the release notes rather than papering over it.

### 3. Tool registration (v2)

The v2 adapter registers `TOOL_DEFS` through `ToolEditor.add`:

- name: same `thatch_` prefix convention (v1 keys tools by object key; v2
  tools carry an explicit `name`; `editor.namespace()` is the alternative --
  use explicit names to keep tool names identical across hosts)
- input: the zod shape directly (fact 7 -- Standard Schema). Fall back to
  `z.toJSONSchema()` if a shape fails v2 validation.
- execute: adapt the v2 `ToolContext` (fields confirmed, fact 7) to the
  existing `HostToolContext` indirection (src/tool-defs.ts:103). The 3-line
  trim that src/tools.ts:39-45 does today will be duplicated in the v2
  adapter; accept the duplication (it is two fields) rather than adding a
  helper.

### 4. Package and dependency changes

- `@opencode/plugin`: **hard dependency** (devDependency for the typecheck
  gate AND regular dependency for runtime resolution). Rationale: v2's plugin
  install skips optional peers (fact 5), so an optional peer would be missing
  exactly when the v2 adapter runs. Harmless under v1: the v2 adapter is
  lazy-imported and never evaluates there. Mirrors the existing
  devDependency + peer pattern for `@opencode-ai/plugin`
  (package.json:31,38-45) but tighter.
- `@opencode-ai/plugin`: unchanged (devDependency + optional peer, exactly as
  today). The dual entry lazy-imports the v1 adapter, so its runtime
  `import { tool }` (src/tools.ts:1) never evaluates under v2, where the
  package may not resolve. This is why BOTH adapters must be lazy-imported
  from the entry, not just v2. (`import type` from the old SDK in the entry
  would also be safe -- types erase -- but the plan keeps the entry
  SDK-free at runtime, which is simpler to verify.)
- `zod` stays a direct dependency (feeds both the MCP path and v2 tools).
- Bun: mise stays pinned at 1.3.14 for the dev environment. CI adds a second
  test leg on Bun 1.4.2 (the v2 runtime); publish.yml gets the same second
  leg -- a release job that only tests 1.3.14 could ship 1.4.2 breakage.
  Watch `onnxruntime-web` (pinned dev version) as the likeliest 1.4.2-leg
  flake unrelated to our code.

### 5. Version-check and skew behavior

The version checker (src/version-check.ts) is fs-based and host-agnostic --
no changes. One refactor-first item lands BEFORE the capability move
(milestone 3), because the code it touches is uncovered today:

- The skew text `"thatch was upgraded to v... Restart opencode to apply the
  update."` is an inline string in the `chat.message` handler
  (src/index.ts:842) with zero test coverage (verified: no test greps for
  it). Extract it into src/prompts.ts beside `versionWarningNudge`
  (prompts.ts:621) and add a test asserting the injected text through the
  `chat.message` hook. Wording changes for v2 (`opencode plugin update`
  instead of restart, plus the shim-shape reminder from Design 1) then become
  gated changes.

Two behavioral notes land in docs rather than code: v2 auto-reloads local
plugin files (skew nudge fires less often for the shim path), and npm package
plugins update via `opencode plugin update` on v2.

### 6. What does NOT change

- MCP server (src/mcp.ts) and the Claude Code / Cursor paths (verified: mcp.ts
  imports nothing from src/index; bin/thatch imports src/* but not src/index).
- DB schema, embeddings, extraction pipeline, prediction/behavior engines,
  skills artifacts and installer, sideband (served/consumed only by MCP +
  bin/thatch), watchers module.
- The dual plugin-loading dedup situation (additive loading, no dedup on v1;
  v2 merges per-file but still has no dedup). Jeff's setup uses exactly one
  path; document the same single-path rule.
- tests/qa/runner.ts keeps its shim pointed at `src/index` (the dual entry);
  only the shim CONTENT changes (Design 1).

**User setup compatibility (no backward-incompatible config change).** The
plan moves no file and changes no format. Every path thatch reads or writes
stays put and stays shared across hosts: the SQLite DB
(`~/.config/thatch/thatch.db`, `THATCH_DB_PATH` override), the embedding
model cache, the version-check temp files (keyed by a hash of the db path),
the skills install dirs (`~/.config/opencode/skills/`, `~/.claude/skills/`,
`~/.cursor/skills/`), and the Claude/Cursor MCP configs. opencode's own
config key (`plugin` vs `plugins`) is auto-migrated by v2 (fact 9), and
thatch never reads that file. The only user-owned file whose content changes
is the dev-session shim, and the new dual-shape content loads under BOTH
opencode lines -- same location, same discovery mechanism. A user switching
between opencode v1 and v2 binaries (or swapping the brew formulas, which
conflict on the binary name and so cannot coexist) needs zero setup changes
in either direction. The one caveat: a user who never updates their old
named-only shim gets silent non-loading under v2 -- hence the shim-shape
reminder in the version-check nudge (Design 1), which is a warning, not a
migration step.
- Closure-scoped extraction state (`childToParent`, `parentSnapshots`,
  `extracting`, `extractionChildren`, `childMetrics` -- closure-scoped inside
  `server()`, not module-scoped) moves behind the seam as one unit; its
  documented constraints (snapshot drain by reference identity, extraction vs
  task sub-agent distinction, cleanup ordering) are behavioral contracts the
  seam must preserve, per the comments at src/index.ts:439-488.

### 7. Public surface contract (milestone 1 checklist)

src/index.ts must continue to export every name consumed elsewhere today, so
the move is checkable as zero-churn:

- `server` -- tests/plugin.test.ts:39-46, tests/qa/auto/uc-103-wrapup-commands.ts:36,
  uc-106-thatch-actions.ts:42 (now the lazy wrapper; tests drive it the same way)
- `osProcessArgs`, `startupSessionId`, `startupSessionIdFromArgv`,
  `continuesLastSessionFromArgv`, `continuesLastSessionId` -- re-exported
  from the new pure module, same import sites -- tests/plugin.test.ts
- `hygieneReport` -- tests/hygiene.test.ts:8
- package.json `main`/`types` keep pointing at src/index.ts (no `exports`
  field exists; `files: ["src"]` picks up src/opencode/ automatically).

## Milestones

1. **Extract the seam.** Move the v1 body to `src/opencode/v1.ts`, move the
   pure argv helpers to `src/os-args.ts` (Design 1 rule 2), introduce
   `HostCapabilities`, build the dual entry with lazy adapter imports and the
   merged default export (Design 1), update both shims (dev shim +
   tests/qa/runner.ts), fix the `../package.json` import (index.ts:31 becomes
   `../../package.json` in v1.ts). Same milestone, still zero behavior
   change: extract the skew-text string into src/prompts.ts with its
   assertion test (Design 5) -- it rides along because it is an uncovered
   code move, and milestone 3 depends on it existing. Zero behavior change;
   `mise run check` green; plugin.test.ts keeps driving through `server()`
   (it is the v1 adapter's contract test).
2. **Smoke-gate the remaining unknowns.** Install opencode-v2; verify against
   the real binary: (a) the merged default export loads (fact 2 is an
   empirical replica; the binary is the ground truth); (b) v1.18.x still
   loads it; (c) `session.hook("prompt")` timing vs v1 `chat.message`,
   including whether synthetic/echo prompts re-enter; (d) compaction hook
   shape; (e) `context.session.prompt` background/delivery semantics;
   (f) `session.status` bus event payload on v2 (feeds the ChatPoller
   strategy); (g) auto-reload invokes the setup cleanup. Update this plan's
   facts with results before writing more code.
3. **v2 adapter core.** Tools via ToolEditor, events via subscribe
   (client-side directory filter), child-session create/prompt, snapshot
   bookkeeping, ChatPoller ported to bus-driven status, through the seam.
4. **Toasts.** Implement or degrade per the milestone-2 finding.
5. **Tests.** Mirrored v2-adapter test file against a mocked v2 context
   (plain objects with call-recording arrays, the house pattern from
   tests/plugin.test.ts:96-120). Adapter tests land in the same milestone as
   the adapter code they gate. Explicit test targets: echo/synthetic prompt
   filtering (nudge-loop prevention), dispose idempotency under reload.
   Bun 1.4.2 CI + publish legs.
6. **Docs and release.** Remove the README "2.0 not yet supported" note; add
   `docs/dev/features/opencode-plugin.md` (dual-adapter architecture,
   capability table); update the 11 dev feature docs that cite hooks living
   in src/index.ts (extraction.md, nudge-pipeline.md, session-lifecycle.md,
   multi-host.md, compaction-recovery.md, watchers.md, cross-session-chat.md,
   and the rest found by grep) plus the QA comments citing src/index.ts line
   numbers; update docs/user/setup.md and the dev README module map. Ship a
   minor release; the README note stays until the release is out.

## Open questions (implementation-time verifications, not design blockers)

1. Does `session.hook("prompt")` fire at the same point as v1
   `chat.message`, and does it re-enter for synthetic/echo prompts?
   (Milestone 2c; the echo-filter test in milestone 5 guards it either way.)
2. Is there any publish path for `tui.toast.show` from a server-side plugin?
   (Milestone 2; default assumption is degrade.)
3. Does `context.session.prompt` support a background/async variant
   (`promptAsync` equivalent), or is `delivery` the replacement? (Milestone 2e.)
4. What is the v2 compaction hook's flag-lifecycle shape vs v1's
   `experimental.compaction.autocontinue`? (Milestone 2d.)
5. Bun 1.4.2 leg mechanics in CI (mise profile vs direct invocation).
6. Can child-session cleanup (`session.delete`) be recovered on v2 by other
   means (title-based sweep via an allowed endpoint), or is the gap
   permanent? (Milestone 2 informs; strategy declared in the table either way.)

## Review trail

- Round 0: deep-mode lens fan-out (patterns, alternatives, hidden problems,
  safe-to-modify, archaeology). Key corrections incorporated: merged default
  export shape (v1 readV1Plugin rejects named+default v2-shaped modules,
  silently); shim edits required (dev shim + QA runner are named-only today);
  `@opencode/plugin` must be a hard dependency (v2 skips optional peers);
  capability table expanded; skew-text extraction promoted to a precondition
  of milestone 3; publish.yml 1.4.2 leg added; closure-scoped state
  correction. Alternatives lens verdict: no better alternative found
  (two-packages and two-entry-point variants strictly dominated; dropping v1
  violates a hard constraint).
- Round 1 self-correction: static named re-exports in the entry would pull
  the v1 SDK into v2's import graph -- named `server` is a lazy wrapper and
  the pure argv helpers move to an SDK-free module instead.
- Round 2 (fresh-context verifier): both load-bearing premises confirmed --
  (a) v1 readV1Plugin accepts `{ id, setup, server }` and returns before the
  legacy fallback, with silent-skip failure mode; (b) excess `server` key on
  the default export is tolerated and stripped by the v2 schema (empirical
  probe at effect@4.0.0-rc.112). Open questions resolved from source and
  folded into the capability table: system prompt injection via
  `session.hook("context")`, ToolContext field names, event scoping (v2 is
  NOT scoped -- client-side filter required). New should-fixes incorporated:
  `session.delete`/`status`/`list`/`messages` missing from SessionDomain with
  declared strategies, echo/synthetic re-entry filtering as an explicit test
  target, reload-cleanup treated as correctness (idempotency). Dropped the
  non-enumerable fallback (dead weight); corrected hook names
  (http.request/http.response/experimental.ws.*); publish.yml leg; shim
  update reminder.
- Round 3 (fresh-context consensus): no blockers; three should-fixes
  incorporated -- migration-guide quote corrected (three breaking changes;
  tui.json/cli.json assessed out of scope), skew-text extraction scheduled
  into milestone 1, event-hook citation fixed (:1018). Nits taken: lazy
  wrapper forwards `(input, options)`, fact 5 claim tightened to runtime
  source, fact 6 domain list completed.
- Round 4 (fresh-context consensus): all verdicts CORRECT; every spot-checked
  citation reproduced from tagged source. No blockers, no should-fixes.
  Consensus. Two cosmetic nits folded in (fact 3 throw-site sentence, helper
  line range).
- Round 5 (implementation code review, 9-lens multi-agent pass over the
  branch diff): 2 confirmed HIGH fixed -- (1) the v2 prompt hook now AWAITS
  the runtime before mutating prompt.text (the fire-and-forget version raced
  the host's prompt serialization and produced unhandled rejections);
  (2) the v2 tool.hook("execute.after") feeder was missing entirely, leaving
  the extraction buffer unfed on v2. 3 confirmed MEDIUM fixed -- (3) a
  `HostCapabilities.noReplyDelivery` gate now skips chat echoes and the
  session-start reminder on v2, where a noReply delivery would start real
  model turns (the echo feedback loop); (4) the README compatibility claim
  carries a release-timing note; (5) the skewWarningText docstring now says
  the v2 wording is planned, not implemented. Plus: cleanup awaits the pump
  (the Promise.race was a no-op), sessionCreate throws on a missing id into
  the extraction fallback, the v2 event-pump null-guard documented, ~10
  stale src/index.ts citations repointed at src/runtime.ts (QA comments,
  gotchas, source comments), and cosmetic fixes (indentation, import type,
  double blank line, test name).
- Round 6 (live-binary smoke + v2-surface audit, Jeff's session): three
  smoke findings fixed and two degrades UPGRADED after auditing every v2
  domain for a better surface. Smoke fixes: (1) system-prompt parts must be
  v2 SystemPart OBJECTS ({type: "text", text}) - the runtime's raw string
  failed v2's schema on the first model request ("session failed"); (2) the
  nudge injection via prompt.text ECHOED into the visible transcript (v2
  stores prompt text as the user message) - injections now ride
  session.hook("generate") into the OUTBOUND request's last user message
  (computed once per prompt, stored per-session, invisible in the TUI and
  message list - v1 parity). Surface upgrades: (3) synthetic wake
  deliveries (watcher + chat nudges) route to v2's session.synthetic
  endpoint (TUI-hidden) instead of real prompts; (4) wrap-up commands
  register in code via command.transform + CommandEditor (execute arms
  armWrapUp and delivers the same prompt body), so the runtime installs
  only ACTION command files on v2 (nativeCommands capability) and removes
  wrap-up files left by earlier v1 runs - wrap-ups are near-full: the
  greenlight and flush work, but the compact/exit ACTIONS degrade (the
  promise context exposes no compaction trigger or TUI publish; see
  opencode-plugin.md). Audited and left as-is: skill files (v2
  supports them unchanged; embedded Skill registration saves nothing real),
  agent registration (nice-to-have; the task-tool path works), storage/RPC
  domains (no thatch use - the sideband serves external processes the RPC
  domain cannot reach).
