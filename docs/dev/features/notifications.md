# Notifications and user config

Out-of-band user notification (desktop banner + spoken voice) backed by a
hand-editable user config file. Both are plain child processes and file I/O,
so the feature works identically on every host -- opencode, Claude Code, and
Cursor -- with no host-specific plumbing and no new npm dependencies.

Two delivery paths share the dispatcher and the config file:

- **Agent-initiated**: the LLM calls `notify_user`. Works on every host.
- **Automatic alerts** (opencode-only): the plugin runtime watches session
  events and notifies when the LLM pauses for human input or finishes a
  round of real work. See the Alerts section below for the design decisions.

## Source files

| File | Role |
|------|------|
| `src/config.ts` | Zod section schemas, config file load/save/merge, platform defaults, `alertMode`. |
| `src/notify.ts` | Per-platform dispatch for banner + voice, with an injectable spawner. |
| `src/tool-defs.ts` | `config_get`, `config_set`, `notify_user` tool definitions (shared registry, non-opencodeOnly). |
| `src/alerts.ts` | Alert state machine: pause/done/error decisions from session events, per-session dedup (no timer-based debounce - one alert per busy->idle transition, per request id for pauses). |

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
- **Field-level merge in `config_set`.** `mergeNotificationPrefs` is a shallow
  spread of current + patch (with `undefined` values stripped first). The
  tool's description and the system prompt both state the merge semantics, and
  the setter *echoes the resulting section* so the model can verify the write
  in the same turn. This is the guardrail against the classic
  read-modify-write failure where a model reconstructs a document and drops
  sibling fields.
- **Atomic writes.** `saveConfig` writes a temp file then renames, so a crash
  mid-write cannot leave a truncated config and concurrent readers never see a
  partial document.
- **No env-var overrides for notification prefs.** The config file is the
  single source of truth; `THATCH_*` env vars remain reserved for
  infrastructure (DB path, model, thresholds). Preferences the LLM manages
  belong in the file the LLM manages.

`notificationDefaults()` supplies the platform fallbacks shown by `config_get`
and applied by `notify_user`: darwin pins `Zarvox` + `Submarine` (the author's
preference); other platforms defer to their tools' defaults.

## Notification dispatch

`sendNotification(request, spawner)` composes one or two command steps and
returns a result string for the tool response:

- **darwin**: banner via `/usr/bin/osascript -e 'display notification ...'`
  (title defaults to `source`, then `thatch`; sound defaults to `Submarine`),
  voice via `/usr/bin/say -v <voice>` (absolute path -- `~/bin/say` shadows
  the system binary on the author's machine).
- **linux**: banner via `notify-send`; voice via `spd-say -w`, falling back to
  `espeak` when speech-dispatcher is absent. A voice override goes straight to
  `espeak -v` because `spd-say` has no voice flag.
- **other platforms** (win32 included): `[unsupported]` result, nothing runs.
  Windows support is deliberately not a goal.

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
- Speech is awaited (the tool returns when the sentence finishes) so error
  reporting stays honest. There is no debounce; polling agents notify once at
  the end.

## Alerts: the automatic notification path (opencode only)

`src/alerts.ts` holds an in-memory state machine per session. The plugin
runtime (both the v1 and v2 adapters feed it the same event stream) drives it
from the shared `onEvent` hook; delivery reuses `sendNotification` with the
`alerts` config section choosing the channel per event (`alertMode`, default
`banner`). Delivery is fire-and-forget (a spoken alert awaits the sentence
for seconds and must never stall the event pump); the machine owns the
per-event `none` gate and the per-delivery config re-read is what makes
config changes apply without a restart.

Events consumed:

| Event | Machine input |
|-------|---------------|
| `question.asked` / `permission.asked` | Pause alert, deduped per request id; cleared by the matching replied/rejected event. |
| `session.status` busy | Marks the session active and resets the round. |
| `session.status` retry (v1 only) | Clears a recorded error -- opencode recovered on its own -- but preserves the real-work flag (the tool calls before the retry happened). |
| `session.error` / `session.execution.failed` | Records the error name; on v2 the adapter emits this paired with the idle event, so the verdict always follows. |
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
  previous marker -- the host's turn definition, immune to mid-round
  steers. V1 has no markers and falls back to "newest non-assistant message
  triggered the round" (a mid-round steer under-classifies there; accepted
  v1 limitation).

Silence rules, in verdict order:

- **Unknown shape** -- a failed or empty message fetch stays silent.
  Alerts are best-effort: a spurious banner on every broken fetch costs
  more than a rare missed completion, and the same fetch failing also
  breaks the wrap-up greenlight check, so the session degrades
  consistently. This rule also keeps adapter-level tests (whose client
  mocks have no message surface) from ever spawning a real banner.
- **Synthetic-trigger silence** -- nudges, background-task completions, and
  watcher wake-ups are synthetic deliveries (v2: their own message kind; v1:
  all-synthetic text parts on the user message). A round they triggered
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
rejected for that reason (plus v1 has no TUI plugin surface at all).

## Prompt surface

- `systemPrompt()` and `mcpInstructions()` list the three new tools and carry
  a short "Notifications" section: when to notify, the source-label rule, and
  the config_get-before-config_set instruction.
- `notify_user` is not `opencodeOnly`: it needs no host capabilities, so MCP
  hosts get it too. Nothing was added to `src/tools.ts` or the plugin runtime.

## Tests

- `tests/config.test.ts` -- path derivation, missing/invalid/strict-schema
  handling, round-trip, atomic save leaves no temp files, merge keeps
  siblings, darwin defaults.
- `tests/notify.test.ts` -- command construction per platform (mock spawner
  records argv), AppleScript escaping, partial vs total failure, unsupported
  platform, plus tool-level tests (merge-no-wipe, echo, `mode: none` no-op,
  configured voice honored) with `THATCH_DB_PATH` pointed at a tempdir.
- `tests/tool-defs.test.ts` -- registry count and name list (hardcoded literals that fail loudly when the surface changes).
- `tests/alerts.test.ts` -- the alert state machine: `deriveRoundShape`
  (idle-marker delimiter, v1 fallback, synthetic trigger detection), the
  real-work flag, pause dedup and re-arm, abort/shutdown silence,
  error-with-name, retry recovery, `mode: none` per event, config
  round-trip (isolated tempdir).

## QA coverage

`tests/qa/auto/uc-059-tool-prefixing.ts` asserts the full bare-name list; the
three new names are in its `expected` array. `uc-108-llm-alerts.ts` drives
the full alert event flow against a spy notifier, including the adapter
seam: raw v2 bus events through `translateEvent` and real-shaped
`session.context` lists through `mapSessionContextMessages` +
`deriveRoundShape` (the seam where the idle-marker bug hid). A live
banner-by-ear check remains a manual verification against a running
session.
