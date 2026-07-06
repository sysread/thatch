# Thatch

Persistent memory for opencode. Thatch gives your AI agent the ability to
remember information across sessions using local embeddings and SQLite.

## Installation

Publish to npm and add thatch to your opencode config:

```jsonc
// opencode.jsonc or opencode.json
{
  "plugin": ["@jeffober/thatch"]
}
```

OpenCode installs the plugin and its dependencies automatically on next start.

For local development before publishing, use a file path:

```jsonc
{ "plugin": ["./path/to/thatch/src/index.ts"] }
```

Or place the thatch repo in `.opencode/plugins/` for auto-loading.

## How it works

### Stores

Every git repo gets its own store, named after the repo's remote identity
(e.g., `sysread/thatch`). There is also a shared `global` store for
information that applies across all projects.

Stores are created automatically — no setup required.

### Memory tools

| Tool | What it does |
|------|-------------|
| `thatch_memory_remember` | Save a piece of information. Label it, and thatch embeds it for later recall. |
| `thatch_memory_recall` | Search for relevant information using natural language. Searches both the current project's store and `global` by default. |
| `thatch_memory_list` | List all memory labels in a store. |
| `thatch_memory_show` | Read the full content of a memory by exact label. |
| `thatch_memory_forget` | Delete a memory by label. |

### Store tools

| Tool | What it does |
|------|-------------|
| `thatch_store_list` | List all available stores. |

### Deduplication tools

| Tool | What it does |
|------|-------------|
| `thatch_find_duplicates` | Surface pairs of memories with suspiciously similar content. |
| `thatch_dedup_mark_checked` | Record the verdict for a reviewed pair so it stops being re-reported. |

## Automatic behaviors

Beyond the tools, thatch hooks into opencode itself:

- **System prompt.** Every session's system prompt gains a section describing
  the available stores and when to save/recall memories.
- **Session-start reminder.** New sessions receive a prompt nudging the agent
  to recall user preferences and project context before its first response.
- **Fact-extraction nudges.** Thatch buffers the session's recent tool calls
  (up to 20, per session). On your next message, the agent receives a summary
  payload and is prompted to save any durable facts it reveals. The agent does
  the writing — thatch never saves memories on its own.
- **Compaction context.** When opencode compacts a long session, thatch injects
  a reminder so the summarized session still knows memory tools exist.

## Skills

On startup thatch installs two [skills] into your global opencode config
(`~/.config/opencode/skills/`, or `$XDG_CONFIG_HOME/opencode/skills`):

| Skill | Purpose |
|-------|---------|
| `thatch-fact-extractor` | Guides the agent through turning buffered tool interactions into memories. |
| `thatch-dedup-classifier` | Guides the agent through classifying and resolving duplicate-candidate pairs. |

These files are plugin-owned: local edits are overwritten the next time the
plugin initializes (this is how skill improvements ship with new versions).

[skills]: https://opencode.ai/docs/skills/

## CLI

Thatch ships with a command-line tool for reviewing memories outside opencode.
It requires Bun on your PATH:

```bash
# After npm publish: available globally
thatch stores
thatch list [store]
thatch show <label> [store]
thatch forget <label> [store]
thatch search <query> [store]

# Before publish: run from a git checkout or symlink
bun run bin/thatch stores
# or
ln -s ~/dev/thatch/bin/thatch ~/.local/bin/thatch
```

`search` uses the same cosine-similarity search as `thatch_memory_recall`.
Store defaults to your current git repo.

## Configuration

No configuration needed. The default behavior:

- **Database**: `~/.config/thatch/thatch.db` (created automatically)
- **Embedding model**: bge-small-en-v1.5 (downloaded once, cached locally)
- **Store name**: auto-detected from `git remote get-url origin`
- **Search scope**: always includes the project store and `global`

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `THATCH_DB_PATH` | `$XDG_CONFIG_HOME/thatch/thatch.db` | Override database location |
| `THATCH_MODEL` | `Xenova/bge-small-en-v1.5` | Override embedding model |

`$XDG_CONFIG_HOME` defaults to `~/.config` when unset.

**Changing `THATCH_MODEL` on an existing database:** memories embedded by a
model with a different vector dimension are skipped by search (not corrupted,
not deleted — just invisible) until re-saved. There is no automatic
re-embedding.

## Privacy

- All data stays on your machine. No network calls for embeddings or storage.
- The embedding model is downloaded once from Hugging Face Hub on first use, then cached locally.
- Your memories are stored in a local SQLite database — nothing is sent to any service.
