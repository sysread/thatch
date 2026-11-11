# Setup and Configuration

Thatch works with three AI coding tools. Each has a different
integration mechanism, but all share the same core: local embeddings,
SQLite, and the same tool definitions.

## OpenCode

OpenCode is the primary integration. Thatch runs as a plugin and requires
opencode 2.1 or newer.

### Install

```jsonc
// opencode.jsonc or opencode.json
{
  "plugin": ["@jeffober/thatch"]
}
```

OpenCode installs the plugin and its dependencies automatically on
next start.

### Async extraction

For background extraction (child sessions run in the background):

```bash
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

Without this env var, extraction still works. The child session runs
fire-and-forget instead of in the background (the parent is already
idle, so nothing waits on it).
Put it in your shell rc, `mise.toml [env]`, or `.envrc`.

### Local development

Before publishing, use a file path:

```jsonc
{ "plugin": ["./path/to/thatch/src/index.ts"] }
```

The file's default export (`{ id, setup }`) is what the host loads.

For session-tab support, the plugin must be a DIRECTORY shim so the TUI can
load the `./tui` entrypoint:

```text
~/.config/opencode/plugins/thatch/
  index.ts   export { default } from "<thatch-checkout>/src/index";
  tui.ts     export { default } from "<thatch-checkout>/src/opencode/tui-plugin";
```

Delete the old `thatch.ts` file shim in the same step - a file and a
directory shim coexisting stops plugin loading entirely (duplicate plugin
id, detected before any plugin code runs). The TUI plugin is what makes
spawned subordinate sessions appear as tabs; without it the tool still
works but no tab opens. A pre-2.x-only shim that re-exports the named
`server` export must be replaced - the named export no longer exists and
the shim fails to link.

Or place the thatch repo in `.opencode/plugins/` for auto-loading.

## Claude Code

The front door for a current Claude Code is the marketplace install - no
setup run and no global install; paste into a session:

```text
/plugin marketplace add sysread/thatch
/plugin install thatch
```

The marketplace lives in the thatch repository, and its plugin entry
fetches the published npm package: the npm release IS the plugin
release, with one version and one update path (`claude plugin update
thatch`, or "Update now" in the `/plugin` panel). The installed plugin
is the same shape the plugin regime below generates - the bundled MCP
server, launched as `bun <install>/bin/thatch mcp --bundled` from the
installed copy, plus the in-process mod - and the server writes the
CLAUDE.md instructions block at its first startup, so even this path
gets the instructions without a setup run. Requires Claude Code 2.1.287
or newer (the mods floor), enterprise policy permitting mods, and bun
on PATH.

Thatch also installs as a Claude Code plugin via setup (see "The plugin
regime" below). `--hooks` installs the classic integration instead - a
standalone MCP server plus settings hooks:

```bash
thatch setup --claude                    # the plugin regime (the default)
thatch setup --claude --hooks            # the hooks regime, project-local (.mcp.json, CLAUDE.md, .claude/)
thatch setup --claude --hooks --global   # the hooks regime, user-scoped (~/.claude/)
```

Skills follow the install scope: project-local installs them to the
repo's `.claude/skills/` so they version with the project; `--global`
installs them to `~/.claude/skills/` (or `$CLAUDE_CONFIG_DIR/skills/`).

To refresh just the skill files without rewriting anything else, add
`--skills-only`:

```bash
thatch setup --claude --skills-only
```

This skips the MCP config, instructions, hooks, and commands, and
reports the same skills directory and install counts as a full run.

Commands install the same way for any harness that reads a commands
directory - complete command files (frontmatter description,
user-message section, body) that work without thatch managing them:

```bash
thatch setup --commands-only <dir>   # writes <dir>/thatch/<name>.md
```

The `thatch/` subdirectory preserves the `/thatch/` invocation
namespace. On Claude Code and Cursor, run a full `--claude`/`--cursor`
setup instead - it installs commands with the host's tool spelling.

### The plugin regime (the default for current Claude Code)

```bash
thatch setup --claude              # the plugin regime (the default)
thatch setup --claude --hooks      # the hooks regime (the explicit opt-out)
```

The plugin regime installs thatch as a Claude Code PLUGIN instead of
hooks: an in-process mod (context injection at each prompt, alerts, the
chat wake poller, the wrap-up commands) plus the MCP server bundled in
the plugin. It generates the plugin directory (its server command points
at the checkout that ran setup), DEACTIVATES the hook regime's delivery
writers (the settings hooks and the `.mcp.json` entry - so nothing
delivers twice), and ENSURES the CLAUDE.md instructions block (that block
is the one instructions channel Claude Code's built-in security guard
never blocks). It prints the load command (`claude --plugin-dir <dir>`).
Re-running it refreshes the plugin in place.

Plain `thatch setup --claude` installs this regime by default when the
installed Claude Code is 2.1.287 or newer (the mods floor) - or when no
claude is installed yet (a fresh install gets a current one). Pass
`--hooks` to install the hook regime instead: for Claude Code older than
2.1.287, or enterprise policies that disable mods. `--dev` forces the
plugin regime with the version gate skipped - the dev/QA path (testing
against an old claude, or none installed, without the floor detection
deciding). Pinning is identical under the default and `--dev`: both
record the paths of the checkout that ran setup, so re-running either
from a checkout regenerates the plugin directory from it. `--plugin`
still works as a deprecated alias for `--dev` and prints a redirect.

`bun` must be on PATH (the thatch binary runs under bun). Setup is
idempotent. Re-running it updates drifted content without clobbering
unrelated config, and reports what it did: the skills directory plus
how many skills were added, updated (replaced with a newer version),
removed (retired), or already current.

If thatch skills exist in the scope you did not install to (for
example, `~/.claude/skills/` copies left over from before a repo moved
to project-local skills), setup prints a note naming that directory.
It never touches the other scope.

For a global install in the hooks regime, setup prints the
`claude mcp add --scope user` command to run instead of writing a
project `.mcp.json`. The plugin regime needs no MCP registration at
any scope - the server is bundled in the generated plugin.

## Cursor

```bash
thatch setup --cursor            # project-local (.cursor/mcp.json, AGENTS.md, .cursor/hooks.json)
thatch setup --cursor --global   # user-scoped (~/.cursor/)
```

Skills follow the install scope: project-local installs them to the
repo's `.cursor/skills/`; `--global` installs them to `~/.cursor/skills/`.

As with Claude Code, `--skills-only` refreshes just the skill files and
skips the MCP config, instructions, and hooks.

Cursor uses a flat hooks format (`{version, hooks:{event:[{command}]}}`)
and `--json` output for hook commands.

## Other harnesses

The MCP server and the skills are not tied to Claude Code or Cursor.
For any other MCP harness, print the server config, paste it into your
harness's config, and install the skills where that harness reads them.

Print the config:

```bash
thatch setup --mcp-json
```

The output is the `mcpServers` shape used by Claude Code, Cursor, Gemini
CLI, and many other MCP clients. Some harnesses use a different key or
format; check your harness's docs. (opencode uses a different shape; its
users get everything from the plugin instead.) The printed entry sets no
project directory. The project-local configs that setup writes for
Claude Code and Cursor add the project directory for you. If your
harness starts the server from the project root, the server finds the
project on its own.

Install the skills into a directory of your choosing by passing the
directory to `--skills-only`. No host flag is needed:

```bash
thatch setup --skills-only ~/.my-harness/skills
```

A relative path is read from the directory you run the command from.
Both flags combine into one run, and stdout then carries only the JSON
so it can be piped. Passing `--claude`, `--cursor`, or `--local`
alongside an explicit directory has no effect (setup prints a note).
`--global` with an explicit directory is an error.

## Environment variables

Only a subset of the knobs is listed here. `config_get`'s `environment`
section lists every knob, its default, and the value in your running
process; the registry itself is `src/env-knobs.ts`.

| Variable | Default | What it controls |
|----------|---------|-----------------|
| `THATCH_DB_PATH` | `~/.config/thatch/thatch.db` | SQLite database path |
| `THATCH_MODEL` | `Xenova/bge-small-en-v1.5` | Hugging Face model name for embeddings |
| `THATCH_EMBEDDING_BACKEND` | `wasm` | Set to `native` to run embeddings on onnxruntime-node (NAPI) instead of the wasm runtime |
| `THATCH_MODEL_CACHE` | platform per-user cache dir | Where downloaded model files are stored |
| `THATCH_RECALL_THRESHOLD` | `0.55` | Cosine threshold for recall nudge |
| `THATCH_PREDICTION_THRESHOLD` | `0.60` | Cosine threshold for prediction auto-fire |
| `THATCH_BEHAVIOR_THRESHOLD` | `0.60` | Cosine threshold for behavior auto-fire |
| `THATCH_NO_NOTIFY` | off | Set to `1` to silence all thatch desktop notifications (banners and voice), regardless of the config file |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | (unset) | Enables async extraction (opencode only) |

## Setup detection

When the MCP server starts (Claude Code or Cursor), it checks whether
`thatch setup` was run for the current host. If setup was never run,
or if the instruction markers are broken (e.g., the file was edited
externally), the server emits a warning the agent can see and tell you
to run setup.

`thatch doctor` runs the same checks on demand from a terminal, for
every host at once, plus the states the server cannot see (a stale
plugin regime, a dead dev shim, leftover fallback writers). See
[doctor.md](doctor.md).

The MCP server also auto-refreshes skills, instructions, and hooks on
every startup. This ensures the latest skill files and prompt
instructions are deployed without requiring you to manually re-run
`thatch setup` after updating thatch.

## Limitations

- For non-Nix installs, `bun` must be installed and on PATH. Thatch does
  not bundle its own runtime (the Nix package bundles it; see the
  README's Nix section).
- The embedding model (~34 MB) is downloaded once on first use and
  cached in the platform's per-user cache dir
  (`~/Library/Caches/thatch/models` on macOS (or
  `$XDG_CACHE_HOME/thatch/models` when `XDG_CACHE_HOME` is set),
  `$XDG_CACHE_HOME/thatch/models` elsewhere). Override with
  `THATCH_MODEL_CACHE`.
- There is no web UI or dashboard. All interaction is through the
  agent's tool calls and the `thatch` CLI.
- The MCP server is a long-lived process that keeps the embedding model
  loaded while it is in use, releases it after 10 idle minutes, and
  re-loads it on demand. Hook commands connect to it via a Unix domain
  socket (the sideband) to avoid loading the model themselves.

See [memory.md](memory.md) for the memory system,
[skills.md](skills.md) for skills, and [extraction.md](extraction.md)
for the fact extraction pipeline.
