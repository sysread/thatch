# Notifications

Thatch can notify you out-of-band when something happens worth leaving the
terminal for: a CI run finishing, a merge or deploy completing, a watched PR
receiving a comment. The notification is a desktop banner, a spoken voice
announcement, or both, depending on your preferences.

This works on every host (opencode, Claude Code, Cursor) because it is plain
child processes, not host plumbing.

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

## Limitations

- Banners are best-effort by nature of the OS. The agent can only report
  whether the command ran, not whether you saw the banner.
- Speech is awaited: the tool returns after the sentence finishes. Notifications
  are short by design.
- There is no debounce. If an agent polls a status in a tight loop, it should
  notify once at the end, not per poll.
