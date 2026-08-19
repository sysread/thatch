# Setup and Configuration

Thatch works with three AI coding tools. Each has a different
integration mechanism, but all share the same core: local embeddings,
SQLite, and the same tool definitions.

## OpenCode

OpenCode is the primary integration. Thatch runs as a plugin.

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
synchronously instead of asynchronously (blocks the turn briefly).
Put it in your shell rc, `mise.toml [env]`, or `.envrc`.

### Local development

Before publishing, use a file path:

```jsonc
{ "plugin": ["./path/to/thatch/src/index.ts"] }
```

Or place the thatch repo in `.opencode/plugins/` for auto-loading.

## Claude Code

Thatch runs as an MCP server. The setup command installs the server
config, instructions, hooks, and skills:

```bash
thatch setup --claude            # project-local (writes .mcp.json, CLAUDE.md, .claude/)
thatch setup --claude --global   # user-scoped (~/.claude/)
```

`bun` must be on PATH (the thatch binary runs under bun). Setup is
idempotent. Re-running it updates drifted content without clobbering
unrelated config.

For a global install, setup prints the `claude mcp add --scope user`
command to run instead of writing a project `.mcp.json`.

## Cursor

```bash
thatch setup --cursor            # project-local (.cursor/mcp.json, AGENTS.md, .cursor/hooks.json)
thatch setup --cursor --global   # user-scoped (~/.cursor/)
```

Cursor uses a flat hooks format (`{version, hooks:{event:[{command}]}}`)
and `--json` output for hook commands.

## Environment variables

| Variable | Default | What it controls |
|----------|---------|-----------------|
| `THATCH_DB_PATH` | `~/.config/thatch/thatch.db` | SQLite database path |
| `THATCH_MODEL` | `Xenova/bge-small-en-v1.5` | Hugging Face model name for embeddings |
| `THATCH_RECALL_THRESHOLD` | `0.55` | Cosine threshold for recall nudge |
| `THATCH_PREDICTION_THRESHOLD` | `0.60` | Cosine threshold for prediction auto-fire |
| `THATCH_BEHAVIOR_THRESHOLD` | `0.60` | Cosine threshold for behavior auto-fire |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | (unset) | Enables async extraction (opencode only) |

## Setup detection

When the MCP server starts (Claude Code or Cursor), it checks whether
`thatch setup` was run for the current host. If setup was never run,
or if the instruction markers are broken (e.g., the file was edited
externally), the server emits a warning the agent can see and tell you
to run setup.

The MCP server also auto-refreshes skills, instructions, and hooks on
every startup. This ensures the latest skill files and prompt
instructions are deployed without requiring you to manually re-run
`thatch setup` after updating thatch.

## Limitations

- `bun` must be installed and on PATH. Thatch does not bundle its
  own runtime.
- The embedding model (~34 MB) is downloaded once on first use and
  cached in `node_modules/@huggingface/transformers/.cache/`.
- There is no web UI or dashboard. All interaction is through the
  agent's tool calls and the `thatch` CLI.
- The MCP server is a long-lived process that holds the warm embedding
  model in memory. Hook commands connect to it via a Unix domain
  socket (the sideband) to avoid loading the model themselves.

See [memory.md](memory.md) for the memory system,
[skills.md](skills.md) for skills, and [extraction.md](extraction.md)
for the fact extraction pipeline.
