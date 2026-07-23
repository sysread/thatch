# Thatch

[![CI](https://github.com/sysread/thatch/actions/workflows/ci.yml/badge.svg)](https://github.com/sysread/thatch/actions/workflows/ci.yml)

Persistent memory and useful dev skills for AI coding agents. Works with
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
immediately. For background extraction sub-agents:

```bash
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

Then **prime your project memory** with by running `thatch prime` in your project directory.
This will launch an `opencode` session to build an initial map of the code base and its architecture to seed the memory.

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

- **Memory tools**: save, search, list, show, and forget memories with
  semantic search (local embeddings, SQLite, brute-force cosine).
- **Prediction engine**: a statistical model of user decision-making
  preferences. When a prompt matches learned contexts, predictions fire
  alongside the recall nudge.
- **Skills**: 20 skills for memory workflows, structured multi-specialist
  code review, change walkthroughs, and writing tasks (PR descriptions,
  tickets, PR splitting).

See the [user guide](docs/user/README.md) for the full tool list, CLI
commands, configuration, environment variables, and detailed setup for each
host.

## Privacy

Everything is local. The embedding model downloads once from Hugging Face Hub
and is cached. No data leaves your machine.

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
- [QA & tests](docs/qa/README.md) -- test conventions, use cases
- [Design docs](docs/in-progress/) -- in-progress design notes

## License

MIT

[Bun]: https://bun.sh
