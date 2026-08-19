# CLI

Thatch ships with a command-line tool for inspecting memories and
running maintenance tasks outside the agent. It requires `bun` on your
PATH.

## Memory inspection

```bash
thatch stores                  # list all stores
thatch list [store]            # list memory labels in a store
thatch show <label> [store]    # display one memory by label
thatch forget <label> [store]  # delete one memory by label
thatch search <query> [store]  # semantic search (cosine similarity)
```

Store defaults to your current git repo (detected from `git remote
get-url origin`). Use `global` for the shared global store. Use `all`
with `search` to search the project store and `global` together.

`search` uses the same cosine-similarity search as
`thatch_memory_recall`. Results include a similarity score for each
match. Limited to 10 results.

## Maintenance

```bash
thatch hygiene                 # print the hygiene report
thatch reminder [--json]       # print the session-start reminder
```

`hygiene` prints the standalone hygiene report (duplicate candidates,
stale entries, orphaned branch memories). See
[hygiene.md](hygiene.md).

`reminder` prints the full session-start reminder including the
hygiene report. The `--json` flag wraps the output as
`{"additional_context": "..."}` for Cursor's hook format. These
commands are normally called by hooks, not by hand, but you can run
them to see what the agent sees at session start.

## Priming a new project

```bash
thatch prime
```

Runs the `thatch-project-primer` skill via an external CLI. Thatch
searches your PATH for `opencode`, `agent` (Cursor CLI), or `claude`
in that order. The first one found is used to run the primer, which
investigates the codebase from multiple angles and writes foundational
memories.

This is the same skill the agent can load manually, but `thatch prime`
runs it in a dedicated session focused on project investigation.

## Infrastructure commands

These commands are called by hooks installed by `thatch setup`. You
should not need to run them by hand.

```bash
thatch mcp                      # start the stdio MCP server
thatch buffer-batch             # append tool batch to queue (Claude Code hook)
thatch buffer-tool              # append single tool to queue (Cursor hook)
thatch flush-tools [--json]     # peek queue + print nudges (hook)
thatch flush-predictions [--json]  # prediction-only nudge (hook)
thatch setup --claude [--cursor] [--global]  # install config + hooks + skills
```

## Environment variables

| Variable | Default | What it controls |
|----------|---------|-----------------|
| `THATCH_DB_PATH` | `~/.config/thatch/thatch.db` | SQLite database path |
| `THATCH_MODEL` | `Xenova/bge-small-en-v1.5` | Embedding model name |
| `THATCH_RECALL_THRESHOLD` | `0.55` | Cosine threshold for recall nudge |
| `THATCH_PREDICTION_THRESHOLD` | `0.60` | Cosine threshold for prediction auto-fire |
| `THATCH_BEHAVIOR_THRESHOLD` | `0.60` | Cosine threshold for behavior auto-fire |
| `CLAUDE_PROJECT_DIR` | `process.cwd()` | Claude Code project directory |
| `CURSOR_PROJECT_DIR` | (falls through) | Cursor project directory |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config directory |
| `CURSOR_CONFIG_DIR` | `~/.cursor` | Cursor config directory |

## Limitations

- Requires `bun` on PATH. Thatch does not bundle its own runtime.
- `search` is limited to 10 results. There is no pagination.
- `prime` requires an external CLI (`opencode`, `agent`, or `claude`)
  on PATH. If none is found, it exits with an error.
- Infrastructure commands (`mcp`, `buffer-batch`, `buffer-tool`,
  `flush-tools`, `flush-predictions`) are meant for hooks, not manual
  use. Running them by hand can produce confusing output.
- There is no web UI or dashboard. All inspection is through the CLI
  or the agent's tool calls.

See [setup.md](setup.md) for installation and [memory.md](memory.md)
for the memory system.
