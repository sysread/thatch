# Thatch

[![CI](https://github.com/sysread/thatch/actions/workflows/ci.yml/badge.svg)](https://github.com/sysread/thatch/actions/workflows/ci.yml)

Persistent memory for AI coding agents — local embeddings, SQLite stores, zero config.

Works with **OpenCode** (as a plugin) and **Claude Code** (as an MCP server).
Your AI agent can remember information across sessions. Stores are per-repo
with a shared `global` store. No API keys, no cloud services — everything runs
on your machine.

## Quick start

### OpenCode

```jsonc
// opencode.jsonc
{ "plugin": ["@jeffober/thatch"] }
```

On next start, OpenCode npm-installs thatch (putting the `thatch` CLI on your
PATH as a side effect) and its tools are available immediately.

**Self-hosting** (local development):

```jsonc
{ "plugin": ["./path/to/thatch/src/index.ts"] }
```

Or place the repo under `.opencode/plugins/` and OpenCode auto-loads it.

### Claude Code

**Install thatch globally:**

```bash
npm install -g @jeffober/thatch
```

This puts the `thatch` binary on your PATH. It requires [Bun] to be installed
(`curl -fsSL https://bun.sh/install | bash` if you don't have it).

**Set up Claude Code in your project:**

```bash
cd /path/to/your/project
thatch setup --claude
```

`setup` does four things:
1. Writes `.mcp.json` — registers the MCP server (Claude Code spawns `thatch mcp` as a stdio process)
2. Appends instructions to `CLAUDE.md` — session startup, when to write, what to store
3. Installs hooks in `.claude/settings.json` — `SessionStart` runs `thatch reminder` (recall nudge + hygiene), `UserPromptSubmit` reminds you to save new knowledge
4. Installs skill files to `~/.claude/skills/` — `thatch-fact-extractor`, `thatch-dedup-classifier`, and `thatch-project-primer`

Restart Claude Code and thatch's tools are available as `mcp__thatch__*`.

**Global setup** (all projects at once, no per-project config):

```bash
thatch setup --claude --global
```

This writes to `~/.claude/CLAUDE.md` and `~/.claude/settings.json`, then prints
the `claude mcp add` command to register the MCP server at user scope.

**Local development** (from a thatch repo checkout):

```bash
cd /path/to/thatch
bun run bin/thatch setup --claude
```

When `thatch` is not on PATH, setup uses the absolute path to `bin/thatch` in
the hooks and MCP config. When it is on PATH (npm global install), setup uses
the bare `thatch` command so the config survives updates.

## Tools

| Tool (opencode) | Tool (MCP) | What it does |
|------------------|------------|-------------|
| `thatch_memory_remember` | `mcp__thatch__memory_remember` | Save a memory with an embedding for later recall |
| `thatch_memory_recall` | `mcp__thatch__memory_recall` | Semantic search across project + global stores |
| `thatch_memory_list` | `mcp__thatch__memory_list` | List labels and metadata in a store |
| `thatch_memory_show` | `mcp__thatch__memory_show` | Read full content by exact label |
| `thatch_memory_forget` | `mcp__thatch__memory_forget` | Delete a memory |
| `thatch_store_list` | `mcp__thatch__store_list` | List all stores |
| `thatch_find_duplicates` | `mcp__thatch__find_duplicates` | Surface pairs of suspiciously similar memories |
| `thatch_dedup_mark_checked` | `mcp__thatch__dedup_mark_checked` | Record a reviewed pair so it stops being re-reported |

## CLI

The `thatch` CLI ships with the package (installed to your npm global bin by
`npm install -g`). It requires [Bun] on your PATH — the bin script uses
`#!/usr/bin/env bun` and all internal modules depend on `bun:sqlite`.

```bash
thatch stores                    List all stores
thatch list   [store]            List memory labels in a store
thatch show   <label> [store]    Display a memory by label
thatch forget <label> [store]    Remove a memory by label
thatch search <query> [store]    Semantic search (cosine similarity)
thatch prime                     Prime project memory (runs via opencode or claude)
thatch mcp                       Start the stdio MCP server (for Claude Code)
thatch reminder                  Print session-start reminder (for hooks)
thatch hygiene                   Print the hygiene report (standalone)
thatch setup --claude [--global] Install config + instructions + hooks + skills
```

Stores default to the repo detected from `git remote`. Use `global` for the
global store. Use `all` with `search` to search project + global together.

### Priming a new project

`thatch prime` bootstraps your project's memory store by having the agent
investigate the codebase and write foundational memories:

```bash
cd /path/to/your/project
thatch prime
```

This detects `opencode` or `claude` on your PATH and runs the
`thatch-project-primer` skill, which guides the agent to:

1. Recall any existing project memories
2. Investigate docs, layout, architecture, commands, and conventions
3. Write focused memories with clear labels
4. Reconcile contradictions with existing knowledge
5. Run dedup to check for overlap

After priming, your agent has context about the project's purpose, structure,
tech stack, development commands, and conventions — reducing the need to
re-research these topics in future sessions.

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
