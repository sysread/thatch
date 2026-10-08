# Gotchas

Non-obvious invariants and footguns. If something behaves strangely, check
here first. These are the things that have already cost time.

## Embeddings

- **Embedding spaces are discriminated by vector _dimension_, not model tag.**
  `recall` / `findDuplicates` skip entries whose vector length differs from the
  query. The `model` column is informational only. Switching `THATCH_MODEL`
  makes old memories _invisible_ to search (not corrupted, not deleted — just
  skipped) until re-saved. There is no automatic re-embedding.
- **Embedding serialization honors `byteOffset`/`byteLength`.** transformers.js
  can return a `Float32Array` that is a _view_ into a larger tensor buffer.
  Serializing the whole backing buffer corrupts vectors. Always serialize the
  view's own bytes, not the underlying buffer.
- **BGE asymmetric search**: queries get the prefix
  `"Represent this sentence for searching relevant passages: "`; passages get
  no prefix. `queryEmbed` vs `passageEmbed` — don't swap them.

## Search vs recall

- **`search` scores; `recall` scores _and_ stamps telemetry.** `search` records
  no usage. The prompt-aware recall nudge deliberately uses `db.search()` (not
  `recall`) so nudges don't inflate the "used recently" signal. Only explicit
  `thatch_memory_recall` / CLI `search` stamp `recall_count`/`last_recalled_at`.
- **`findSimilar` excludes the slug being written** (self-exclusion on
  overwrite), so overwriting a memory doesn't warn against itself.

## Writes

- **The write-time similarity warning never blocks the save.** `remember` always
  proceeds; the warning lists >= 0.85-similar entries and asks the agent to
  reconcile (merge or `dedup_mark_checked`). Don't add blocking logic here.
- **`overwrite: true` clears stale dedup verdicts** for that slug. Forgetting an
  entry clears all verdicts involving it. Both make a pair eligible for
  re-reporting by `find_duplicates`. This is intended.
- **Archived memories are excluded by default.** `search`, `findDuplicates`,
  and `staleEntryCount` all filter `WHERE archived = 0`. To search archived
  memories, pass `includeArchived: true` to `thatch_memory_recall`. To archive
  a memory, write it with `archived: true`; to unarchive, `archived: false`.
- **Updating an archived memory requires explicit `archived` param.** If the
  entry is already archived and a `remember` call omits the `archived` param,
  the tool returns an error (`db.ts:585`). Pass `archived: true` to keep it
  archived or `archived: false` to unarchive. This guard prevents accidental
  unarchival via an unrelated content update.

## Hooks (opencode)

- **`tool.execute.after` is a plugin hook, NOT a bus event.** It must stay on
  the hook object returned by `server`. Moving it into the `event` handler
  (where `session.created` lives) silently never fires it — the event bus has
  no such event. This was dead for weeks because the failure was invisible.
- **`client.tui.executeCommand` only accepts legacy alias names**
  (`session_compact`, `agent_cycle`, ...). Unknown commands publish
  `{command: undefined}` and silently no-op — no error surfaces. For TUI
  commands without an alias (e.g. `app.exit`), publish
  `tui.command.execute` directly via `client.tui.publish`.
- **Command markdown written by the plugin is invisible until the next server
  start.** opencode loads config (including command discovery) before
  plugins, so `installOpencodeCommands` self-heals on every load but a
  first-ever install only lands after a restart.
- **`tool.execute.after` excludes `skill` and `task` tools**, not just
  `thatch_*`. Buffering them creates a feedback loop: the nudge triggers a
  skill load, which gets buffered, which triggers another nudge on the next
  turn.
- **Hook failures are logged with a `[thatch]` prefix and never swallowed.** Two
  hooks were dead for weeks before failures were made visible. If you add a
  hook, log on failure.
- **There is no model-facing extraction nudge on opencode.** The old
  `chat.message` extraction nudge (and its `missedNudges` escalation) drove
  a model-driven handshake that raced its own state machine: parent acks
  landed before the child's payload fetch, no-claim completions wiped
  in-flight accepted sets, and mis-targeted session ids made every
  transition a silent no-op - so the same buffered count re-fired forever
  (the September 2026 dispatch-loop report). Extraction is now plugin-driven
  end-to-end: `triggerExtraction` at session idle creates the child and
  interpolates the session ID itself; the child's payload fetch records the
  claim; completions are claim-scoped; the 15-minute stale reaper bounds
  crashed extractors. The nudge survives on MCP hosts only, where no plugin
  can create sessions and the file-backed queue is durable until the
  extractor completes.
- **A child's `thatch_memory_remember` completes only its claimed delivery**
  via the `childToParent` Map and the claim recorded by its payload fetch.
  A child that never fetched has no claim, and its memory write (or idle
  signal, or ack) consumes nothing - the entries stay held/pending for the
  real extractor. `thatch_extraction_done` is the explicit no-save
  completion: claim-scoped like everything else, so a mis-ordered or
  mis-targeted ack can never drop another extractor's in-flight delivery.
- **The no-save drain runs in the child-idle handler regardless of writes.**
  When the extraction child goes idle after a no-save run (nothing worth
  extracting), the parent's snapshot entries must still be drained from the
  buffer. Without this, entries linger in pending and the nudge fires as a
  synthetic (TUI-hidden) part on the next `chat.message`. The child-idle
  handler drains the snapshot only if it still exists (the child wrote no
  memories). If the child did write memories, `tool.execute.after` already
  consumed the snapshot — the idle handler skips the drain so interleaved-turn
  entries survive.
- **`client.tui.showToast` is best-effort.** The toast call is wrapped in a
  catch-and-ignore — if the TUI is not connected (headless mode), it silently
  does nothing. The toast is TUI-rendered (in-app), not an OS notification.

## Hooks (Claude Code / Cursor)

- **`PostToolBatch`/`postToolUse` must be silent** (no stdout). The agent loop
  must not block on a payload that should be invisible until the next prompt.
  Only `flush-tools` prints.
- **The recall nudge arrives at the _start_ of the next turn** in Claude
  Code/Cursor, not the end of the current one like opencode's `chat.message`. A
  file-backed queue bridges calls that have no shared state.
- **Cursor uses `conversation_id`** where Claude Code uses `session_id`.
  `buffer-tool` normalizes the former to a safe filename and tries multiple
  field names for the tool response.
- **`--json` flips the output shape.** `reminder --json` and `flush-tools
  --json` emit `{ additional_context: "..." }` for Cursor; plain stdout for
  Claude Code. The flag is baked into the installed hook command.

## Sideband

- **Socket path = SHA-256 of the DB path**, under `os.tmpdir()`. The MCP server
  and hook processes compute it independently — no out-of-band coordination.
  Changing `THATCH_DB_PATH` moves the socket; a stale socket from a crash is
  cleaned up on connection error.
- **Sideband failure never blocks.** Server down, stale socket, or a >2 s
  timeout all return `null`, and `flush-tools` falls back to the static write
  nudge. Never hard-fail the agent over a recall nudge.

## Setup

- **Skills follow the setup scope.** Project-local installs write skills to
  the repo's `.claude/skills/` / `.cursor/skills/` (they version with the
  project); `--global` writes to `$CLAUDE_CONFIG_DIR/skills/` /
  `~/.cursor/skills/`. A run never touches the opposite scope: if thatch
  skills already exist there (e.g. user-scope copies from an older local
  setup), setup reports them in a note but leaves them alone, so they can
  drift stale until refreshed or deleted.
- **`appendBlock` leaves content alone if the markers don't parse.** If the
  start marker is found but the end marker isn't, the whole block is skipped
  rather than half-replaced. Fix the markers or delete the block manually.
- **The binary path is baked into installed hook commands.** `thatch setup`
  resolves `<bin>` from PATH (or the script's absolute path) and writes it into
  every hook command, so hooks survive after the setup session ends.
- **Tool-arg optionality cannot be per-host at the schema level.** The zod
  arg shape in `TOOL_DEFS` is shared by the opencode plugin and the MCP
  server, so making an arg optional (e.g. `get_extraction_payload`'s
  `session_id`) makes it optional everywhere. Per-host enforcement has to
  happen in the tool's `execute`: fall back to `HostToolContext.sessionID`
  on the opencode path, return a "pass the parent's session_id" error on
  MCP hosts, which have no session context. See
  [features/commands.md](features/commands.md).

## Tests

- **DB tests use real SQLite files in `mkdtempSync`, not `:memory:`.** WAL
  behavior differs in-memory and would mask bugs. Temp dirs are removed in
  `afterEach`.
- **`BgeEmbeddingModel`'s real `PipelineFactory` is untested** — downloading the
  model violates the no-network rule. Lazy-load and retry logic are tested with
  an injected mock factory. The real model is exercised only by real use.
- **`bun test` does not typecheck**, and `tsconfig.json` excludes `tests`. Test
  type errors are editor-only noise unless you run `tsc` on the test files
  directly. Keep test files type-clean anyway so the editor stays quiet.

## Config and notifications

- **Tests touching the config must set `THATCH_DB_PATH`.** The config tools
  derive the config file path from the environment (`THATCH_DB_PATH`, then the
  XDG default), not from the test's tempdir `ThatchDB`. A config test that
  skips this reads and writes the developer's real
  `~/.config/thatch/config.json`. See `tests/notify.test.ts` for the
  save-and-restore pattern.
- **osascript exits 0 even when macOS drops the banner.** Focus/Do Not Disturb
  or missing notification permission silently swallow it. `notify_user` result
  text therefore reports command success only; never interpret exit 0 as
  delivery.
- **New QA use cases must be imported into the directory's barrel file**
  (`tests/qa/auto/index.test.ts` or the live one). The `.ts` files are not
  discovered by bun on their own. UC-095 sat out of the suite for a release
  cycle and rotted (asserted 3 watch tools when 4 existed) because nobody
  noticed it never ran.

## Instruction-block markers must be sentinels, not prose

The thatch instructions block in `CLAUDE.md` / `AGENTS.md` is delimited by
`<!-- thatch:begin -->` / `<!-- thatch:end -->` (src/setup.ts). Before
September 2026 the delimiters were prose sentences from the instructions
themselves - and agents edit those files. An editing agent normalized
punctuation (hyphens to em dashes) in both of Jeff's instruction files, the
prose end marker stopped matching, and setup could never update the block
again while `checkSetup` reported `markers-broken` on every session. Rule:
never use file content as its own delimiter; agents will reword it. The
legacy-prose detection constants exist only to migrate old installs.

## The dual-shape plugin entry: named `server` + v2 default export silently breaks v1

opencode v1's plugin loader (`readV1Plugin`, identical across 1.18.x) reads
ONLY `mod.default`. A module that exports a named `server` plus a v2-shaped
default `{ id, setup }` (no `server` inside the default) makes v1 throw on
load - and the host swallows the error and SKIPS the plugin with no visible
message. The failure looks like "thatch tools disappeared", not like a load
error. This is why the dual entry exports a MERGED default object
(`{ id, setup, server }`) and why every shim (the user's
`~/.config/opencode/plugins/thatch.ts` and the QA runner's generated one)
must re-export the default as well as the name. A named-only shim loads on
v1 and silently disables thatch on v2 - same invisible failure, opposite
host.

## The extraction buffer matches on tool NAME, so Code Mode execute calls re-queue pipeline traffic

The non-bufferable filter in `onToolExecuteAfter` (`src/runtime.ts`) matches
`input.tool`, but a Code Mode `execute` call that wraps
`tools.thatch_extraction_done` / `tools.thatch_memory_remember` inside its
code string arrives as tool name `execute`. Unfixed, every execute-wrapped
ack landed back in the buffer as an extractable interaction: each
extraction run's payload contained only the previous run's dispatch and ack,
the nudge always found pending interactions, and a session could loop
forever on dispatch → ack → nudge (observed live in an oink session,
September 2026 - the looped agent answered every turn with "Extractor
dispatched and acknowledged. Stopping per the nudge" and never resumed the
user's work; only a human message broke the cycle). The fix unwraps execute
calls (`unwrapExecuteThatchCalls` in `src/extraction.ts`) and runs the
wrapped tool's hook semantics instead of buffering. Lesson for sibling
hooks: when a filter reasons about tool identity, an aggregator tool
(arbitrary code execution over other tools) defeats name-based matching -
unwrap the aggregation before classifying.

## LLMs guess tool-call shapes on the first call, so teach the shape at the mention site

A September 2026 audit of every thatch tool-call error in the opencode
session database (~19k calls, both v1 and v2 storage) found the failures
cluster on the model's FIRST thatch call - usually the startup recall round -
and fall into a short list of avoidable mistakes:

- **Bare positional string instead of an object argument** (the largest
  bucket): `thatch_memory_recall({ query: "..." })` called as
  `thatch_memory_recall("...")`. Root cause: the opencode system prompt's
  startup section and the recall nudge both used positional-style examples
  (`thatch_memory_recall "query"`), and Code Mode models mimic that shape
  inside `execute`. Both now teach the object form.
- **Required discriminator params omitted**: `memory_remember` without
  `label` (models pass `title`/`id`/`statement` instead, or nothing),
  `prediction_update` without `signal`, `behavior_codify` without
  `situation`. Fixes: `label` is optional and derived from content;
  tool descriptions state the all-args-required contract.
- **Nudges leak into tool-less agent contexts**: task-dispatched sub-agents
  (explore/general and friends) have restricted tool lists that exclude the
  thatch tools, but `chat.message` nudges fired for them anyway, producing
  guaranteed "No tool named ..." error rounds. The chat.message hook now
  skips nudges for child sessions that are not extraction children.

The general lesson: any surface that names a tool to an LLM (system prompt,
nudge, skill text) is a usage-shape prior. Give the argument shape at the
mention site, because the model's first call happens before it has seen a
working example. Also note Code Mode `execute` validation failures are only
persisted in the v2 `session_message` store - they are invisible in the v1
`part` table, so error-rate analysis on old data undercounts them.

## ThatchDB lazy reopen: new accessors must go through the private getters, and journal writes stay guarded at call sites

`ThatchDB` reopens its SQLite connection on first use after `close()`
(`src/db.ts`, the `#db`/`#predictions`/`#behaviors`/`#chat` private getters), so
an in-flight tool call that races a v2 plugin reload's `dispose()` completes
instead of throwing "Cannot use a closed database". Two rules keep this intact:

- **New facade methods need no extra wiring, but new state-holding members
  do.** The engine facades (`ChatStore`, `PredictionEngine`, `BehaviorEngine`)
  capture the `Database` handle at construction; the reopen rebuilds them. A
  new member that captures the Database directly must get its own private
  getter that ensures the handle is open first - a plain field keeps serving
  the stale closed handle and the reopen silently never fires for it (this
  exact bug is pinned by the "engine facades are rebuilt" test in
  tests/db.test.ts).
- **Post-dispose journal writes are no-ops at their call sites, not in
  db.ts.** After a reload, the RELOADED instance owns the `runtime_state`
  rows, so delayed writers in `src/runtime.ts` check the `disposed` flag
  BEFORE touching the db - the lazy reopen would otherwise hand a stale
  writer a fresh connection. All three journal callbacks are guarded (the
  extraction pipeline's finalization, the WatcherRegistry journal - a poll
  cycle suspended at an await can outlive `watchers.dispose()` - and the
  wrap-up arming write, whose command executes are not drained by the v2
  cleanup). Do not "fix" the guard away by moving it into db.ts: the
  accessor cannot tell a legitimate in-flight caller from a stale writer.

## Command frontmatter descriptions must be quoted YAML scalars

- **A plain-scalar frontmatter value containing a colon followed by a space
  is invalid YAML, and not every host path rescues it.** `/thatch/hygiene`'s
  description ("Tend the memory store: stale entries, ...") shipped unquoted;
  the first parse throws
  and only opencode's fallback sanitizer recovers it — and a long-lived
  server was observed dropping the description entirely while a fresh server
  parsed it fine, which made the bug look like a TUI rendering issue. The
  renderer quotes every description (`yamlQuote` in src/commands.ts) and a
  unit test pins the quoted form. Keep it that way for any new frontmatter
  field whose value is free-form prose.

## In-memory maps gate nothing durable: reloads and restarts wipe them

- **Any guard whose correctness depends on a runtime.ts Map silently
  disappears for sessions whose events arrive after a plugin reload or a
  daemon restart.** The chat auto-registration child check learned this the
  hard way: `childToParent` kept extraction children out of the roster, but
  an instance that lost the map to a reload registered every event-bearing
  child, and v2 cannot delete sessions (sessionDelete is a no-op), so the
  poller heartbeat those corpse rows forever and the stale-row reaper never
  reaped them (81 `thatch-extraction` rows by 2026-10-07). The fix pattern:
  the plugin writes a DURABLE marker at creation time
  (`chat_machinery`, src/db.ts), and every registration path checks the
  marker plus a stable title (`isMachinerySessionTitle`) instead of
  trusting in-memory state alone. If you add a new plugin-created session
  kind, mark it in the same table and route its events through the same
  guards - do not rely on Maps surviving a reload.

## A running TUI never adopts a NEW ./tui plugin entrypoint - restart the TUI

- **The v2 TUI discovers its CLI plugins at process startup only.** The
  server side hot-reloads plugin code (the digest watcher), and the TUI
  hot-reloads the SOURCE of plugins it already loaded - but a plugin that
  GAINS a `./tui` entrypoint (or a fresh install of one) is a discovery-
  level change: a TUI process started before the entrypoint existed never
  loads it. Symptom (2026-10-08, the thog TUI): `thatch_session_tab` ran
  fine server-side (the session, the chat registration, the response all
  real) but the tab never appeared in the strip - the TUI had no
  `ui.tabs` consumer loaded, so the rpc event landed nowhere. The
  persisted `tabs.json` (in `$XDG_STATE_HOME/opencode/<channel>/tui/`)
  proved the registration logic was correct the whole time: a FRESH TUI
  (the docker sandbox attach) showed the tab immediately.
- **Fix**: restart the TUI window once after adopting (or changing the
  shape of) a `./tui` entrypoint. Check `tabs.json` first when debugging
  "tab didn't appear" reports: if the entry is in the window's cwd
  bucket, the tool worked and the window is stale.

## The two opencode lines discover plugins differently: no one shim shape auto-loads on both

- **v1 auto-discovers plugin FILES only** - its config plugin scan globs
  `{plugin,plugins}/*.{ts,js}`, which never matches a directory. **v2
  auto-discovers files AND directories** (and symlinks), and its activation
  dies on duplicate ids - so a plugins directory holding BOTH `thatch.ts`
  and `thatch/` loads the server plugin twice on v2 and dies with
  "duplicate instance plugin ids" before any plugin code runs. There is no
  single on-disk shape that auto-loads on both lines as a directory-based
  multi-entry plugin. Consequences: the dev-checkout install uses the file
  shim for v1-only or v2-only use, or the directory shim for v2's `./tui`
  entrypoint (session tabs) - deleting the file shim in the same step; the
  QA fixture keeps the FILE shim because the QA suite is headless (no TUI
  process ever loads `./tui`, and the file shape is the only one that loads
  on both lines - a directory shim deterministically killed UC-100's v1
  chat canary). Local plugin specs handed to a loader explicitly
  (`"plugin": ["./path"]`) can point at a directory on v1 - it is only the
  AUTO-discovery scan that is files-only.
