# Development

## Architecture

Thatch is an opencode plugin — it runs inside opencode's Bun runtime. The
process model is:

```
opencode process
  └── Bun runtime
       ├── thatch plugin (src/index.ts)
       │    ├── git.ts       → detect repo name
       │    ├── db.ts        → SQLite CRUD + search
       │    ├── embeddings.ts → bge-small-en-v1.5 via transformers.js
       │    └── tools.ts     → tool definitions
       └── LLM calls tools via opencode's tool dispatch
```

## Module responsibilities

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Plugin entry. Initializes DB, detects repo, registers tools. |
| `git.ts` | Parse `owner/repo` from git remote. Worktree-safe fallback chain. |
| `db.ts` | SQLite schema, CRUD for entries and stores, brute-force cosine search. |
| `embeddings.ts` | Lazy-load bge-small-en-v1.5 via transformers.js. Expose `queryEmbed` and `passageEmbed`. |
| `tools.ts` | Define `thatch_memory_*` and `thatch_store_*` tools. Each factory accepts injected DB + model. |

## Design invariants

1. **No global mutable state.** Every module accepts its dependencies explicitly.
   The plugin entry wires real defaults; tests inject mocks.
2. **Embedding is a separate concern.** `db.ts` knows nothing about embeddings —
   it stores/retrieves raw BLOBs and delegates similarity computation to the
   caller. The plugin entry orchestrates: embed → store, embed-query → compare.
3. **Store creation is implicit.** First `remember` to a new store auto-creates
   it. No explicit create tool needed.
4. **Default scope for recall is repo + global.** The tool layer hardcodes this.

## Data flow

```
thatch_memory_remember(label, content)
  → embeddings.passageEmbed(content) → Float32Array
  → db.upsert(slug, store, label, content, embedding)
  → return confirmation

thatch_memory_recall(query)
  → embeddings.queryEmbed(query) → Float32Array
  → db.search(queryEmbedding, stores: [repo, "global"], limit)
  → compute cosine similarity across all fetched embeddings
  → sort desc, take top-N
  → return formatted results
```

## Local development

```bash
# Install dependencies
bun install

# Run tests (no network, no real DB)
bun test

# Test in opencode (self-hosting)
# thatch loads itself as a plugin via opencode.json
opencode
```

## Database

- Single SQLite file at `~/.config/thatch/thatch.db`
- WAL mode for concurrent readers
- Schema managed by `db.ts` init — auto-creates tables and seeds `global` store

## Embeddings

- Model: `Xenova/bge-small-en-v1.5` (384-dimensional)
- First load downloads ~34 MB from Hugging Face Hub
- Subsequent loads use cached model files
- Query prefix: `"Represent this sentence for searching relevant passages: "`
- Passage/memory: no prefix
- All embedding computation runs locally — no API calls
