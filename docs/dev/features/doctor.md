# Feature: Doctor

The doctor (`thatch doctor`) is the on-demand diagnostic surface: a
read-only sweep of every host's install state, reporting one finding per
check with a verdict and a fix. It exists because the states it checks
are otherwise invisible - a dead plugin regime, a shim pointing at a
deleted checkout, settings hooks that survived a regime switch - and the
surfaces that would notice them are the ones that stop working when the
state is broken.

## Design: host-relevant advice, on demand

The governing contract: claude-scoped (or any host-scoped) state is
reportable HERE and only here - the human ran a diagnostic deliberately.
The same state must never leak into host-agnostic surfaces. That leak
was the bug this command retired: the global CLI dispatch path printed
the plugin-regime "not loaded or pinged" warning on every terminal
command, so mixed-host machines (opencode beside claude's plugin regime)
saw claude alarms whenever claude hadn't recently run. The dispatch
warning is gone; the doctor is the warning's permanent home, and the
bundled server's per-tools/call staleness warning remains the in-session
safety net (claude-relevant context, correctly scoped).

The same principle fixed the one other leak in the class: the standalone
MCP server warned "you are in the plugin regime, remove the standalone
entry" whenever claude's regime marker read plugin - including servers
spawned by OTHER MCP hosts (an opencode manual MCP config, the gemini
cli), whose sessions had nothing to do with claude's regime. The fix
([standaloneRegimeHost](../../src/version-check.ts)): the server
resolves its host from spawn-env evidence only (CURSOR_PROJECT_DIR for
Cursor; CLAUDE_CODE_SESSION_ID / CLAUDE_PROJECT_DIR for Claude Code) and
reads no host's regime marker without it.

## Architecture

```text
src/doctor.ts              the check engine: DoctorDeps in, DoctorFinding[] out
                             (sections: common, opencode, claude, cursor)
src/cli/commands/doctor.ts the Subcommand + the renderer (verdict tags,
                             section grouping, summary line, exit code)
tests/doctor.test.ts       the check engine's unit tests (fixture env)
tests/qa/auto/uc-145-doctor-diagnostics.ts   the end-to-end QA use case
```

The engine is pure data out - no printing - so tests assert findings and
the CLI renders them. `DoctorDeps` carries the db slice
(`listStores`, `listChatSessions`), the resolved paths (dbPath,
projectDir, home), a frozen clock, and injectable probes
(`claudeVersionOutput`, `claudeMcpGetThatch`, `opencodeVersion`) so age
and version verdicts stay deterministic under test.

### Check inventory and state sources

| Section | Check | State source |
|---------|-------|--------------|
| common | database | a query through the dispatcher's open `ThatchDB` |
| common | update | `npmCachePath`'s cache (written by any host's hourly npm poll) vs `pkg.version` |
| opencode | binary | `Bun.which("opencode")` + `--version`, compared against the 2.1 plugin floor |
| opencode | install | substring scan of opencode configs (JSONC-safe), `.opencode/plugins/` dirs, the plugins dir shim |
| opencode | shim | the shim files themselves: coexistence (duplicate plugin id), `index.ts`/`tui.ts` presence, the named `server` export (pre-2.x), the re-export target (extensionless, like bun resolves it), the target checkout's `package.json` version |
| opencode | daemon | `chat_sessions` rows with `host_kind='opencode'`: a heartbeat within CHAT_STALE_MS is plugin evidence (the poller that heartbeats is plugin code); absence is explicitly not counter-evidence |
| claude | binary / mods floor | `claudeVersionOutput` + `claudeVersionSupportsMods` (CLAUDE_MODS_FLOOR) |
| claude | regime (plugin) | the regime marker + the plugin directory's existence and scope |
| claude | plugin tree | the manifest's `mcpServers.thatch.command`, realpathed, checked against the setup-time mixed-source guard (`src/claude-plugin/mod.ts` in the server tree) and version-matched against the manifest |
| claude | ping | `readModLiveness` age vs `MOD_LIVENESS_STALE_MS` (shared with the bundled server's warning, so the surfaces never disagree) |
| claude | fallback writers | settings hooks (the writer's broad thatch match), the project `.mcp.json` entry, the user-scope registration (`claude mcp get thatch` probe) |
| claude | regime (hooks) / install / hooks | `checkSetup(projectDir, home, "claude")` (the forced-host extension) + the settings files |
| claude | legacy block | `hasThatchInstructionsBlock` on the home-root `~/CLAUDE.md` |
| cursor | install / markers / hooks | `.cursor/mcp.json` + the config dir, forced-host `checkSetup`, the flat hooks files |

The cursor boundary: the checks generalize trivially for the
standalone-server + hooks integration (config entry, markers, hooks),
and stop there - cursor has no plugin regime, no regime marker value, no
mods, so there is no ping, no plugin tree, and no regime ambiguity to
report.

### Verdicts and exit code

`pass` / `warn` / `fail` / `info`; every warn and fail carries a `fix`
string naming the repair (advice, never mutation - repairs belong to
`thatch setup`). `doctorExitCode` returns 1 only on a fail, so
`thatch doctor && ...` gates on real breakage. A host that is simply not
installed is an `info` line, never a failure.

### The not-detected merges

When a host has no binary, no config, no markers, and no hooks, its
section collapses to one `info` line instead of a column of nothings -
the output stays scannable on single-host machines. The claude merge
still runs the legacy-block check: a stale `~/CLAUDE.md` block matters
even with claude uninstalled, because any session whose cwd is under
`$HOME` loads that file.

## Interactions with other features

- Setup ([setup.md](setup.md)): the doctor's claude section reuses the
  setup resolvers (`claudeConfigDir`, `cursorConfigDir`, `checkSetup`
  with the forced-host argument), the mixed-source guard's file
  contract, and `hasThatchInstructionsBlock` (the detect-only twin of
  setup's legacy-block removal).
- Version check ([sideband.md](sideband.md) context,
  [cli.md](cli.md)): the mod-liveness stamp, the regime marker, the npm
  cache, and `MOD_LIVENESS_STALE_MS` all live in
  [src/version-check.ts](../../src/version-check.ts); the doctor is a
  reader, never a writer.
- Cross-session chat ([cross-session-chat.md](cross-session-chat.md)):
  the opencode daemon check reads the chat registry's opencode rows and
  heartbeat semantics (`CHAT_STALE_MS`, `humanAge`).
- The plugin regime (docs/dev/mcp-parity.md): the doctor is the on-demand
  home of the plugin-not-delivering signal (marker + ping); the bundled
  server's first-tools/call warning is the in-session channel.
