# Thatch

[![CI](https://github.com/sysread/thatch/actions/workflows/ci.yml/badge.svg)](https://github.com/sysread/thatch/actions/workflows/ci.yml)

Persistent memory and operational methodology for AI coding agents. Works with
**OpenCode** (as a plugin), **Claude Code** (as a local MCP server), and
**Cursor** (as a local MCP server).

Each session inherits the accumulated knowledge of every session before it:
project architecture, conventions, gotchas, user preferences. Your agent
starts with context instead of a blank slate. No API keys, no cloud services;
everything runs on your machine.

## Quick start

### OpenCode

```jsonc
// opencode.jsonc
{ "plugin": ["@jeffober/thatch"] }
```

On next start, OpenCode npm-installs thatch and its tools are available
immediately. For async extraction (child sessions run in the background):

```bash
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

Without this env var, extraction still works - the child session runs
synchronously (fire-and-forget) instead of asynchronously.

Then **prime your project memory** by running `thatch prime` in your project directory.
This launches an `opencode` session to build an initial map of the code base
and seed the memory.

### Claude Code and Cursor

Install globally, then run setup in your project:

```bash
npm install -g @jeffober/thatch
cd /path/to/your/project
thatch setup --claude    # or --cursor

# set up in your global config for all projects
thatch setup --claude --global  # or --cursor --global
```

`setup` installs the MCP server config, hooks, instructions, and skills.
Restart your editor and thatch's tools are available as `mcp__thatch__*`.
Requires [Bun] on PATH.

### Other MCP-compatible harnesses

```json
{
  "mcpServers": {
    "thatch": { "command": "thatch", "args": ["mcp"] }
  }
}
```

Include thatch's instructions in your agent's system prompt manually; see
[docs/dev/mcp-parity.md](docs/dev/mcp-parity.md) for the prompt text.

## What's inside

Thatch gives your agent:

- **Memory** -- save, search, and recall knowledge across sessions with
  local embeddings (bge-small-en-v1.5) and SQLite. Every project gets its
  own store; a shared global store holds cross-project knowledge. The agent
  writes and reads memories through tools -- thatch never saves anything on
  its own.
- **Prediction engine** -- a statistical model of the user's decision-making
  preferences. When a prompt matches learned contexts, predictions fire
  alongside the recall nudge. Confidence is graded (Bayesian posterior) and
  reinforced or weakened by user feedback. The agent follows strong
  predictions silently and surfaces ambiguous ones to the user.
- **Behavior engine** -- a self-discipline model where the agent codifies
  its own operational rules ("when X, I do Y"). Rules auto-fire when similar
  situations arise. The agent ham/spams each surfaced rule to train the
  classifier. Confidence adjusts the same way as predictions. An anti-laziness
  guard in the prompt prevents the agent from codifying shortcuts.
- **Conversation search** -- the agent can search its own past opencode
  conversations by substring or regex and retrieve full messages, including
  complete tool inputs and outputs. Available as tools (`session_search`,
  `session_get`, opencode only) and as CLI subcommands (`thatch session
  list/get/transcript/search`, JSONL output designed for piping to `jq`).
- **Watchers** -- event-driven notifications from external sources (opencode
  only). The agent registers a watch on a GitHub PR or branch (main); thatch polls it in the
  background and prompts the session when comments, commits, CI results, or
  status changes arrive. Notifications carry pointer data only.
- **Cross-session chat** -- your agent sessions can message each other
  (opencode, Claude Code, and Cursor; same machine). A session registers
  under a unique name and topic, others see it in the directory, and
  messages land in its inbox -- opencode sessions get woken with a prompt
  when idle, other hosts see pending mail at their next prompt. Loop-safe:
  messages are informational to the receiving agent, and wake prompts are
  rate-capped.
- **Notifications + user config** -- the agent can ping you out-of-band when a
  long-running outcome lands: a desktop banner, a spoken voice
  announcement, or both (macOS and Linux). Preferences live in a
  hand-editable config file (`~/.config/thatch/config.json`) that the agent
  manages through `config_get`/`config_set` -- ask it to change your voice
  or quiet notifications entirely.

Plus **skills** for memory workflows, structured multi-specialist code
review, review response, change and feature walkthroughs, memory verification,
knowledge export, and writing tasks
(PR descriptions, tickets, PR splitting).

See the [user guide](docs/user/README.md) for the full tool list, CLI
commands, configuration, environment variables, and detailed setup for each
host.

## Privacy

Everything is local. The embedding model downloads once from Hugging Face Hub
and is cached. No data leaves your machine.

One exception: watchers (opencode only) call the GitHub API through the `gh`
CLI to poll PRs you explicitly asked to watch, using your existing gh
authentication. Thatch never sees or stores the token, and notifications
carry pointer data only - GitHub comment text never enters your context
unless the agent fetches it.

## Development

```bash
bun install
mise run check     # typecheck + bun test + markdownlint (the CI gate)
```

Tests never reach outside the sandbox: temp-directory SQLite files, mock
embeddings, no network.

## Docs

- [User guide](docs/user/README.md) -- setup, tools, configuration, CLI
- [Development](docs/dev/README.md) -- architecture, module responsibilities
- [MCP parity](docs/dev/mcp-parity.md) -- OpenCode plugin vs MCP feature comparison
- [QA tests](tests/qa/) -- executable use cases (auto/ and live/ subdirs)
- [Design docs](docs/plans/) -- design-decision snapshots and in-progress plans

## License

[MIT](LICENSE)

[Bun]: https://bun.sh
