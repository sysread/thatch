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
| `chat tail` | none | `--once`, `--limit N\|all`, `--match RE` (repeatable), `--from NAME`, `--to NAME`, `--since DT`, `--until DT` | none | Follow cross-session chat: sent and read events. Backlog defaults to the last 20 messages; filters apply to follow mode too. |
| (unknown) | none | none | none | Print usage, exit 1 |

## Global behavior

- No `--version`, `--help`, `-h`, or short flags. No subcommand aliases.
- Unknown command or missing required arg calls `usage()` and exits 1.
- Args are positional, parsed by hand from `process.argv.slice(2)`. No arg-parsing library.
- DB opened once at startup, closed at end (except `mcp` which closes early).
- Stores default to git remote detected by `detectRepo()`; "unknown" (no git repo, or a deleted project directory with no cache entry) degrades to "global". "global" is the shared store. "all" (search only) means project + global.

## prime

Runs the thatch-project-primer skill via an external CLI. Searches `PATH` in order: `opencode`, `agent` (Cursor CLI), `claude`. Uses the first found:
- opencode: `opencode run "<primer prompt>"`
- agent: `agent -p "<primer prompt>" --approve-mcps`
- claude: `claude "<primer prompt>"`

Inherits stdio, exits with the child's exit code. Errors and exits 1 if none found.

## chat

Read-only window on the cross-session chat directory ([cross-session-chat.md](cross-session-chat.md)):

- `chat list` renders the roster as aligned columns under a header row
  (NAME/AGE/STATUS/PROJECT/TOPIC), colorized only when stdout is a TTY
  (`formatChatRoster()` in `bin/thatch`; pipes and QA runners get plain
  text). Rows are split into Active and Stale sections by
  `splitChatRoster()`; the status column is `chatLiveness()`'s verdict
  (`fresh`/`stale` for opencode rows, `active`/`idle` for MCP rows).
- `chat tail` follows the message stream as JSONL: one `ChatTailEvent`
  per line via `formatChatTailJsonl()` (a bare `JSON.stringify`; no ANSI,
  no markdown rendering, no local-time conversion - the tail is a log for
  `jq` and `grep`). `sent` and `read` are separate events linked by the
  message `id`; broadcast fan-out is one `sent` per recipient with
  `broadcast: true` and the real `to`. Event shaping is `chatTailDiff()`
  in `src/chat.ts`, unit-tested there. `--once` prints one snapshot and
  exits; the snapshot includes a `read` event for every shown message
  whose `read_at` is set, sorted by time, so it is the same log a follow
  would have accumulated.
- The backlog prints only the last `CHAT_TAIL_DEFAULT_LIMIT` (20) messages;
  `chatTailBacklog()` in `src/chat.ts` filters the feed, seeds the diff
  state from every feed row (so the limit hides lines, not history, and a
  mid-follow rename or unregister cannot resurface old rows as sent
  events), and reports the elided count for
  the CLI's stderr note. `filterChatTailRows()` ANDs body regexes
  (`--match`, repeatable), rendered-name substrings (`--from`/`--to`,
  case-insensitive), and a half-open `--since`/`--until` window on
  `created_at`; the same filter applies to follow polls, so non-matching
  messages stay invisible (their read events too). A `--until` in the past
  exits after the backlog; one in the future follows until the window
  closes. `parseChatTimeBound()` accepts `YYYY-MM-DD [HH:MM]` local time.

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
