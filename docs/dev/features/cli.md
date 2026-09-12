# CLI (bin/thatch)

The thatch CLI is a Bun script at `bin/thatch`. It provides memory inspection, MCP server startup, hook commands for MCP hosts, the setup installer, session archaeology over the opencode database, and a read-only window on the cross-session chat directory.

## Subcommands

| Command | Args | Flags | Stdin | Purpose |
|---------|------|-------|-------|---------|
| `stores` | none | none | none | List all store names |
| `list [store]` | optional store | none | none | List memory labels in a store |
| `show <label> [store]` | label, optional store | none | none | Display one memory by label |
| `forget <label> [store]` | label, optional store | none | none | Delete one memory by label |
| `search <query> [store]` | query, optional store | none | none | Semantic cosine search (limit 10; "all" searches project + global) |
| `mcp` | none | none | none | Start the stdio MCP server (for Claude Code, Cursor) |
| `reminder [--json]` | none | `--json` | none | Print session-start reminder + hygiene report |
| `hygiene` | none | none | none | Print the hygiene report standalone |
| `prime` | none | none | none | Run thatch-project-primer skill via opencode/agent/claude CLI |
| `buffer-batch` | none | none | JSON | Append PostToolBatch payload to queue (Claude Code hook) |
| `buffer-tool` | none | none | JSON | Append single postToolUse interaction to queue (Cursor hook) |
| `flush-tools [--json]` | none | `--json` | JSON | Peek queue + extraction/recall/prediction/behavior/write nudge |
| `flush-predictions [--json]` | none | `--json` | JSON | Standalone prediction-only nudge |
| `setup --claude [--cursor] [--global]` | none | `--claude`, `--cursor`, `--global` | none | Install config + instructions + hooks + skills |
| `session list/get/transcript/search` | per subcommand | `-s/--session`, `--id`, `--after`, `--before`, `--regex`, `--limit` | none | Read-only archaeology on the opencode session database (JSONL output) |
| `chat list` | none | none | none | Registered chat sessions: name, human-readable age, project, topic |
| `chat tail [--once]` | none | `--once` | none | Follow cross-session chat: sent and read events (`--once` prints the backlog and exits) |
| (unknown) | none | none | none | Print usage, exit 1 |

## Global behavior

- No `--version`, `--help`, `-h`, or short flags. No subcommand aliases.
- Unknown command or missing required arg calls `usage()` and exits 1.
- Args are positional, parsed by hand from `process.argv.slice(2)`. No arg-parsing library.
- DB opened once at startup, closed at end (except `mcp` which closes early).
- Stores default to git remote detected by `detectRepo()`; "unknown" on failure. "global" is the shared store. "all" (search only) means project + global.

## prime

Runs the thatch-project-primer skill via an external CLI. Searches `PATH` in order: `opencode`, `agent` (Cursor CLI), `claude`. Uses the first found:
- opencode: `opencode run "<primer prompt>"`
- agent: `agent -p "<primer prompt>" --approve-mcps`
- claude: `claude "<primer prompt>"`

Inherits stdio, exits with the child's exit code. Errors and exits 1 if none found.

## chat

Read-only window on the cross-session chat directory ([cross-session-chat.md](cross-session-chat.md)):

- `chat list` renders the roster: display name, human-readable age since the
  last heartbeat, project, and topic when set.
- `chat tail [--once]` follows the message stream. Sent lines have the shape
  `[timestamp] from -> to: body` (broadcast rows render `broadcast` via the
  `via_broadcast` marker); in follow mode, an inbox drain emits a read line
  (`[timestamp] to read a message from from: preview`). The diff logic is
  `chatTailDiff()`/`formatChatTailEvent()` in `src/chat.ts`, unit-tested
  there; `--once` prints one snapshot and exits, because a snapshot has no
  previous state to diff read events against.

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `XDG_CONFIG_HOME` | Config home base | `~/.config` |
| `THATCH_DB_PATH` | SQLite DB file location | `$XDG_CONFIG_HOME/thatch/thatch.db` |
| `THATCH_MODEL` | Embedding model override | `Xenova/bge-small-en-v1.5` |
| `THATCH_RECALL_THRESHOLD` | Cosine cutoff for recall nudge | `0.55` |
| `THATCH_PREDICTION_THRESHOLD` | Cutoff for prediction auto-fire | `0.60` |
| `THATCH_BEHAVIOR_THRESHOLD` | Cutoff for behavior auto-fire | `0.60` |
| `CLAUDE_PROJECT_DIR` | Claude Code project dir | `process.cwd()` |
| `CURSOR_PROJECT_DIR` | Cursor project dir | falls through |
| `CLAUDE_CONFIG_DIR` | Claude config dir | `~/.claude` |
| `CURSOR_CONFIG_DIR` | Cursor config dir | `~/.cursor` |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | Enable async extraction | unset |

## Source files

- `bin/thatch` — the CLI (Bun script)
- `bin/release` — release helper (bash, separate from the main CLI)

## Interactions with other features

- Memory store ([memory-store.md](memory-store.md)): `stores`, `list`, `show`, `forget`, `search` subcommands
- Setup ([setup.md](setup.md)): `setup` subcommand
- Nudge pipeline ([nudge-pipeline.md](nudge-pipeline.md)): `flush-tools`, `flush-predictions`, `reminder` subcommands
- Extraction ([extraction.md](extraction.md)): `buffer-batch`, `buffer-tool`, `flush-tools` subcommands
- Hygiene ([hygiene.md](hygiene.md)): `hygiene`, `reminder` subcommands
- Multi-host ([multi-host.md](multi-host.md)): `mcp` subcommand starts the MCP server for Claude Code and Cursor
- Session archaeology: the `session` subcommand group (see the table above) reads the opencode session database via `src/session-db.ts`
- Cross-session chat ([cross-session-chat.md](cross-session-chat.md)): the `chat` subcommand group reads the shared chat directory and inbox

## Key invariants

- No arg-parsing library. Args are positional, parsed by hand from `process.argv.slice(2)`.
- No `--version`, `--help`, `-h`, or short flags. No subcommand aliases.
- DB opened once at startup, closed at end (except `mcp` which closes early).
- Store name auto-detected from git remote. "global" is the shared store. "all" (search only) means project + global.
- Unknown command or missing required arg calls `usage()` and exits 1.
- `prime` searches PATH in order: `opencode`, `agent`, `claude`. Uses the first found.
