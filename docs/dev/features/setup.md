# Setup System

Installs thatch into Claude Code and Cursor. opencode does not need setup --- it
auto-installs skills and injects the system prompt at plugin init. All setup
operations are idempotent: re-running updates drifted content without clobbering
unrelated config.

For the concrete artifact paths and hook event tables each host writes, see
[../setup-and-hooks.md](../setup-and-hooks.md). This doc covers the architecture:
how setup commands, the marker system, detection, auto-refresh, and binary
resolution fit together.

## What it does

- `thatch setup --claude` --- installs MCP config, CLAUDE.md instructions,
  hooks, and skills for Claude Code
- `thatch setup --cursor` --- installs MCP config, AGENTS.md instructions,
  hooks, and skills for Cursor
- `--global` flag --- installs to user-scoped config dirs instead of
  project-local
- **Marker system** --- idempotent replacement of the thatch instruction block
  in `CLAUDE.md` or `AGENTS.md` via start/end markers
- **`checkSetup`** --- detects installed, not-installed, or markers-broken at
  MCP server startup
- **Auto-refresh** --- MCP server re-runs setup on startup if installed,
  updating drifted content
- **Setup warning surfacing** --- first `tools/call` response prepends a
  warning if setup was not run
- **Binary resolution** --- uses bare `thatch` if on PATH (survives updates),
  else the absolute path to the running script

## How it works

### Setup commands

At least one of `--claude` or `--cursor` is required. Both can be passed
together. `--global` applies to whichever host or hosts are selected.

### Claude Code setup (`setupClaudeCode` in `src/setup.ts`)

Four artifacts, all idempotent:

1. **MCP config** --- project-local writes `.mcp.json` with a stdio thatch
   MCP server entry. Global prints a `claude mcp add --scope user thatch --
   <bin> mcp` command for the user to run (does not write a file, because
   `~/.claude.json` is too complex to write directly).
2. **Instructions** --- appends `claudeInstructions()` to `CLAUDE.md` between
   start and end markers (`THATCH_MARKER` / `THATCH_END_MARKER`). Project-local:
   `<projectDir>/CLAUDE.md`. Global: `$CLAUDE_CONFIG_DIR/CLAUDE.md`.
3. **Hooks** --- writes to `.claude/settings.json` (project) or
   `$CLAUDE_CONFIG_DIR/settings.json` (global). Three hooks: `SessionStart`
   → `thatch reminder`, `PostToolBatch` → `thatch buffer-batch`,
   `UserPromptSubmit` → `thatch flush-tools`. Nested format:
   `{hooks:{Event:{hooks:[{type,command}]}}}`.
4. **Skills** --- installs to `$CLAUDE_CONFIG_DIR/skills/` (always
   user-scoped, even for project-local setup). `SHARED_SKILLS` only --- the
   code-review coordinator requires sub-agent dispatch, which Claude Code
   does not support.

### Cursor setup (`setupCursor` in `src/setup.ts`)

Four artifacts, same idempotent pattern:

1. **MCP config** --- writes `.cursor/mcp.json` (project) or
   `$CURSOR_CONFIG_DIR/mcp.json` (global). Same JSON shape as Claude Code.
   No `claude mcp add` equivalent needed --- Cursor reads the config file
   directly.
2. **Instructions** --- appends `cursorInstructions()` to `AGENTS.md` between
   markers (`CURSOR_MARKER` / `CURSOR_END_MARKER`). Project-local:
   `<projectDir>/AGENTS.md`. Global: `$CURSOR_CONFIG_DIR/AGENTS.md`.
3. **Hooks** --- writes to `.cursor/hooks.json` (project) or
   `$CURSOR_CONFIG_DIR/hooks.json` (global). Flat format:
   `{version:1, hooks:{event:[{command}]}}`. Three hooks: `sessionStart`
   → `thatch reminder --json`, `postToolUse` → `thatch buffer-tool`,
   `beforeSubmitPrompt` → `thatch flush-tools --json`.
4. **Skills** --- installs to `$CURSOR_CONFIG_DIR/skills/` (shared only).

### Marker system (`appendBlock`)

`appendBlock(path, instructions, startMarker, endMarker)` handles three cases:

1. **Both markers found** --- replace content between them. Preserve text
   before the start marker and after the end marker. This is the normal
   update path: re-running setup replaces the thatch block without touching
   user-written content elsewhere in the file.
2. **Start marker found but end missing** --- leave the file alone. This is a
   corrupted state --- someone edited the file and accidentally removed the
   end marker. Writing would risk clobbering content that follows the start
   marker. `checkSetup` reports this as `markers-broken`.
3. **No markers** --- append instructions to the end of the file (with a
   separator). Create the file if it does not exist.

Start markers differ by host (the text says "Claude Code" or "Cursor"). The end
marker is shared.

### `checkSetup` (`src/setup.ts`)

Detects the host from environment variables set by the host process:

- `CURSOR_PROJECT_DIR` set → Cursor
- `CLAUDE_PROJECT_DIR` set (and Cursor not) → Claude Code
- Neither set → returns `null` (manual `thatch mcp` invocation, no check)

Cursor takes priority because Cursor also sets `CLAUDE_PROJECT_DIR` as an
alias. Without the priority check, Cursor sessions would be misidentified as
Claude Code.

`checkSetup` looks for start and end markers in the host's instructions file
--- `CLAUDE.md` for Claude Code, `AGENTS.md` for Cursor. It checks local first,
then global. Local takes priority.

| Outcome | Condition | Action |
|---------|-----------|--------|
| **installed** | Both markers found (local or global) | No warning |
| **not-installed** | No instructions file with markers | Warning surfaced on first `tools/call` |
| **markers-broken** | Start marker found, end marker missing | Warning with file path and fix instructions |

### Auto-refresh at MCP startup

If `checkSetup` returns `installed`, the MCP server re-runs `setupClaudeCode`
or `setupCursor` with the same scope. This updates skills, instructions, and
hooks that drifted since the last `thatch setup`. All operations are
idempotent --- they only write when content differs. Failure is best-effort
and logged to stderr.

This is how installations stay current without the user manually re-running
setup after upgrading thatch. The next MCP session picks up new skill content,
updated instructions, and any hook changes automatically.

### Setup warning surfacing

On the first `tools/call` response, if a setup warning exists, the server
prepends `[thatch] {warning}` to the tool's text output. The agent sees it
and can tell the user to run `thatch setup`. The warning is cleared after one
surfacing so it does not repeat on every tool call.

### Binary resolution

Setup resolves the thatch binary via `Bun.which("thatch")`. If `thatch` is on
`PATH` (npm global install, opencode plugin install), it uses the bare name.
This survives updates --- the resolved path points to whatever `thatch` is
current at hook execution time, not a stale absolute path.

If `thatch` is not on `PATH`, setup falls back to the absolute path of the
running script. This handles one-off invocations (e.g., `bun run bin/thatch
setup --claude`).

The resolved binary is baked into every installed hook command. Hooks are
short-lived processes spawned by the host after the setup session ends, so
they cannot rely on the original process's environment. The baked-in path
ensures hooks keep working across sessions.

### Hook replacement

`replaceThatchHooks` / `replaceCursorThatchHooks` filter out any existing hook
group whose `command` contains the string `thatch`, then add the current
ones. Non-thatch hooks are preserved. This handles legacy hooks --- for
example, an older `thatch echo` hook is replaced with the current
`flush-tools` hook without touching hooks from other tools.

## Interactions with other features

- [Multi-host](multi-host.md) --- setup is the installation mechanism for
  Claude Code and Cursor. opencode auto-installs at plugin init.
- [Skills](../skills.md) --- setup installs skills as part of the install.
  Skill content is plugin-owned and overwritten on drift.
- [Nudge pipeline](nudge-pipeline.md) --- setup installs the hooks that drive
  the nudge pipeline for MCP hosts.
- [Extraction](extraction.md) --- setup installs the `buffer-batch` /
  `buffer-tool` hooks that feed the file-backed extraction queue.
- [Sideband](sideband.md) --- setup installs `flush-tools`, which connects to
  the sideband socket for warm-model access during nudge evaluation.

## Source files

| File | Role |
|------|------|
| `src/setup.ts` | `setupClaudeCode`, `setupCursor`, `checkSetup`, `appendBlock`, marker definitions, hook replacement |
| `bin/thatch` | `setup` subcommand --- parses flags, dispatches to `setupClaudeCode` / `setupCursor` |
| `src/prompts.ts` | `claudeInstructions`, `cursorInstructions` --- the instruction text appended to `CLAUDE.md` / `AGENTS.md` |

## Key invariants

1. **All operations are idempotent.** Re-running setup updates drifted content
   without clobbering. Instructions use markers, hooks filter by `thatch`
   string, MCP config preserves existing servers, skills diff before writing.
2. **Skills are always user-scoped**, even in project-local setup. Claude Code
   and Cursor load skills from the user config dir, not the project.
3. **`appendBlock` leaves content alone if markers do not parse.** A start
   marker without an end marker means the file was edited externally. Writing
   would risk clobbering content after the start marker.
4. **Binary path is baked into hook commands.** Hooks are short-lived
   processes that outlive the setup session. The resolved path ensures they
   keep working.
5. **Non-thatch hooks are preserved during hook replacement.** Only hooks
   whose `command` contains `thatch` are filtered out.
6. **Auto-refresh keeps installations current.** The MCP server re-runs
   setup on startup if markers are present, picking up new skills and
   updated instructions without manual intervention.
