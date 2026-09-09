# Notifications and user config

Out-of-band user notification (desktop banner + spoken voice) backed by a
hand-editable user config file. Both are plain child processes and file I/O,
so the feature works identically on every host -- opencode, Claude Code, and
Cursor -- with no host-specific plumbing and no new npm dependencies.

## Source files

| File | Role |
|------|------|
| `src/config.ts` | Zod section schemas, config file load/save/merge, platform defaults. |
| `src/notify.ts` | Per-platform dispatch for banner + voice, with an injectable spawner. |
| `src/tool-defs.ts` | `config_get`, `config_set`, `notify_user` tool definitions (shared registry, non-opencodeOnly). |

## Config design

The config is one JSON file at `~/.config/thatch/config.json`, placed next to
`thatch.db` by deriving the path from `THATCH_DB_PATH` (or the XDG default the
same way `index.ts` and `mcp.ts` derive the DB path). Tests pass an explicit
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

## Prompt surface

- `systemPrompt()` and `mcpInstructions()` list the three new tools and carry
  a short "Notifications" section: when to notify, the source-label rule, and
  the config_get-before-config_set instruction.
- `notify_user` is not `opencodeOnly`: it needs no host capabilities, so MCP
  hosts get it too. Nothing was added to `src/tools.ts` or `src/index.ts`.

## Tests

- `tests/config.test.ts` -- path derivation, missing/invalid/strict-schema
  handling, round-trip, atomic save leaves no temp files, merge keeps
  siblings, darwin defaults.
- `tests/notify.test.ts` -- command construction per platform (mock spawner
  records argv), AppleScript escaping, partial vs total failure, unsupported
  platform, plus tool-level tests (merge-no-wipe, echo, `mode: none` no-op,
  configured voice honored) with `THATCH_DB_PATH` pointed at a tempdir.
- `tests/tool-defs.test.ts` -- registry count and name list (hardcoded literals that fail loudly when the surface changes).

## QA coverage

`tests/qa/auto/uc-059-tool-prefixing.ts` asserts the full bare-name list; the
three new names are in its `expected` array.
