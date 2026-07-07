# Thatch

[![CI](https://github.com/sysread/thatch/actions/workflows/ci.yml/badge.svg)](https://github.com/sysread/thatch/actions/workflows/ci.yml)

Persistent memory for AI coding agents — local embeddings, SQLite stores, zero config.

Works with **OpenCode** (as a plugin) and **Claude Code** (as an MCP server).
Your AI agent can remember information across sessions. Stores are per-repo
with a shared `global` store. No API keys, no cloud services — everything runs
on your machine.

## Quick start

### Claude Code

```bash
# Install globally
npm install -g @jeffober/thatch

# Run setup in your project directory
thatch setup --claude
```

That's it. `setup` writes `.mcp.json`, appends instructions to `CLAUDE.md`,
installs SessionStart + UserPromptSubmit hooks, and installs skill files to
`~/.claude/skills/`. Restart Claude Code and thatch's tools are available
as `mcp__thatch__*`.

For global installation (all projects):

```bash
thatch setup --claude --global
```

Global setup writes to `~/.claude/CLAUDE.md` and `~/.claude/settings.json`,
then prints the `claude mcp add` command to register the MCP server at user scope.

### OpenCode

```jsonc
// opencode.jsonc
{ "plugin": ["@jeffober/thatch"] }
```

On next start, OpenCode installs thatch and its tools are available
immediately.

**Self-hosting** (local development):

```jsonc
{ "plugin": ["./path/to/thatch/src/index.ts"] }
```

Or place the repo under `.opencode/plugins/` and OpenCode auto-loads it.

## Tools

| Tool (MCP) | Tool (opencode) | What it does |
|------------|-----------------|-------------|
| `mcp__thatch__memory_remember` | `thatch_memory_remember` | Save a memory with an embedding for later recall |
| `mcp__thatch__memory_recall` | `thatch_memory_recall` | Semantic search across project + global stores |
| `mcp__thatch__memory_list` | `thatch_memory_list` | List labels and metadata in a store |
| `mcp__thatch__memory_show` | `thatch_memory_show` | Read full content by exact label |
| `mcp__thatch__memory_forget` | `thatch_memory_forget` | Delete a memory |
| `mcp__thatch__store_list` | `thatch_store_list` | List all stores |
| `mcp__thatch__find_duplicates` | `thatch_find_duplicates` | Surface pairs of suspiciously similar memories |
| `mcp__thatch__dedup_mark_checked` | `thatch_dedup_mark_checked` | Record a reviewed pair so it stops being re-reported |

## CLI

```bash
thatch stores                    List all stores
thatch list   [store]            List memory labels in a store
thatch show   <label> [store]    Display a memory by label
thatch forget <label> [store]    Remove a memory by label
thatch search <query> [store]    Semantic search (cosine similarity)
thatch mcp                       Start the stdio MCP server (for Claude Code)
thatch reminder                  Print session-start reminder (for hooks)
thatch hygiene                   Print the hygiene report (standalone)
thatch setup --claude [--global] Install config + instructions + hooks + skills
```

Requires [Bun] on your PATH.

## How it works

Thatch auto-detects your repo identity from `git remote get-url origin`
(e.g., `sysread/thatch`). Memories are embedded with
[bge-small-en-v1.5][bge] (384-dimensional vectors, ~34 MB model, cached
locally) and stored in `~/.config/thatch/thatch.db` (SQLite, WAL mode).
Search is brute-force cosine similarity — fast enough for thousands of entries.

## OpenCode vs Claude Code parity

| Feature | OpenCode (plugin) | Claude Code (MCP + hooks) |
|---------|-------------------|--------------------------|
| Tools | Plugin tool registration | MCP `tools/list` + `tools/call` |
| System prompt | Injected at runtime with repo name | Static CLAUDE.md (repo auto-detected by MCP server) |
| Session-start reminder | `session.created` event | `SessionStart` hook → `thatch reminder` |
| Compaction context | `experimental.session.compacting` hook | **Gap**: no equivalent (CLAUDE.md persists through compaction) |
| Extraction nudge | `tool.execute.after` + `chat.message` | **Gap**: no cross-call buffering (hooks fire per-event) |
| Skills | `$XDG_CONFIG_HOME/opencode/skills` | `~/.claude/skills/` |
| Store detection | `worktree` param from plugin | `CLAUDE_PROJECT_DIR` env var |

See [docs/dev/mcp-parity.md](docs/dev/mcp-parity.md) for the full analysis.

## Privacy

Everything is local. The embedding model downloads once from Hugging Face Hub
and is cached. No data leaves your machine.

## Docs

- [User guide](docs/user/README.md) — setup, tools, configuration
- [Development](docs/dev/README.md) — architecture, module responsibilities, data flow
- [MCP parity](docs/dev/mcp-parity.md) — OpenCode plugin vs Claude Code MCP feature comparison
- [QA & tests](docs/qa/README.md) — test conventions, categories, use case format
- [Plans](docs/plans/) — numbered design documents capturing decisions

## Development

```bash
bun install        # deps
bun test           # full suite: zero network, zero external deps
bun test --watch   # watch mode
```

Tests never reach outside the sandbox: temp-directory SQLite files, mock
embeddings, no network.

## License

MIT

[Bun]: https://bun.sh
[bge]: https://huggingface.co/BAAI/bge-small-en-v1.5
