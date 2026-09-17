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

## Cross-session chat

Read-only access to the chat directory your opencode sessions share
(see [cross-session-chat.md](cross-session-chat.md)):

```bash
thatch chat list               # who is registered: name, age, project, topic
thatch chat list --stale all   # also show stale sessions older than a day
thatch chat tail               # follow sent and read events, live (JSONL)
thatch chat tail --once        # print the last 20 messages and exit
thatch chat tail --once --limit 50   # a longer backlog (or --limit all)
thatch chat tail --match "rebase" --match "payments"   # body must match both
thatch chat tail --from al --to bob        # substring match on names
thatch chat tail --since 2026-09-12 --until "2026-09-13 09:00"   # a window
```

`chat list` shows every registered session in two sections, Active and
Stale, each as aligned columns under a header row: how long since its
last heartbeat, its status (`fresh` or `stale` for opencode sessions;
`active` or `idle` for Claude Code and Cursor sessions, which only beat
when a prompt runs), its project, and its topic (the session's title) -
the fastest way to answer "which session should I talk to about X?"
Rows are grouped by project (alphabetical; sessions with no project
last), most recently seen first within each project. A
stale session has missed two heartbeats, about a minute: the opencode
process hosting it has probably stopped. The stale section shows rows
up to one day old by default; older ones collapse into a hidden-count
note so long-dead sessions cannot bury the fresh signal. Pass
`--stale N` (days) to widen the window or `--stale all` to see every
stale row. Color is added only when the
output is a terminal; a pipe prints plain aligned text.

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

Follow mode runs until Ctrl-C. The backlog includes the `read` event of
every message already read; in follow mode, reads appear as inboxes
drain. The chat itself flows through the
agents (the CLI never sends, reads, or registers on a session's behalf;
that happens from opencode sessions via the `thatch_chat_*` tools).

The backlog shows the last 20 messages before follow mode takes over.
When messages are hidden, tail prints a one-line note on stderr saying
how many there were; `--limit N` raises or lowers the backlog and
`--limit all` shows everything. All the filters apply to live events
too, so a filtered tail keeps watching the same way:

- `--match PATTERN` filters message bodies. Repeat it to AND patterns
  together: every one must match the message body.
- `--from NAME` and `--to NAME` match participant names (case doesn't
  matter). A departed sender can only be found as the `unknown`
  rendering the tail shows. Broadcast events carry their real recipient,
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
