# Persistent Memory

Thatch gives your AI coding agent the ability to remember information across
sessions. Memories are stored in a local SQLite database using local
embeddings (no network calls, no API keys).

## How it works

Each memory has a label, content, and an embedding vector. When you ask the
agent to save something, it embeds the text and stores it. When a future
session's prompt semantically matches a stored memory, thatch injects a
nudge telling the agent to recall it.

You never see the nudge. The agent sees it and decides whether to act
on it. The memory surfaces as context the agent reads, not as text
printed to your terminal.

## Stores

Memories are organized into stores:

- **global**: user preferences, personality, system environment. Shared
  across all projects.
- **Per-project**: detected from your git remote. Each repo gets its
  own store.
- **Branch-scoped**: memories can be scoped to a git branch for
  feature-specific context (design decisions, WIP notes, PR status).

The agent defaults to searching both the project store and the global
store when recalling.

## Tools

| Tool | What it does |
|------|-------------|
| `thatch_memory_remember` | Save a memory with a label and content. Optional: branch, confidence (1-10), archived flag, overwrite. |
| `thatch_memory_recall` | Semantic search across stores. Returns matching memories with similarity scores. |
| `thatch_memory_list` | List all memories in a store (metadata only, no content). |
| `thatch_memory_show` | Show full content of a single memory by label. |
| `thatch_memory_forget` | Delete a memory by label. |
| `thatch_store_list` | List all active stores. |
| `thatch_find_duplicates` | Surface pairs of memories with suspiciously similar content. |
| `thatch_dedup_mark_checked` | Record a verdict for a reviewed pair so it stops being re-reported. |

## Configuration

- `THATCH_DB_PATH`: path to the SQLite database file. Defaults to
  `~/.config/thatch/thatch.db` (opencode) or the project directory
  (MCP).
- `THATCH_MODEL`: Hugging Face model name for embeddings. Defaults to
  `Xenova/bge-small-en-v1.5` (34 MB, 384-dimensional).
- `THATCH_RECALL_THRESHOLD`: cosine score threshold for the recall
  nudge. Defaults to 0.55. Lower surfaces more matches (noisier);
  higher surfaces fewer (stricter).

## Limitations

- Search is brute-force cosine similarity across all entries in the
  store. No approximate nearest neighbor index. Fine for thousands of
  memories; would slow down at tens of thousands.
- Embeddings are local (bge-small-en-v1.5). Quality is good for
  code-related content but not state-of-the-art compared to large
  API-based models.
- There is no full-text search. Recall is semantic only (cosine on
  embeddings). If you need exact string matching, use the agent's
  grep or read tools.
- Memories are not versioned. Updating a memory with `overwrite: true`
  replaces the content and embedding. The old content is lost (git
  history does not track it).

## Archived memories

Memories can be marked `archived` to exclude them from default search
results without deleting them. Archived memories are useful for
consolidating branch-scoped context after a merge: the branch-scoped
memories become a single archived record that future sessions can find
with `includeArchived: true` but that does not clutter normal recall.

See [prediction-engine.md](prediction-engine.md) for the user decision
model and [behavior-engine.md](behavior-engine.md) for self-discipline
rules.
