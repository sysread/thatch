# Thatch

Persistent memory for opencode. Thatch gives your AI agent the ability to
remember information across sessions using local embeddings and SQLite.

## Installation

Add thatch to your opencode config:

```jsonc
// opencode.jsonc or opencode.json
{
  "plugin": ["thatch"]
}
```

OpenCode installs the plugin and its dependencies automatically on next start.

## How it works

### Stores

Every git repo gets its own store, named after the repo's GitHub identity
(e.g., `anomalyco/thatch`). There is also a shared `global` store for
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

## Configuration

No configuration needed. The default behavior:

- **Database**: `~/.config/thatch/thatch.db` (created automatically)
- **Embedding model**: bge-small-en-v1.5 (downloaded once, cached locally)
- **Store name**: auto-detected from `git remote get-url origin`
- **Search scope**: always includes the project store and `global`

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `THATCH_DB_PATH` | `~/.config/thatch/thatch.db` | Override database location |
| `THATCH_MODEL` | `Xenova/bge-small-en-v1.5` | Override embedding model |

## Privacy

- All data stays on your machine. No network calls for embeddings or storage.
- The embedding model is downloaded once from Hugging Face Hub on first use, then cached locally.
- Your memories are stored in a local SQLite database — nothing is sent to any service.
