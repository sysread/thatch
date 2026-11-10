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
| `thatch_memory_remember` | Save a memory with a label and content. The label may be omitted - it is derived from the content's first heading or line. Content is required in practice: a call without it saves nothing and returns guidance naming the parameter. Optional: branch (empty string saves unscoped, same as omitting it), confidence (1-10), archived flag, overwrite. |
| `thatch_memory_recall` | Semantic search across stores. Returns matching memories with similarity scores. |
| `thatch_memory_list` | List all memories in a store (metadata only, no content). |
| `thatch_memory_show` | Show full content of a single memory by its exact, full label. A call without the label returns guidance pointing at `memory_list`/`memory_recall` for finding labels; a typo'd label gets a `Did you mean "..."?` suggestion when one is close. |
| `thatch_memory_forget` | Delete a memory by its exact, full label. A call without the label returns guidance pointing at `memory_list`/`memory_recall` for finding labels; a typo'd label gets a `Did you mean "..."?` suggestion when one is close. Deleting also leaves a guard: re-saving the same content is held (see Deleted memories are guarded below). |
| `thatch_store_list` | List all active stores. |
| `thatch_find_duplicates` | Surface pairs of memories with suspiciously similar content. |
| `thatch_dedup_mark_checked` | Record a verdict for a reviewed pair so it stops being re-reported. |

## Configuration

- `THATCH_DB_PATH`: path to the SQLite database file. Defaults to
  `~/.config/thatch/thatch.db` (opencode) or the project directory
  (MCP).
- `THATCH_MODEL`: Hugging Face model name for embeddings. Defaults to
  `Xenova/bge-small-en-v1.5` (34 MB, 384-dimensional).
- `THATCH_EMBEDDING_BACKEND`: embedding compute backend. Defaults to
  `wasm` (pure JavaScript/WebAssembly, no native addons). Set to
  `native` to use the onnxruntime-node addon instead.
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

## Deleted memories are guarded

Deleting a memory means deleted, and guarded. The forget writes a
tombstone: a small record of the deleted content (an exact content hash
plus its embedding) that stays in the store permanently.

Every memory write - from the tool, from the CLI, or from the
fact-extractor - checks the tombstones first. A write whose content
matches a deleted memory (byte-identical, or semantically very close) is
not saved and not silently dropped. It is held, and the agent sees a
message like this:

- the store and label of the refused write,
- the deleted memory's label and the date it was deleted,
- the command that clears the guard, `thatch tombstones --clear`.

If the deletion was right, no action is needed - the hold is the system
working. The agent should not retry the write.

To deliberately re-admit deleted knowledge (the only path), clear the
guard first and repeat the write: `thatch tombstones --clear <label>`
(with the store as the second argument for non-project stores). The
clear never touches live memories - a live memory sharing the label is
untouched - and the memory itself stays gone until re-saved. List the
standing guards with `thatch tombstones [store]`.

Guards are permanent until cleared. There is no expiry, because a guard
that expires can silently undo a deliberate deletion.

One accepted trade: re-creating a memory under a tombstoned label with
only slightly different wording can be held (the semantic match). That
is recoverable with the clear command above, and it is the price of the
promise - the alternative is deleted content quietly re-entering the
store through the fact-extractor re-deriving it from a display.

## Archived memories

Memories can be marked `archived` to exclude them from default search
results without deleting them. Archived memories are useful for
consolidating branch-scoped context after a merge: the branch-scoped
memories become a single archived record that future sessions can find
with `includeArchived: true` but that does not clutter normal recall.

See [prediction-engine.md](prediction-engine.md) for the user decision
model and [behavior-engine.md](behavior-engine.md) for self-discipline
rules.
