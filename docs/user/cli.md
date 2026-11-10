# CLI

Thatch ships with a command-line tool for inspecting and writing
memories and running maintenance tasks outside the agent. It requires
`bun` on your PATH.

`thatch --help` (or `-h`, or `thatch help`) prints the command list
and exits 0. Help is per command: put the help flag after a subcommand
to see that command's own page, with its usage line, flags, and notes.

```bash
thatch --help            # the command list
thatch chat list --help  # the chat list page: flags and what they do
thatch help chat list    # the same page, by name
```

A help flag before the subcommand (`thatch -h chat list`) shows the
command list instead.

## Memory inspection

```bash
thatch stores                  # list all stores
thatch list [store]            # list memory labels in a store
thatch show <label> [store]    # display one memory by label
thatch forget <label> [store]  # delete one memory by label (leaves a guard)
thatch search <query> [store]  # semantic search (cosine similarity)
thatch tombstones [store]      # list deleted-memory guards
thatch tombstones --clear <label> [store]  # remove one guard (the re-admission path)
```

Store defaults to your current git repo (detected from `git remote
get-url origin`). Use `global` for the shared global store. Use `all`
with `search` to search the project store and `global` together.

`search` uses the same cosine-similarity search as
`thatch_memory_recall`. Results include a similarity score for each
match. Limited to 10 results.

## Writing a memory

```bash
thatch remember "rebased payments branch, keep the feature flag on" --confidence 5
cat merge-notes.md | thatch remember --label "merge notes" --branch release/1.4
thatch remember "updated body" --label "merge notes" --overwrite
```

`remember` is the write counterpart to `forget`: it saves a memory
through the same code path as the agent's `memory_remember` tool. The
content comes as arguments (words are joined, so quotes are optional)
or piped on stdin for long text. Without `--label`, the label derives
from the content's first line (a leading markdown heading becomes the
label). Without `--store`, it writes to the current git repo's project
store.

On success it prints one line to stdout, ready for scripts:

```text
[saved] acme/payments :: merge notes
```

Flags:

- `--label L` - the memory's label; derived from the content when
  omitted.
- `--store S` - target store; defaults to the current repo's project
  store, `global` for the shared store.
- `--branch B` - scope the memory to a git branch.
- `--confidence N` - how well-established the observation is, 1-10.
- `--overwrite` - replace an existing memory with the same label.

Exit code 0 means saved; anything else exits 1 with the reason on
stderr (a duplicate label without `--overwrite`, for example).

One behavior is inherited from the tool on purpose: overwriting a
branch-scoped memory WITHOUT `--branch` keeps the old branch scope.
To promote a branch-scoped memory to project-wide, forget it and save
it again without `--branch`, then check with `thatch show`.
Passing an empty `--branch` value (for example, a script reading a
detached HEAD) saves the memory unscoped, the same as omitting the
flag: an empty branch name is never a git ref.

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

## Cross-session chat

Access to the chat directory your opencode sessions share (see
[cross-session-chat.md](cross-session-chat.md)) - read-only, except for
`chat broadcast`, which is your voice:

```bash
thatch chat list               # who is open now: name, age, project, topic
thatch chat list --recent      # also show alive sessions with no open tab
thatch chat list --stale all   # also show stale sessions older than a day
thatch chat list --json        # machine-readable roster: one JSON object per row
thatch chat list --host-id <id> [--host-id <id>...]   # look up rows by the
                               # HOST session id you already know (repeatable);
                               # the hashing is internal, JSON rows echo the id
                               # in host_id
thatch chat tail               # follow sent and read events, live (JSONL)
thatch chat tail --once        # print the last 20 messages and exit
thatch chat tail --once --limit 50   # a longer backlog (or --limit all)
thatch chat tail --match "rebase" --match "payments"   # body must match both
thatch chat tail --from al --to bob        # substring match on names
thatch chat tail --since 2026-09-12 --until "2026-09-13 09:00"   # a window
thatch chat tail --pretty              # email-style cards instead of JSONL
thatch chat broadcast "lunch in ten"   # you, to every live session
thatch chat broadcast "deploy halted" --project acme/payments   # narrow it
thatch chat broadcast "all hands" --project acme/one --project acme/two
```

`chat list` renders the chat roster in three sections - Active, Recent,
and Stale - each as aligned columns under a header row: how long since its last heartbeat, its status (`open` - a tab is open now - or
`recent` - host alive, no open tab - for opencode sessions; `active` or
`idle` for Claude Code and Cursor sessions, which only beat when a
prompt runs), its project, and its topic (the session's title) - the
fastest way to answer "which session should I talk to about X?" Rows
are grouped by project (alphabetical; sessions with no project last),
most recently seen first within each project.

The default view shows the sessions you can wake or reach now: open
sessions plus Claude Code and Cursor rows, which read mail at their
next prompt. A recent session - its harness is alive but its tab is
closed, so a wake may not reach it until the tab reopens - collapses
into a muted hidden-count note pointing at `--recent`, which reveals
the Recent section. A stale session has missed two heartbeats, about a
minute: the opencode process hosting it has probably stopped. Its
section is hidden too, behind `--stale`, but without a count note - the
default view simply drops stale rows. The stale section
shows rows up to one day old by default; older ones collapse into a
hidden-count note so long-dead sessions cannot bury the fresh signal.
Pass `--stale N` (days) to widen the window or `--stale all` to see
every stale row. Color is added only when the
output is a terminal; a pipe prints plain aligned text.

`--json` swaps the table for the machine-readable roster: one JSON object
per row with stable field names - `name`, `session_id` (the row's stored
key: hashed for Claude Code and Cursor rows, raw for opencode), `host_kind`,
`project`, `topic`, `status` (the same verdicts the table shows),
`last_seen`, and `unread` (unread message count, so a launcher can decide
when to prompt an idle session to read its mail without polling
`chat tail`). Zero matching rows print zero lines.

`--host-id <id>` (repeatable) looks up rows by the HOST session id a
launcher already knows: thatch hashes each id internally, so a tool never
learns or depends on the hash scheme. A lookup is a point query - the
staleness filter does not apply, because a caller asking for a specific id
wants that row even when it is idle. Combined with `--json`, the matching
rows echo the caller's id in a `host_id` field, so one multi-id call is
joinable lane by lane; with no match, the text form prints a diagnostic
line and the JSON form prints nothing.

`chat tail` prints the conversation as a JSONL event log: one JSON
object per line, one event per line. Sending a message and reading it
are separate events, linked by the message `id`. Every field is plain
data: names as registered, each participant's topic, the message body
exactly as sent, and ISO-8601 UTC timestamps. No color, no markdown
rendering, no local time; pipe through `jq` for either.

```text
{"event":"sent","at":"2026-09-12T20:02:11Z","id":41,"from":"al-go-rithm-00001","from_topic":"cross-session messaging","to":"brute-the-dream-farrier-00001","to_topic":"diagnosing watcher underuse","broadcast":false,"body":"CI is green on main"}
{"event":"read","at":"2026-09-12T20:02:40Z","id":41,"reader":"brute-the-dream-farrier-00001","reader_topic":"diagnosing watcher underuse","from":"al-go-rithm-00001","from_topic":"cross-session messaging"}
{"event":"sent","at":"2026-09-13T03:07:02Z","id":42,"from":"al-go-rithm-00001","from_topic":"cross-session messaging","to":"kurn-the-typechecker-00001","to_topic":"release QA","broadcast":true,"body":"rebasing payments, hold off"}
```

A broadcast is one `sent` event per recipient, each with `broadcast:
true` and its real `to`, so every copy tracks its own read. Handy
one-liners:

```bash
thatch chat tail | jq -r '"\(.at) \(.event) \(.from) -> \(.to // .reader): \(.body // "")"'
thatch chat tail --once --limit all | jq -c 'select(.event == "read")'
```

### chat broadcast: your voice in the room

`thatch chat broadcast "<message>"` sends a message from YOU - the
human - to every live chat session, straight from a terminal. You are
not joining the chat: each delivered message carries a note telling the
sessions it came from you, that you are not a chat session and will not
read replies there, and that they should act in their own session and
report back to you there - never by replying into thatch chat.

The message reaches OPEN sessions with a wake on their next poll;
tab-less and Claude Code/Cursor sessions are not woken - they read it
at their next prompt - and stale opencode sessions (host process gone)
are skipped. The report names each open-tab delivery and summarizes
the rest as counts (no-tab, mcp, skipped per project, and - with a
filter - out-of-scope per project), so a broadcast to a large directory
prints a handful of lines, not one per session. Repeat `--project`
to narrow the audience (exact project match). Your
name comes from `git config user.name` (or your OS username), so
sessions see who is speaking. Sessions cannot reply into chat to reach
you - the fence note directs them to their own user instead.

For reading instead of parsing, `--pretty` renders the same events as
email-style cards: a To / From / Subject / Date header over each
message, the session topic as the Subject (the join key to the tab
titles in the TUI), and a full-width rule between messages. Broadcasts
show a bullhorn in To:. Read receipts render as one-line notes citing
the message they acknowledge. Message bodies are markdown, and render as markdown when glow or gum
is installed (plain word-wrapping otherwise).
Color appears only when the output is a terminal, and `NO_COLOR`
turns it off; piped output stays plain text. The default without
`--pretty` is still the JSONL log.

Follow mode runs until Ctrl-C. The backlog includes the `read` event of
every message already read; in follow mode, reads appear as inboxes
drain. The chat itself flows through the
agents (except `chat broadcast`, the one CLI write; reading and
registering happen from opencode sessions via the `thatch_chat_*`
tools).

The backlog shows the last 20 messages before follow mode takes over.
When messages are hidden, tail prints a one-line note on stderr saying
how many there were; `--limit N` raises or lowers the backlog and
`--limit all` shows everything. All the filters apply to live events
too, so a filtered tail keeps watching the same way:

- `--match PATTERN` filters message bodies. Repeat it to AND patterns
  together: every one must match the message body.
- `--from NAME` and `--to NAME` match participant names (case doesn't
  matter). Names are snapshotted when a message is sent, so a departed
  sender is still found under the name it sent with. Only rows sent
  before name snapshots existed appear as the `unknown` rendering.
  Broadcast events carry their real recipient,
  so `--to <name>` finds the fan-out copies that reached them.
- `--since DT` and `--until DT` bound the window; a message counts if
  it was sent at or after `--since` and before `--until`. The date
  format is `YYYY-MM-DD` with an optional `HH:MM` in your local
  timezone.

A `--until` already in the past exits after the backlog (a closed
window has nothing left to follow); one in the future follows until
the window closes. In the backlog, a hidden message's read is hidden
with it; in follow mode, a hidden message that gets read still emits
its read event.

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

## Setup

Run once per host (or per harness) to install thatch:

```bash
thatch setup --claude [--cursor] [--local|--global]  # install config + instructions + hooks + skills
thatch setup --claude --skills-only             # refresh just the skill files
thatch setup --skills-only <dir>                # install skills to any directory
thatch setup --commands-only <dir>              # install command files to any directory
thatch setup --mcp-json                         # print the MCP server config as JSON
```

## Infrastructure commands

These commands are called by hooks installed by `thatch setup`. You
should not need to run them by hand.

```bash
thatch mcp                      # start the stdio MCP server
thatch buffer-batch             # append tool batch to queue (Claude Code hook)
thatch buffer-tool              # append single tool to queue (Cursor hook)
thatch flush-tools [--json]     # peek queue + print nudges (hook)
thatch flush-predictions [--json]  # prediction-only nudge (hook)
```

## Environment variables

Only a subset of the knobs is listed here. `config_get`'s `environment`
section lists every knob, its default, and the value in your running
process; the registry itself is `src/env-knobs.ts`.

| Variable | Default | What it controls |
|----------|---------|-----------------|
| `THATCH_DB_PATH` | `~/.config/thatch/thatch.db` | SQLite database path |

| `THATCH_MODEL` | `Xenova/bge-small-en-v1.5` | Embedding model name |
| `THATCH_RECALL_THRESHOLD` | `0.55` | Cosine threshold for recall nudge |
| `THATCH_PREDICTION_THRESHOLD` | `0.60` | Cosine threshold for prediction auto-fire |
| `THATCH_BEHAVIOR_THRESHOLD` | `0.60` | Cosine threshold for behavior auto-fire |
| `CLAUDE_PROJECT_DIR` | `process.cwd()` | Claude Code project directory |
| `CURSOR_PROJECT_DIR` | (falls through) | Cursor project directory |
| `THATCH_WATCH_DEATH_MINUTES` | `120` | Pending-age threshold before a dead session's watchers are cancelled and announced |
| `THATCH_PROJECT_DIR` | (falls through) | Project dir pinned by project-local MCP configs - first in the server's resolution chain |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config directory |
| `CURSOR_CONFIG_DIR` | `~/.cursor` | Cursor config directory |

## Limitations

- For non-Nix installs, `bun` must be installed and on PATH. Thatch does
  not bundle its own runtime (the Nix package bundles it; see the
  README's Nix section).
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
