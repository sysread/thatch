# CLI (bin/thatch)

The thatch CLI is a Bun script at `bin/thatch`. It provides memory inspection, MCP server startup, hook commands for MCP hosts, the setup installer, session archaeology over the opencode database, and a window on the cross-session chat directory (read-only except `chat broadcast`).

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
| `setup --claude [--cursor] [--local\|--global] [--skills-only [dir]] [--mcp-json]` | none | `--claude`, `--cursor`, `--global`, `--local`, `--skills-only [dir]`, `--mcp-json` | none | Install config + instructions + hooks + skills; `--skills-only <dir>` installs into any directory; `--mcp-json` prints the server config as JSON |
| `session list/get/transcript/search` | per subcommand | `-s/--session`, `--id`, `--after`, `--before`, `--regex`, `--limit` | none | Read-only archaeology on the opencode session database (JSONL output) |
| `chat list` | none | `--recent`, `--stale [N\|all]` | none | Registered chat sessions: name, human-readable age, status, project, topic |
| `chat tail` | none | `--once`, `--pretty`, `--limit N\|all`, `--match RE` (repeatable), `--from NAME`, `--to NAME`, `--since DT`, `--until DT` | none | Follow cross-session chat: sent and read events as a JSONL log (`--pretty` for email-style cards instead). Backlog defaults to the last 20 messages; filters apply to follow mode too. |
| (unknown) | none | none | none | Print usage, exit 1 |

## Global behavior

- `--version` and `-v` print the package version and exit 0.
- `-h` and `--help` print usage and exit 0. The check runs before the DB
  is opened and before any subcommand dispatch, and scans the WHOLE
  argument list - not just the leading flags - so `thatch chat list -h`
  and `thatch -h chat list` show usage instead of executing. Explicit
  help exits 0 where a usage error exits 1.
- No other short flags. No subcommand aliases.
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

A window on the cross-session chat directory ([cross-session-chat.md](cross-session-chat.md)), read-only everywhere except `chat broadcast`, the one write path: it writes user-voiced broadcast rows through a sentinel sender (details in cross-session-chat.md's CLI access section):

- `chat list` renders the roster as aligned columns under a header row
  (NAME/SESSION ID/AGE/STATUS/PROJECT/TOPIC), colorized only when stdout
  is a TTY (`formatChatRoster()` in `bin/thatch`; pipes and QA runners
  get plain text). Rows are split into Active, Recent, and Stale
  sections by `splitChatRoster()` (it takes the open-tab set, so fresh
  opencode rows split into open versus recent); the status column is
  `chatLiveness()`'s verdict
  (`open`/`recent`/`stale` for opencode rows - the open-tab reader feeds
  the open/recent split - `active`/`idle` for MCP rows). The Recent and
  Stale sections are flag-guarded, and the two guards hide differently:
  without `--recent` the Recent section is replaced by a muted
  hidden-count note (the renderer keeps the rows to count them), while
  without `--stale` stale rows are dropped entirely by a pre-filter in
  the command case - only the empty-roster message points at the flag.
  `--stale [N|all]` reveals the stale rows under a one-day display cap
  whose overflow collapses into a hidden-count note.
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
- `chat tail --pretty` renders the same events as email-style cards for
  terminal reading instead of the JSONL log (opt-in; the default and the
  pipe format stay JSONL). The renderer is `createChatTailPretty()` in
  `src/chat.ts` (stateful: the rule prints only between cards, and read
  receipts cite the subject and body head of the sent event they
  follow), with bodies through `markdownBodyLines()` - a fallback chain
  of markdown renderers: glow (wraps to the card width), then `gum
  format` (same glamour engine, but no width flag, so long lines do not
  wrap), then `wrapChatBody()`, the plain word wrap. A missing tool or a
  failed render steps down silently. Color is the roster's rule (`isTTY && !NO_COLOR`),
  width is `tailWidth()` (terminal, then `COLUMNS`, then 100); the
  look is pinned against `~/bin/chat-pretty`, the perl script the flag
  replaces.
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
- `chat broadcast <msg> [--project P]...` is the CLI's one write path:
  it voices the human user (sentinel from_session "cli", explicit
  `from_name` from `git config user.name` or `$USER`, sanitized by
  `sanitizeCliSenderName()` and refused on a NOCASE match with a
  registered session), stores the message through
  `broadcastFromUser()` with `cliBroadcastFrame()`'s fence note
  prepended (the note tells each recipient that the message is the
  human user speaking, and that the recipient answers in its own
  session instead of replying into chat), and prints a per-recipient
  report (delivered with a `chatLiveness()` label, skipped by reason,
  out-of-scope by the repeatable exact-match `--project` filter).
  Delivery is the ordinary poll - open sessions wake, no tab
  requirement at write time, `delivered_at` left to the wake
  machinery; failures print plainly (`[thatch chat broadcast] failed:
  ...`), matching the tail's friendly-failure treatment. Unknown flags
  die loudly rather than going out to every session as message text.

## Environment variables

Only a subset of the knobs is listed here. `config_get`'s `environment`
section lists every knob, its default, and the value in your running
process; the registry itself is `src/env-knobs.ts`.

| Variable | Purpose | Default |
|----------|---------|---------|
| `XDG_CONFIG_HOME` | Config home base | `~/.config` |
| `THATCH_DB_PATH` | SQLite DB file location | `$XDG_CONFIG_HOME/thatch/thatch.db` |

| `THATCH_MODEL` | Embedding model override | `Xenova/bge-small-en-v1.5` |
| `THATCH_RECALL_THRESHOLD` | Cosine cutoff for recall nudge | `0.55` |
| `THATCH_PREDICTION_THRESHOLD` | Cutoff for prediction auto-fire | `0.60` |
| `THATCH_BEHAVIOR_THRESHOLD` | Cutoff for behavior auto-fire | `0.60` |
| `THATCH_CHILD_RECONCILE_MS` | Reload window before a restored extraction child is judged finished (test knob) | `10000` |
| `THATCH_STRAND_SWEEP_MS` | Interval for the stranded-session self-heal sweep | `21600000` (6h) |
| `THATCH_STRAND_SWEEP` | Set to `off` (or `0`/`false`) to disarm the strand sweep (test knob) | falls through (sweep on) |
| `THATCH_RUNTIME_STATE_TTL_MS` | Age at which the journal sweep drops untouched extraction journal rows | `604800000` (7d) |
| `CLAUDE_PROJECT_DIR` | Claude Code project dir | `process.cwd()` |
| `CURSOR_PROJECT_DIR` | Cursor project dir | falls through |
| `THATCH_WATCH_DEATH_MINUTES` | Pending-age threshold for watcher death detection | `120` |
| `THATCH_PROJECT_DIR` | Pinned project dir (written by project-local `thatch setup` MCP configs) | falls through |
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
- Cross-session chat ([cross-session-chat.md](cross-session-chat.md)): the `chat` subcommand group reads the shared chat directory and inbox; `chat broadcast` also writes user-voiced broadcast rows (the group's one write path)

## Key invariants

- No arg-parsing library. Args are positional, parsed by hand from `process.argv.slice(2)`.
- `--version`/`-v` prints the version; `-h`/`--help` prints usage from anywhere in the argument list (checked upstream of dispatch, before the DB opens) and exits 0. No other short flags. No subcommand aliases.
- DB opened once at startup, closed at end (except `mcp` which closes early).
- Store name auto-detected from git remote. "global" is the shared store. "all" (search only) means project + global.
- Unknown command or missing required arg calls `usage()` and exits 1.
- `prime` searches PATH in order: `opencode`, `agent`, `claude`. Uses the first found.
