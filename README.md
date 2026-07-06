# Thatch

[![CI](https://github.com/sysread/thatch/actions/workflows/ci.yml/badge.svg)](https://github.com/sysread/thatch/actions/workflows/ci.yml)

Persistent memory for [OpenCode] — local embeddings, SQLite stores, zero config.

Your AI agent can remember information across sessions. Stores are per-repo
with a shared `global` store. No API keys, no cloud services — everything runs
on your machine.

## Quick start

```jsonc
// opencode.jsonc — after publishing to npm
{ "plugin": ["@jeffober/thatch"] }
```

That's it. On next start, OpenCode installs thatch and its tools are available
immediately.

**Self-hosting** (local development, before npm publication):

```jsonc
{ "plugin": ["./path/to/thatch/src/index.ts"] }
```

Or place the repo under `.opencode/plugins/` and OpenCode auto-loads it.

| Tool | What it does |
|------|-------------|
| `thatch_memory_remember` | Save a memory with an embedding for later recall |
| `thatch_memory_recall` | Semantic search across project + global stores |
| `thatch_memory_list` | List labels and metadata in a store |
| `thatch_memory_show` | Read full content by exact label |
| `thatch_memory_forget` | Delete a memory |
| `thatch_store_list` | List all stores |
| `thatch_find_duplicates` | Surface pairs of suspiciously similar memories |
| `thatch_dedup_mark_checked` | Record a reviewed pair so it stops being re-reported |

## How it works

Thatch auto-detects your repo identity from `git remote get-url origin`
(e.g., `sysread/thatch`). Memories are embedded with
[bge-small-en-v1.5][bge] (384-dimensional vectors, ~34 MB model, cached
locally) and stored in `~/.config/thatch/thatch.db` (SQLite, WAL mode).
Search is brute-force cosine similarity — fast enough for thousands of entries.

A `thatch` CLI ships with the package for inspecting stores from the shell
(`thatch stores|list|show|search|forget`). It requires [Bun] on your PATH —
the whole plugin runs on Bun, which OpenCode provides when loading plugins,
but a globally installed CLI uses whatever is on your system.

## Privacy

Everything is local. The embedding model downloads once from Hugging Face Hub
and is cached. No data leaves your machine.

## Docs

- [User guide](docs/user/README.md) — setup, tools, configuration
- [Development](docs/dev/README.md) — architecture, module responsibilities, data flow
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

[OpenCode]: https://opencode.ai
[Bun]: https://bun.sh
[bge]: https://huggingface.co/BAAI/bge-small-en-v1.5
