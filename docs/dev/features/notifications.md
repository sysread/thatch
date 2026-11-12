# Notifications and user config

Out-of-band user notification (desktop banner + spoken voice) backed by a
hand-editable user config file. Both are plain child processes and file I/O,
so the feature works identically on every host -- opencode, Claude Code, and
Cursor -- with no host-specific plumbing and no new npm dependencies.

Two delivery paths share the dispatcher and the config file:

- **Agent-initiated**: the LLM calls `notify_user`. Works on every host.
- **Automatic alerts** (opencode and the Claude Code plugin regime): the
  plugin runtime (opencode) or the mod's event forwards (the plugin
  regime) watch session
  events and notify when the LLM pauses for human input or finishes a
  round of real work. See the Alerts section below for the design decisions.

## Source files

| File | Role |
|------|------|
| `src/config.ts` | Zod section schemas, config file load/save/merge, platform defaults, `alertMode`, `alertVoice`. |
| `src/notify.ts` | Per-platform dispatch for banner + voice, with an injectable spawner, the injectable journal writer, and the darwin terminal-notifier preference. |
| `src/tool-defs.ts` | `config_get`, `config_set`, `notify_user` tool definitions (shared registry, non-opencodeOnly). |
| `src/db.ts` | The `notify_journal` table plus `recordNotifyJournal` / `listNotifyJournal` -- the storage side of the delivery journal. |
| `src/cli/commands/notifications.ts` | The `thatch notifications` subcommand: prints the journal, newest last, with `--limit`. |
| `src/alerts.ts` | Alert state machine: pause/done/error decisions from session events, per-session dedup (no timer-based debounce - one alert per busy->idle transition, per request id for pauses). |
| `src/env-knobs.ts` | The registry of `THATCH_*` environment knobs (name, description, default) rendered by `config_get`'s `environment` section. |

## Config design

The config is one JSON file at `~/.config/thatch/config.json`, placed next to
`thatch.db` by deriving the path from `THATCH_DB_PATH` (or the XDG default the
same way `runtime.ts` and `mcp.ts` derive the DB path). Tests pass an explicit
dbPath to keep writes inside a tempdir.

Key decisions:

- **Sections are `z.strictObject`.** Unknown keys fail validation instead of
  being silently stripped, so a newer-version config round-tripping through an
  older process cannot lose data. An unparseable file is *ignored* (empty
  config + warning), never fatal -- a broken hand edit must not take the agent
  down.
- **A null field value in `config_set` unsets the field** (the key is deleted
  from the file; the default applies again). The stored schemas stay strict:
  null is an arg-level marker only and never reaches the file. A null section
  object is refused (null unsets fields, not sections).
- **Unknown `config_set` keys are rejected, not silently ignored.** Without
  this check a typo'd section or field would never reach the merge with its
  key intact: the MCP validator throws a raw zod "Unrecognized key" error,
  and v2's input repair strips it (a bare "Nothing to update", or worse a
  mixed patch that writes the valid fields while silently dropping the
  typo); only a call that reaches execute unvalidated dies at the strict
  section schemas during the merge. `execute` validates every key against the config schema's field lists
  (derived from `config.ts`'s schema shapes, so they cannot drift) and
  returns an error naming the typo with a fuzzy `Did you mean ...?`
  suggestion (`src/fuzzy.ts`, the same git-weighted matcher the memory and
  chat misses use). Nothing is written on a typo. Both hosts
  deliver unknown keys to this check (MCP: the validator clone
  deep-passthroughs; opencode: the declared schema permits them) - see
  `docs/dev/mcp-parity.md` for the exact per-host schema surfaces.
- **`config_set` refuses to write when the file failed to parse.** A save
  would write a merged-whole file from the empty fallback config and silently
  discard whatever the user hand-wrote; the refusal names the file and points
  at the hand fix.
- **Field-level merge in `config_set`.** `mergeNotificationPrefs` is a shallow
  spread of current + patch (with `undefined` values stripped first). The
  tool's description and the system prompt both state the merge semantics, and
  the setter *echoes the resulting section* so the model can verify the write
  in the same turn. This is the guardrail against the classic
  read-modify-write failure where a model reconstructs a document and drops
  sibling fields.
- **Unset via null.** An explicitly set field would otherwise be sticky
  forever (the merge keeps current values, so no tool call could ever
  remove it -- the reason a user whose config pinned an old default voice
  had to hand-edit the file). The `config_set` arg schemas accept `null` on
  the leaf fields as an explicit UNSET marker: the merge functions delete
  null-valued keys instead of merging them, so the key is gone from the
  file, `config_get` shows `<unset>`, and the default applies again. The
  stored section schemas stay strict -- `null` never persists to the file,
  and a hand-edited null keeps the same ignore-with-warning treatment as
  any other schema violation. A null in a section-object slot
  (`notifications: null`) is refused by the arg schemas and again by a
  guard in the setter's execute.
- **Atomic writes.** `saveConfig` writes a temp file then renames, so a crash
  mid-write cannot leave a truncated config and concurrent readers never see a
  partial document.
- **No env-var preference overrides.** The config file is the single source
  of truth for preferences; `THATCH_*` env vars remain reserved for
  infrastructure (DB path, model, thresholds). Preferences the LLM manages
  belong in the file the LLM manages. The one exception is the
  `THATCH_NO_NOTIFY` kill switch, which is infrastructure: it silences
  dispatch entirely (see below) rather than tuning a preference.

### The environment section

The `THATCH_*` environment knobs are invisible in the config file (they are process
environment, not file state), so `config_get` gained a fourth section name,
`environment`: `src/env-knobs.ts` holds the single registry (name,
one-sentence description, default) and renders one line per knob with the
effective value read from `process.env` at call time. `config_set` refuses
the section with a pointer to the shell. The registry is the only place the
descriptions live -- the docs link to it instead of restating the list --
and `tests/env-knobs.test.ts` enforces the registry against the source tree
in both directions: every registered name must appear in code, and every
`THATCH_*` literal in code (minus protocol markers) must be registered.

`notificationDefaults()` supplies the platform fallbacks shown by `config_get`
and applied by `notify_user`: darwin pins `Zarvox` + `Submarine` (the author's
preference); other platforms defer to their tools' defaults. The default
voice constant lives in one place, `DEFAULT_VOICE` in `src/notify.ts`; the
config default and the tool descriptions derive from it.

## Notification dispatch

`sendNotification(request, spawner)` composes one or two command steps and
returns a result string for the tool response:

- **darwin**: banner via `/usr/bin/osascript -e 'display notification ...'`
  (title defaults to `source`, then `thatch`; sound defaults to `Submarine`),
  voice via `/usr/bin/say -v <voice>` (absolute path -- `~/bin/say` shadows
  the system binary on the author's machine). When terminal-notifier is on
  PATH the banner prefers it (see the terminal-notifier preference below);
  with the binary absent the osascript construction is exactly this.
- **linux**: banner via `notify-send`; voice via `spd-say -w`, falling back to
  `espeak` when speech-dispatcher is absent. A voice override goes straight to
  `espeak -v` because `spd-say` has no voice flag.
- **other platforms** (win32 included): `[unsupported]` result, nothing runs.
  Windows support is deliberately not a goal.
- **The `THATCH_NO_NOTIFY=1` kill switch** is checked at `sendNotification`
  entry (`notifySuppressed`), before any platform logic: the result is a
  `[suppressed]` line and no spawner call, so every per-platform command
  (osascript, say, notify-send, spd-say, espeak) is covered by construction.
  Test and QA runs set it -- the `tests/clean-env.ts` bun preload forces it
  for the unit suite, and the QA fixture env (`tests/qa/runner.ts`
  `createFixture`) passes it to every subprocess -- because the temp-HOME/XDG
  sandboxing cannot contain osascript: without the guard, a runtime path that
  boots the real dispatcher under tests fired live banners and voice on the
  developer's machine. `tests/notify.test.ts` lifts the guard for its own
  file so the injected-spawner composition tests stay meaningful. A user can
  export it in their shell to silence thatch notifications entirely.

Details that matter:

- **The spawner is a `CoreContext` extension field** (`ctx.spawner`), the same
  pattern as `watchers` and `extractionPayloadProvider`. Tests inject a mock;
  production falls back to `defaultSpawner` (Bun.spawn). No test ever fires a
  real banner or speaks.
- **Failures never throw.** Every step's exit code and stderr are captured;
  the result string is `[notified]` when anything succeeded, `[failed]` when
  all requested channels failed, `[skipped]` when configured `mode` is
  `none`, `[unsupported]` on other platforms.
- **No delivery claims.** osascript exits 0 whether or not the banner
  displayed (focus modes silently drop it), so result text reports command
  success only.
- **The spoken line prefixes the `source` label** ("PLAT-280: CI is green") so
  a user with several concurrent agent sessions knows which one spoke. The
  tool description enforces this on the model side.
- **The tool owns the tone prefixes, not the model.** `notify_user` takes
  `tone: positive | negative | neutral` (default neutral) and prepends the
  announcement prefix ("Amaze! Amaze! " / "Sad sad sad ", Rocky from Project
  Hail Mary style) to the message before dispatch, so the prefix leads both
  the banner text and the spoken line with the source label right after it.
  The model is told never to compose the prefix into the message itself;
  `applyTonePrefix` in `src/notify.ts` is idempotent (case-insensitive
  startswith guard) so a pre-prefixed message is never doubled. A
  hand-composed prefix is stripped from the raw message before the source
  label is composed, so the prefix leads the line exactly once
  ("Amaze! Amaze! P L A T 2 8 0: C I is green") even when a model with
  the old hand-compose habit also passes tone.
- **The spoken line is hard-capped** at `SPOKEN_LINE_MAX` (140 characters)
  by `capSpokenLine`: long spoken output takes a while and MacinTalk gets
  monotone and unclear on long sentences. The cut prefers a word boundary
  and adds no ellipsis (spoken punctuation for a truncation marker is an
  TTS behavior the spoken line does not need). The banner
  text is never truncated.
- Speech is awaited (the tool returns when the sentence finishes) so error
  reporting stays honest. There is no debounce; polling agents notify once at
  the end.

## The notification journal

Banners are write-only from the user's side -- an osascript banner's text
cannot be selected or copied, and clicking one opens a Script Editor file
dialog instead of doing anything useful -- so every delivery attempt is also
appended to the `notify_journal` table. The journal is the readable record
of what was said; `thatch notifications` prints it.

Design decisions:

- **One row per `sendNotification` call**, not one per physical channel.
  The `channel` column holds the requested channel (`both` / `banner` /
  `voice`), and the outcome summarizes the attempt the same way the result
  string does: `delivered` when any requested step succeeded, `failed` when
  every one failed, `suppressed` for the `THATCH_NO_NOTIFY` kill switch,
  `unsupported` for other platforms. A `both` attempt that banners fine but
  fails its voice step journals as delivered -- exactly the `[notified]`
  result the model sees. "Delivered" keeps the feature's honesty limit:
  it means the command ran, never that the user saw the banner.
- **The writer is injected, like the spawner.** `sendNotification` takes an
  optional `NotifyJournalWriter` as its third parameter. `CoreContext` grows
  a `notifyJournal` field that `buildCoreContext` (src/tool-defs.ts) and the
  MCP server's inline context (src/mcp.ts) bind to
  `ThatchDB.recordNotifyJournal`; the two alert call sites (src/runtime.ts,
  src/claude-plugin/lifecycle.ts) bind the same directly. Tests and minimal
  hosts omit it and deliveries are simply not journaled -- the same
  opt-in pattern `ctx.spawner` uses.
- **Journal failures never reach the dispatch.** `sendNotification` wraps
  the write in try/catch: a locked database or a closed handle logs one
  stderr line and the notification still goes out. The journal is the
  notification's side detail, never its master.
- **Rows are raw, not rendered.** The row stores the caller's source,
  title, and message exactly as passed; the tone prefix is tool decoration
  and is not baked in, and `created_at` comes from the database's strftime
  default -- the same stamping every other table uses.
- **Append-only, no pruning.** A row is tiny and a machine emits a handful
  of attempts a day. The chat wake budget and `runtime_state` both prune
  because they exist to bound machine behavior; the journal exists to
  preserve it.

`listNotifyJournal(limit)` returns rows oldest-first (newest last --
display order), keyed by the autoincrement id so same-second rows keep
insert order. The CLI renders each row as one line: time, source, channel,
message, with a bracketed outcome marker only when the attempt did not
deliver -- printing a failed or suppressed attempt exactly like a delivered
one would mislead.

## The terminal-notifier preference (darwin)

When the user has installed
[terminal-notifier](https://github.com/julienXX/terminal-notifier) and it is
on PATH, the darwin banner prefers it over osascript. The reason is
interaction, not delivery: terminal-notifier banners support a click action.
Thatch composes:

```text
terminal-notifier -title <title> -message <banner text> -sound <sound> \
  -execute /usr/bin/osascript -e 'set the clipboard to "<banner text>"'
```

Clicking the banner copies the banner text (tone prefix included) to the
clipboard -- the whole point, since an osascript banner's text cannot be
selected and its click opens a Script Editor file dialog.

- **Detection is runtime and spawner-based** (`terminalNotifierAvailable`
  in src/notify.ts): one `/usr/bin/which terminal-notifier` probe through
  the same injectable spawner that delivers, run per banner delivery.
  Never a build or install dependency -- the repo does not require the
  binary, and with the binary absent the osascript path runs exactly as it
  did before (the command construction is unchanged; only the probe is
  new). A probe that exits nonzero or cannot spawn at all reads as absent.
- **Two quoting layers** carry the message into the click action:
  `appleScriptString` builds the AppleScript literal (backslash and
  double-quote escapes), then `shellSingleQuoted` wraps the whole `-e`
  argument in one shell single-quote (an embedded single quote becomes
  `'\''`) -- terminal-notifier runs `-execute`'s value through a shell, so
  the AppleScript must survive one shell round-trip on its way to the
  clipboard.
- **Voice is untouched**: `/usr/bin/say` runs exactly as before either way,
  and the result line labels the step `banner (terminal-notifier)` vs
  `banner (osascript)` so the tool response says which path fired.
- **The cask build is the only working install**: the brew formula builds an
  unsigned app that modern macOS refuses to grant notification permission
  to -- every banner exits 3 ("Could not request notification permission"),
  the app never appears in System Settings > Notifications, and
  `tccutil reset UserNotifications fr.julienxx.oss.terminal-notifier`
  fails with exit 70 because no TCC entry ever exists to reset. Installing
  the cask (`brew install --cask terminal-notifier`) puts the signed app in
  /Applications, where the first banner triggers the real permission
  dialog. Both builds link the same binary name, so the probe needs no
  change; verified live 2026-11-12 after the formula install hit exactly
  this wall.

## Alerts: the automatic notification path (opencode and the Claude Code plugin regime)

`src/alerts.ts` holds an in-memory state machine per session. The plugin
runtime (the adapter feeds it the event stream) drives it
from the shared `onEvent` hook; on the Claude Code plugin regime, the mod
forwards turn/tool/permission events to the bundled server's
`plugin_lifecycle`, which feeds the same classifier; delivery reuses
`sendNotification` with the
`alerts` config section choosing the channel per event (`alertMode`, default
`banner`). Voice and sound come from `alertVoice` (`src/config.ts`): the
user's configured `notifications.voice` / `notifications.sound` apply to
machine alerts exactly as they do to `notify_user`, with platform defaults
for unset fields -- one config read per delivery feeds both the channel gate
and the voice override. Delivery is fire-and-forget (a spoken alert awaits
the sentence for seconds and must never stall the event pump); the machine
owns the per-event `none` gate and the per-delivery config re-read is what
makes config changes apply without a restart. Alerts carry their own
announcement tone (`alertTone`: error -> "Sad sad sad", done ->
"Amaze! Amaze!", pause -> neutral) and cap the source label (the session
title is model-generated and can eat the whole spoken budget) - the machine
path owes the same brevity discipline the tool description demands of models.

Events consumed:

| Event | Machine input |
|-------|---------------|
| `question.asked` / `permission.asked` | Pause alert, deduped per request id; cleared by the matching replied/rejected event. |
| `session.status` busy | Marks the session active and resets the round. |
| `session.status` retry | Clears a recorded error -- opencode recovered on its own -- but preserves the real-work flag (the tool calls before the retry happened). |
| `session.error` (from `session.execution.failed`) | Records the error name; the adapter emits this paired with the idle event, so the verdict always follows. |
| `session.status` idle (from active) | The verdict: error alert, done alert, or silence. A recorded error delivers its verdict WITHOUT the message fetch (the fetch rides the same host API whose failure plausibly accompanied the failure). |
| `session.deleted` | Drops the state. |

The verdict combines two sources, because neither alone can answer "was
this a real round of work the user asked for?":

- **The tool side is live bookkeeping, not message archaeology.** The
  runtime calls `sessionRealWork` at exactly the extraction buffer's push
  site -- the buffer's filter is the one classification of "this call was
  not bookkeeping" (`isMetaToolName`: `thatch_*`, `skill`, `task`,
  `agent`, `subagent`; execute-wrapped thatch calls are unwrapped and never
  reach the push). Message parts do not carry tool arguments, so the
  execute-unwrap cannot be redone from messages. `todowrite` and `question`
  reach the push (the buffer wants their facts) but are excluded from the
  alert signal -- see `isNoWorkTool` in `src/alerts.ts`; they deliberately
  do NOT live in `isMetaToolName`, and moving them there would silently
  stop the buffer from queueing them.
- **The trigger side comes from the message list** via the pure
  `deriveRoundShape` (exported from `src/alerts.ts`, fed
  `HostCapabilities.sessionMessages` output). The round delimiter is v2's
  own idle marker: v2 appends a `{type: "idle"}` marker message at every
  turn end (`SessionMessage.Idle`), so the round is everything after the
  previous marker - the host's turn definition, immune to mid-round
  steers.

Silence rules, in verdict order:

- **Unknown shape** -- a failed or empty message fetch stays silent.
  Alerts are best-effort: a spurious banner on every broken fetch costs
  more than a rare missed completion. This rule also keeps adapter-level
  tests (whose client mocks have no message surface) from ever spawning a
  real banner.
- **Synthetic-trigger silence** -- nudges, background-task completions, and
  watcher wake-ups are synthetic deliveries (their own message kind). A round they triggered
  never fires the DONE alert, even when it does real work. It is a silence
  on the done verdict only: a synthetic round that ends in a real error
  still banners the error. The rule exists because async thatch activity
  would otherwise produce a banner every time.
- **Abort and shutdown silence** -- an error name matching
  /abort|shutdown|interrupt/i means the user interrupted the turn
  themselves (`MessageAbortedError`, or v2's user-reason interrupt
  translation), the process is leaving (`SessionShutdownError`), or the
  execution was superseded by a newer one (the catch-all for unknown
  interrupt reasons). Sources: the event-level error, the message-level
  error on the last assistant message, and v2's interrupted-reason
  translation.
- **Error alert** -- any other recorded error (event-level, or message-level
  on the last assistant message) notifies needs-attention with the error
  name in the message, instead of done. Notably `SessionInactivityError`:
  v2's location-activity sweeper interrupts still-executing sessions when a
  project directory goes quiet for an hour -- the one banner most likely to
  reach Jeff away from the terminal.
- **No real work** -- a round whose only tool calls were bookkeeping (or
  that made none, or whose tool executions all crashed at the host layer)
  stays silent. A round delegated entirely to subagents also stays silent:
  dispatch tools are meta, and child sessions never alert.

State is plain memory, deliberately not journaled to `runtime_state`: a v2
reload mid-turn (plugin save, upgrade) loses that turn's busy->idle
transition and stays silent. Accepted by design -- the PR #16 journaling
exists because extraction and wrap-up state corrupt sessions when lost, and
an alert cannot corrupt anything.

Subagent child sessions never alert: the runtime's idle branch handles
children (extraction completion) and returns before the alert verdict, and
child errors requeue extraction instead. Pause asks from children still
notify -- a subagent blocking on a question blocks the parent too.

Deduplication across TUIs is structural: the runtime is one instance per
project directory in the shared server regardless of how many TUIs are
attached, so per-session state is exact by construction. Delivering from the
TUI side (opencode's attention API) would fire once per attached TUI and was
rejected for that reason.

## Prompt surface

- `systemPrompt()` and `mcpInstructions()` list the three new tools and carry
  a short "Notifications" section: when to notify, the source-label rule, and
  the config_get-before-config_set instruction.
- `notify_user` is not `opencodeOnly`: it needs no host capabilities, so MCP
  hosts get it too. Nothing was added to `src/tools.ts` or the plugin runtime.

## Tests

- `tests/config.test.ts` -- path derivation, missing/invalid/strict-schema
  handling, round-trip, atomic save leaves no temp files, merge keeps
  siblings, null deletes the merged field, darwin defaults, `alertVoice`.
- `tests/notify.test.ts` -- command construction per platform (mock spawner
  records argv), AppleScript escaping, partial vs total failure, unsupported
  platform, the `THATCH_NO_NOTIFY` suppression guard (no spawner call, a
  `[suppressed]` result, exact-`1` matching, passed-env reads), the
  terminal-notifier preference (probe-found command shape, the two-layer
  quoting of the click action through single quotes, double quotes, and
  backslashes, the tone-prefixed copy text, the probe-throws fallback,
  `terminalNotifierAvailable`), and the journal (delivered / partial /
  total-failure / suppressed / unsupported rows, the never-throw contract
  with its stderr log, the ThatchDB round trip with newest-N-oldest-first
  listing, the `notify_user` tool call journaled through a bound ThatchDB),
  plus
  tool-level tests (merge-no-wipe, echo, `mode: none` no-op,
  configured voice honored, unset via null deletes the key from the file,
  environment section rendered, environment + null-section refusals, the
  parse-warning refusal (a broken file is never overwritten; the raw file
  is re-read and asserted untouched)) with
  `THATCH_DB_PATH` pointed at a tempdir.
- `tests/env-knobs.test.ts` -- the knob registry enforced against the source
  tree in both directions, plus rendering (one line per knob, effective
  value, default).
- `tests/tool-defs-catalog-session.test.ts` -- registry count and name list (hardcoded literals that fail loudly when the surface changes).
- `tests/alerts.test.ts` -- the alert state machine: `deriveRoundShape`
  (idle-marker delimiter, synthetic trigger detection), the
  real-work flag, pause dedup and re-arm, abort/shutdown silence,
  error-with-name, retry recovery, `mode: none` per event, config
  round-trip (isolated tempdir).

## QA coverage

`tests/qa/auto/uc-059-tool-prefixing.ts` asserts the full bare-name list; the
three new names are in its `expected` array. `uc-108-llm-alerts.ts` drives
the full alert event flow against a spy notifier, including the adapter
seam: raw v2 bus events through `translateEvent` and real-shaped
`session.context` lists through `mapSessionContextMessages` +
`deriveRoundShape` (the seam where the idle-marker bug hid). `uc-096-notify-user.ts`
covers the config tool round trip: field-level merge, unset via null (key
deleted from the raw file), the environment section, and the two refusals
(its mock spawner answers the terminal-notifier probe absent, so its
osascript assertions stay pinned). `uc-147-notification-journal.ts` covers
the journal end to end under the suite's `THATCH_NO_NOTIFY=1`: the
`notify_user` attempt journals a suppressed row with nothing dispatched,
`thatch notifications` prints rows newest-last with the default and
explicit limits and the bracketed outcome marks, and bad `--limit` values
die loudly. `uc-088-schema-creation.ts` asserts the `notify_journal` table
exists. A live banner-by-ear check remains a manual verification against a
running session.
