# Thatch Alerts: Notify the User When the LLM Pauses or Finishes

## Synopsis

Add an opt-in alert layer to the thatch opencode plugin that sends a desktop
notification when the LLM (a) is blocked on a human decision -- an interactive
question or a permission request -- or (b) finishes a round of real work. Bookkeeping
rounds driven by thatch's own nudges and background-task completions never notify.
One code path serves both installed opencode lines (v1.18.x and v2.x). The brain
lives in the server plugin, which is a single instance per project directory, so
deduplication and debouncing per session are free.

## Background

Jeff's workflow: ask a question, switch to another window, let the LLM work. He
needs a notification when the work finishes or when it stalls waiting for him.
Nothing else deserves a notification.

What exists today and why it is not enough:

- opencode v2's built-in TUI attention plugin (`internal:notifications`) notifies
  on question, permission, done, and error. It has no per-event configuration, and
  its "done" fires on every turn end -- including turns triggered by thatch nudges
  and background-task completions. That turns async thatch activity into
  notification spam.
- The v1 line has no TUI plugin system at all. The community notifier plugin
  Jeff used on v1 is orphaned (config remnants in `~/.config/opencode`, upstream
  issue mohak34/opencode-notifier#108).
- Thatch already ships `thatch_notify_user` (voice + banner, session-labeled), but
  it is a tool the LLM invokes on request. It cannot fire on host-level events,
  and it must not fire on every turn end.

opencode's attention API (system notification + sound, focus-aware) exists only in
the TUI plugin context, so a pure server plugin cannot use it. Shipping a thatch
TUI plugin would deliver notifications through the terminal but would reintroduce
the double-TUI problem: one plugin instance per attached TUI means one notification
per TUI, and the same v2 session can live in two TUIs. Server-side delivery avoids
that by construction.

## Goals

- Notify on `question.asked` and `permission.asked` (the blocking cases).
- Notify when a round of real work ends (busy -> idle transition).
- Stay silent on rounds whose only tool calls were thatch or meta tools, and on
  turns triggered by synthetic input (nudges, task completions, watcher wake-ups).
- Stay silent on recoverable errors and user-initiated aborts; notify when a
  session dies in a state nothing will wake.
- Work identically on opencode v1.18.x and v2.x from one code path.
- Deduplicate and debounce per session in one process.

## Non-goals (deferred)

- TUI plugin delivery via opencode's attention API (v2-only, focus-aware, but
  per-TUI instances defeat dedup). Revisit as a v2 enhancement: a TUI plugin could
  report focus state to the server plugin for focus gating.
- Focus gating in general. Server-side delivery cannot see terminal focus; banners
  may land while the terminal is focused. Accepted: Jeff's stated workflow is to be
  away from the terminal, and one unified code path is worth the noise.
- Reload-state persistence. v2 auto-reload discards plugin memory on every save to
  the dev shim tree (see the PR #16 design). Worst case here is one missed or
  duplicate alert at a reload boundary, which Jeff has ruled acceptable. No
  `runtime_state` journaling for alerts.
- Claude Code / Cursor hosts. The MCP server has no event stream. Claude Code's
  `Notification` and `Stop` hooks could feed the same classifier later; a parity
  row documents the gap.

## Design

### Architecture

One actor owns all alert state: the thatch plugin instance inside the shared
opencode server process (per project directory). Both v1 and v2 load exactly one
instance per directory no matter how many clients are attached, so per-session
dedup and debounce are plain in-memory maps. Delivery reuses the platform
dispatcher that `thatch_notify_user` already uses.

```text
event hook (question/permission/session.*)
        |
        v
per-session alert state machine  --->  classifier (real work?)
        |                                     |
        v                                     v
   src/notify.ts dispatcher  <--- config (alerts section)
   (osascript / notify-send / say)
```

### Event capture

| Event | Action |
|---|---|
| `question.asked` | Notify "needs your answer". Track request id; clear on `question.replied` / `question.rejected`. |
| `permission.asked` | Notify "needs approval". Track request id; clear on `permission.replied`. |
| `session.status` busy or retry | Mark the session active. Clear any recorded error (a retry means opencode is still working). |
| `session.status` idle (from active) | Evaluate the round: classify, then notify or stay silent. |
| `session.error` | Record the error on the session. Do not notify yet -- the status transition decides. |

Both lines publish `question.asked` / `permission.asked` on the event bus with the
full request payload (sessionID included), and `session.status` carries
`{ type: "idle" | "busy" | "retry" }`. Verify both against the installed versions
before implementation (see Verification).

### Per-session state machine

State kept per session id: `active` (bool), `lastError` (name + message or null),
`pendingAsks` (request ids already notified). Transitions mirror the built-in v2
plugin's proven pattern, with error handling changed to match Jeff's intent:

- error followed by busy/retry -> recovered, clear the error, keep going quiet.
- error followed directly by idle -> nothing will wake the session; notify
  "needs attention" instead of a done notification.
- `MessageAbortedError` -> always silent (the user pressed abort; they know).
- busy -> idle with no error -> the done path: classify the round, notify only
  real work.

Notification state is rebuilt empty on plugin setup. Reload or restart mid-turn
means the busy->idle transition is never observed and that round stays silent.
Accepted.

### Round classification (shared classifier)

At idle, inspect the round's tool calls and skip when the round did no real work:

1. Skip sessions with a `parentID` (subagent children never notify).
2. Skip when the triggering user message is synthetic-only. This covers thatch
   nudge turns, background-task completions, and watcher wake-ups. Without this
   rule, zero-tool-call narration turns (the typical completion-injection turn)
   would still notify.
3. Otherwise inspect the last assistant message's tool parts. Skip when every tool
   call is in the meta set: `thatch_*`, the dispatch tools `task` / `agent` /
   `subagent` (name differs by version -- match the set, never one name), `skill`,
   `todowrite`, `question`, and `execute` calls whose code only wraps thatch tools
   (reuse the `unwrapExecuteThatchCalls` scan from `src/extraction.ts`).
4. Real tool calls present -> notify "work finished", titled with the session
   title (every notification identifies its session -- standing preference).

The meta-tool exclusion and the execute-unwrap scan already exist in the
extraction buffer's non-bufferable filter. Extract them into one shared pure
function (in `src/extraction.ts` or a sibling) consumed by both the buffer and
this classifier, so the aggregator-tool lessons live in one place. Unit tests for
the shared classifier extend the existing meta-tool buffer tests.

### Config

New `alerts` section in `~/.config/thatch/config.json` (schema in `src/config.ts`,
written via `config_set`, hand-editable, atomic save -- same as `notifications`):

```jsonc
{
  "alerts": {
    "pause": { "mode": "banner" },   // question + permission
    "done":  { "mode": "banner" },   // real-work turn end
    "error": { "mode": "banner" }    // stalled session
  }
}
```

`mode` accepts `both` / `banner` / `voice` / `none`, defaulting to `banner` for
every event. Voice is opt-in per event: turn-end voice would fire far too often to
be the default, and `thatch_notify_user` remains the LLM-invoked voice channel.
Delivery goes through `sendNotification` in `src/notify.ts`, which already owns
per-platform dispatch (darwin: `osascript` banner + `/usr/bin/say`; linux:
`notify-send` / `spd-say` / `espeak`) and the injectable spawner tests need.
Spoken alerts carry the session-identifying source label, per the standing rule.

### Version support

The event hook, session status events, and the notify dispatcher exist on both
lines. Divergence is confined to two seams, both already abstracted in
`src/capabilities.ts` / the v1-v2 adapter layer:

- Message reading for the classifier: v2 exposes session context/messages through
  the promise client; v1 has its own message-list shape. Map both into one
  internal part view (tool calls + synthetic flags) in the capabilities layer.
- Tool naming: the dispatch tool is `task` (v1) vs `subagent` (v2); the classifier
  matches the set.

## Verification (before implementation)

1. SSE probe against the installed v1.18.x serve: confirm `question.asked`,
   `permission.asked`, and `session.status` appear on `/api/event` and carry the
   session's directory as `location` (the plugin event hook drops events whose
   location does not match).
2. Same probe against installed v2.x.
3. Confirm the message-list shape on both lines exposes tool parts (with tool
   names) and synthetic flags, so the classifier can read them.
4. Confirm one plugin instance per directory in the shared server (both lines) --
   this is the dedup guarantee, so verify rather than assume.

## Implementation milestones

1. Extract the shared round classifier (meta set + execute-unwrap) from the
   extraction filter; unit tests first.
2. Alert state machine in the plugin event hook (`src/index.ts` or a new
   `src/alerts.ts`): pause tracking, active/error/idle transitions.
3. Capabilities-layer message mapping for both lines.
4. `alerts` config section + `config_get` / `config_set` wiring + dispatcher
   calls.
5. QA use cases + docs.

## Testing

- Unit: classifier cases (all-meta skip, real work notify, execute-wrapped unwrap,
  dispatch-tool set, synthetic-only skip); state-machine transitions (busy->idle
  notify once, error->retry quiet, error->idle notify, abort silent, dedup by
  request id); config parsing and defaults.
- QA (`tests/qa/auto/`): drive a session through the plugin harness with the
  injectable spawner capturing `sendNotification` calls; assert pause and done
  alerts fire, nudge turns stay silent. Import the file from the suite's
  `index.test.ts` barrel.
- Gate: `mise run check` and `mise run qa-auto` green before commit.

## Docs impact

- `docs/user/notifications.md` -- alerts section: what fires, how to configure
  `alerts`, limitations (no focus gating, opencode-only).
- `docs/dev/features/notifications.md` -- architecture: event capture, state
  machine, shared classifier, version seams.
- `docs/dev/README.md` -- module table row if a new module lands.
- `docs/dev/mcp-parity.md` -- row for the opencode-only alerts surface.
- `docs/dev/gotchas.md` -- entry if the v1/v2 event or message-shape seams cost
  debugging time.

## Decisions already made

- Server-plugin delivery over TUI-plugin delivery (dedup by construction, unified
  across versions).
- Reload state loss accepted; no `runtime_state` journaling.
- Watcher wake-up turns stay silent; the LLM can call `thatch_notify_user` when it
  decides something is important (tool already exists).
- User aborts stay silent; unrecovered errors notify.
- Banner default, voice opt-in per event.
- Retire the orphaned v1 notifier config during rollout; leave v2's built-in
  attention settings untouched unless doubles annoy (its TUI-side notifications
  only fire when blurred).

## Deviations from the plan as written

- **Unknown round shape stays silent**, not "notify". The original choice
  (never miss a completion) made every adapter-level test whose client mock
  lacks a message surface spawn a real osascript banner during `mise run
  check` -- the state machine reached live delivery through the pump's
  busy->idle path. Silence on a failed fetch is also the better product
  behavior: alerts are best-effort, and the same fetch failure already
  breaks the wrap-up greenlight check, so the session degrades consistently.
- **v1 event names verified from source, not SSE probe**: v1.18.9 publishes
  `question.asked`/`question.replied`/`question.rejected`
  (`packages/schema/src/v1/question.ts`) and `permission.asked`/
  `permission.replied` (`packages/schema/src/v1/permission.ts`); the
  installed v1 SDK's `types.gen.d.ts` is stale (no question events, and
  `permission.updated` is a legacy type with no publish site). The events
  flow through the plugin event hook as untyped `{type, properties}`, so
  SDK staleness is harmless.
- **v2 idle translation reused**: v2's SSE stream delivers the idle signal
  as `session.execution.*` events (the existing `translateEvent` mapping),
  so pause events needed translation cases there rather than a new
  subscription path.
