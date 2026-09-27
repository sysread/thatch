# Notifications

Thatch can notify you out-of-band when something happens worth leaving the
terminal for: a CI run finishing, a merge or deploy completing, a watched PR
receiving a comment, or your LLM finishing its work while you are in another
window. The notification is a desktop banner, a spoken voice announcement, or
both, depending on your preferences.

Two mechanisms:

- **Agent-initiated** (`thatch_notify_user`): the LLM decides something is
  worth interrupting you for and calls the tool. Works on every host
  (opencode, Claude Code, Cursor) because it is plain child processes, not
  host plumbing.
- **Automatic alerts** (opencode only): the plugin watches the session and
  notifies you when the LLM pauses for your input or finishes a round of real
  work -- no tool call required. See the Alerts section below.

## The tools

| Tool | What it does |
|------|-------------|
| `thatch_notify_user` | Send a banner and/or spoken notification. |
| `thatch_config_get` | Read the current config, with defaults annotated. |
| `thatch_config_set` | Update config fields. Returns the resulting section. |

### notify_user

```text
thatch_notify_user(message: "CI is green, clear for merge",
                   source: "PLAT-280")
```

- **macOS**: banner via Notification Center (with an alert sound) and voice
  via the built-in `say` command.
- **Linux**: banner via `notify-send` (libnotify) and voice via
  `spd-say`/`espeak` when installed. Missing tools are reported, never fatal.
- **Windows**: not supported. The tool reports this instead of guessing.

The agent includes a `source` label (a ticket number or feature name) so you
know which of your concurrent sessions is speaking. Voice text spells out
letter sequences ("C I green", not "CI green") so text-to-speech pronounces
them.

The tool result reports command success only. macOS focus modes can silently
swallow banners; if you are not seeing them, check Focus settings and that
your terminal app has notification permission.

## Configuring notifications

You have two options, and they edit the same file:

1. **Ask your agent.** "Set notifications to banner only" -- the agent reads
   current values with `config_get`, changes what you asked for with
   `config_set`, and shows you the result.
2. **Edit the file yourself.** The config lives at
   `~/.config/thatch/config.json` (next to `thatch.db`, or under
   `$XDG_CONFIG_HOME`).

```json
{
  "notifications": {
    "mode": "both",
    "voice": "Zarvox",
    "sound": "Submarine"
  }
}
```

| Field | Values | Default | Applies to |
|-------|--------|---------|------------|
| `mode` | `both`, `banner`, `voice`, `none` | `both` | Which channels `notify_user` uses. `none` disables notifications entirely; the agent is told it no-opped. |
| `voice` | any installed voice name | `Zarvox` (macOS) | Spoken announcements. List macOS voices with `/usr/bin/say -v '?'`. |
| `sound` | any system sound name | `Submarine` (macOS) | Banner alert sound. Sounds live in `/System/Library/Sounds`. |

Fields you leave out fall back to the defaults. Unknown sections or fields
are rejected when the file is read, and the config is ignored with a warning
if it cannot be parsed -- a broken hand edit never crashes the agent, it just
falls back to defaults.

The agent can manage the whole file for you through `config_get` /
`config_set`; edits merge at the field level, so the agent changing your
voice cannot wipe your mode.

## Alerts: notifications without a tool call

On opencode, the plugin watches your session and alerts you automatically:

| Alert | Fires when | Default |
|-------|-----------|---------|
| `pause` | The LLM asks you an interactive question, or requests a permission it needs approved. | banner |
| `done` | A round of real work finishes -- meaning the turn started from a prompt you typed AND ran at least one real tool. | banner |
| `error` | The session fails with nothing to recover it. Failures opencode retries through are silent, and so are turns you aborted yourself. | banner |

Rounds that stay silent even when they ran real tools: anything triggered by
async agent activity rather than a prompt you typed -- thatch's own nudges,
background-task completions, and watcher wake-ups. A watcher that wakes the
session and merges a branch announces itself; the finished round does not
banner a second time. A round delegated entirely to subagents stays silent
too (the dispatch is bookkeeping; the child sessions never alert). If you
want the LLM to decide when a watcher outcome is worth interrupting you
for, that is what `thatch_notify_user` is for.

Banners carry the session title, so when you juggle concurrent sessions you
know which one spoke. Voice is opt-in per alert: set the mode to `voice` or
`both` on the events you want spoken.

```json
{
  "alerts": {
    "pause": { "mode": "both" },
    "done": { "mode": "banner" },
    "error": { "mode": "both" }
  }
}
```

Each event's `mode` takes the same values as `notifications.mode`. Configure
them the same two ways -- ask your agent, or edit `config.json` directly.

When you want the LLM itself to decide something is worth interrupting you
for (a decision it cannot make alone), that is what `thatch_notify_user` is
for -- the automatic alerts and the tool are independent channels.

## Limitations

- Banners are best-effort by nature of the OS. The agent can only report
  whether the command ran, not whether you saw the banner.
- Speech is awaited: the tool returns after the sentence finishes. Notifications
  are short by design.
- There is no debounce. If an agent polls a status in a tight loop, it should
  notify once at the end, not per poll.
- Alerts are opencode-only. Claude Code and Cursor have no plugin event
  stream to watch; their hosts can only notify through
  `thatch_notify_user`.
- Alerts cannot tell whether your terminal is focused. A `done` banner can
  land while you are looking at the TUI; set the event's mode to `none` if
  that bothers you more than an occasional redundant banner.
- A plugin reload or restart mid-round (a v2 plugin upgrade, a save to a dev
  shim tree) loses that round's in-memory state and stays silent. The next
  round alerts normally.
