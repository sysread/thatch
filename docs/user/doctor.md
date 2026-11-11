# Doctor

`thatch doctor` checks your environment setup and reports what it finds:
the database, the opencode plugin install, the Claude Code regime, and
Cursor's config. It is the command to run when thatch seems silent,
half-installed, or doubled.

```bash
thatch doctor
```

## Reading the output

Each check prints one line with a verdict tag and, when something needs
action, an indented fix line naming the repair:

```text
opencode
  [pass]  plugin: @jeffober/thatch in ~/.config/opencode/opencode.json
  [warn]  shim: no tui.ts beside index.ts - session tabs will not open (the core plugin still works)
      fix: add ~/.config/opencode/plugins/thatch/tui.ts re-exporting the checkout's src/opencode/tui-plugin (docs/user/setup.md)
claude
  [fail]  regime: the regime marker says the plugin regime owns this install, but no plugin directory exists
      fix: thatch setup --claude regenerates the plugin, or thatch setup --claude --hooks returns to the hooks regime
```

- `[pass]` - the check found the expected state.
- `[warn]` - degraded or stale, with an innocent reading named in the
  detail. Act on it only if it surprises you.
- `[fail]` - broken; the fix line names the repair.
- `[info]` - a neutral observation (a host not installed, no npm check
  yet). Absent hosts are information, never failures.

The exit code is 0 when no check failed and 1 when any check failed
(warnings do not affect it), so scripts can gate on real breakage.

## What it checks

**Common**: the database answers a query; this thatch's version against
the latest npm release a running process has seen (the hourly poll any
host's long-running process performs).

**OpenCode**: the opencode binary and its version against the 2.1 plugin
floor; the plugin install surfaces (the `@jeffober/thatch` entry in
`opencode.json`/`opencode.jsonc`, a `.opencode/plugins/` auto-load dir,
or the dev shim in `~/.config/opencode/plugins/`); the shim's health
(a file and directory shim coexisting stops ALL plugin loading, a dead
re-export target fails to load, a missing `tui.ts` only loses session
tabs, a checkout version drift is reported); and daemon evidence - a
fresh chat heartbeat from an opencode session means a daemon with the
plugin is live. No heartbeat is not proof the plugin is unloaded: a
daemon whose sessions never registered in chat leaves no trace.

**Claude Code**: the claude binary and its version against the 2.1.287
mods floor; then the regime - under the plugin regime, the plugin
directory, the manifest's source consistency (the bundled server's
checkout must match the plugin the mod came from), the built mod bundle,
the mod's ping freshness, and the fallback writers that must not survive
(no settings hooks, no `.mcp.json` entry, no user-scope MCP registration
- each survivor delivers every prompt twice); under the hooks regime,
the instructions markers and the settings hooks, and their agreement;
always, the legacy home-root `~/CLAUDE.md` sweep state.

A stale mod ping reads as a warning, not an alarm: the detail names the
innocent readings (claude is not running; the plugin was regenerated and
not loaded yet) and the real one (the mod's hooks are disabled while its
server lives, or the plugin was never loaded).

**Cursor**: the standalone-server config entry, the AGENTS.md
instructions markers, and the hooks. Cursor has no plugin regime, so
there is nothing deeper to check - the boundary is the standalone server
plus hooks integration.

## The doctor never changes anything

The doctor is advice only. It never writes, deletes, or reconfigures -
not your configs, not the plugin directory, not the regime marker.
Repairs go through `thatch setup`. This is deliberate: a diagnostic that
mutates state cannot be run safely to figure out what is wrong.

See [setup.md](setup.md) for the install paths the doctor inspects and
[cli.md](cli.md) for the CLI's other commands.
