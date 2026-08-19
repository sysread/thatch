# Memory Store

The memory store is thatch's core feature: a SQLite-backed store of memories with semantic search via local embeddings. Everything else thatch does — extraction, hygiene, nudges, predictions, behaviors — reads from or writes to this store.

## What it does

The store persists memories keyed by label, scoped to a project store or the shared "global" store. Each memory is a labeled chunk of text an agent writes for a future session of itself to read.

- Stores memories keyed by label within a store. The store name is auto-detected from the git remote — the `owner/repo` slug — or falls back to `"global"` for cross-project knowledge.
- Semantic search via cosine similarity over BGE-small-en-v1.5 embeddings (384 dimensions, ~34 MB). The model runs locally and is lazy-loaded.
- Six tools: `memory_remember`, `memory_recall`, `memory_list`, `memory_show`, `memory_forget`, and `store_list`. All are defined in `src/tool-defs.ts`.
- Branch scoping. Memories can be scoped to a git branch for work-in-progress context, or left unscoped for project-wide knowledge. Branch-scoped memories are recalled alongside project-wide ones when the branch matches.
- Confidence grading on a 1–10 scale, stored per memory.
- Archived flag. Archived memories are long-term records excluded from search and hygiene by default. Pass `includeArchived: true` to surface them.
- Write-time duplicate detection. When a new memory is similar to existing ones (cosine ≥ 0.85), the save returns a warning listing the near-duplicates. The save always proceeds — the warning asks the agent to reconcile, never blocks.
- Asymmetric search. Query text gets a BGE-specific prefix for retrieval; stored passages get no prefix. This follows the BGE training convention for asymmetric search.
- Multi-model dimension check. Entries embedded by a model with a different vector dimension are silently skipped during search, not ranked. The `model` column is informational — dimension is the discriminator.
- Recall tracking. Each memory carries `recall_count` and `last_recalled_at`, stamped when an agent-initiated search returns it. The hygiene system uses these to detect stale memories.

## How it works

### Store detection

`src/git.ts` parses `owner/repo` from the git remote URL. The resolution chain is worktree-safe:

1. Parse `owner/repo` from `git remote get-url origin`.
2. Fall back to the basename of the git common dir (worktree-safe).
3. Fall back to the directory basename.
4. Falls back to `"unknown"` if none of the above yield a result.

The "global" store always exists — it is inserted at schema init (`INSERT OR IGNORE INTO stores (name) VALUES ('global')`). Store creation is implicit: the first `memory_remember` to a new store calls `ensureStore`, which creates it via `INSERT OR IGNORE`.

### Embedding model

`src/embeddings.ts` defines the `BgeEmbeddingModel` class.

- Model: `Xenova/bge-small-en-v1.5` — 384 dimensions, ~34 MB.
- Lazy-loaded via the `@huggingface/transformers` `pipeline("feature-extraction")` API. The first load downloads from Hugging Face Hub; subsequent loads use the cached model.
- Query prefix: `"Represent this sentence for searching relevant passages: "` — the BGE asymmetric search convention. Queries get the prefix; passages do not.
- Mean pooling and L2 normalization are applied via pipeline options.
- Output is a `Float32Array`.
- `MockEmbeddingModel` is available for tests.
- The model can be overridden via the `THATCH_MODEL` environment variable.

### Write path (memory_remember)

```text
agent calls memory_remember(label, content, opts)
  → model.passageEmbed("# label\n\ncontent")  →  Float32Array
  → db.findSimilar(store, embedding, { excludeSlug })  →  write-time collision check
  → db.remember(store, label, content, embedding, model.name, opts)
      overwrite:false  →  atomic INSERT (PK constraint rejects duplicates)
      overwrite:true   →  upsert + clear stale dedup verdicts for that slug
  → return confirmation + warning if similar memories found
```

The tool prepends `# ${label}\n\n` to the content before embedding. The stored `content` column holds this full formatted text — it is the exact input that was embedded, so a future re-embed requires no reconstruction.

The `findSimilar` call is a write-time collision check with no telemetry. It excludes the slug being written (self-exclusion on overwrite). If it finds entries with cosine ≥ 0.85, the return value includes a warning listing them.

The save always proceeds. The warning asks the agent to reconcile — merge into one entry (overwrite + forget the other) or record that they are genuinely distinct via `dedup_mark_checked`.

On overwrite, the upsert clears stale dedup verdicts: any `dedup_pairs` rows referencing that slug are deleted, since the content change may resolve or create duplicates.

### Read path (memory_recall)

```text
agent calls memory_recall(query, opts)
  → model.queryEmbed(query)  →  Float32Array
  → db.recall([repo, "global"], queryEmbedding, { branch?, limit })
      → db.search()  →  cosine scoring, sort desc, top-N
      → stamp recall_count + last_recalled_at on returned rows
  → return formatted results with scores
```

The tool layer hardcodes `[repo, "global"]` as the default search scope. Omitting the `store` parameter searches both. Passing a specific store searches only that store.

Entries with a mismatched embedding dimension are skipped during search — the `emb.length !== queryEmbedding.length` guard in `db.search()`. This handles the case where a different embedding model was used for older entries.

### Search vs. recall

Two methods, one scoring engine, different telemetry policy:

| Method | Telemetry | Used by |
|--------|-----------|---------|
| `db.search()` | None | Prompt-aware recall nudge (see [nudge-pipeline.md](nudge-pipeline.md)) |
| `db.recall()` | Stamps `recall_count` / `last_recalled_at` | `thatch_memory_recall` tool, CLI `thatch search` |

The distinction is deliberate. The recall nudge checks whether memories relate to a prompt — the plugin is looking, not the agent. Stamping telemetry on a nudge would inflate the "used recently" signal that hygiene reporting depends on. Only explicit agent-initiated recall stamps telemetry.

### Default recall scope

The tool layer hardcodes `[repo, "global"]` as the default search scope. This means a `memory_recall` call with no `store` argument searches both the project store and the global store. There is no way to search only the project store without the global store via the tool — pass an explicit `store` argument to scope to one.

### Archived memories

The `archived` column is an integer flag: `0` (default) is live, `1` is archived.

- `search()`, `findDuplicates()`, and the stale-entry count in hygiene all filter `WHERE archived = 0`.
- To search archived memories: pass `includeArchived: true` to `memory_recall`.
- To archive: write with `archived: true`. To unarchive: write with `archived: false`.
- Updating an already-archived memory requires an explicit `archived` parameter. The guard prevents accidental unarchival — the caller must consciously pass `archived: true` to keep it archived or `archived: false` to unarchive it.

### Slug generation

`slugify()` converts a label to a slug: lowercase, whitespace to hyphen, Unicode letters and digits preserved. All-symbol labels fall back to a hash so no label ever maps to an empty slug. ASCII labels produce the same slugs as earlier releases.

The slug plus store name form the composite primary key: `PRIMARY KEY (slug, store)`.

### CLI access

The `bin/thatch` CLI provides read-only access to the store:

| Command | Description |
|---------|-------------|
| `thatch stores` | List all stores |
| `thatch list [store]` | List memory labels in a store |
| `thatch show <label> [store]` | Display one memory |
| `thatch forget <label> [store]` | Delete one memory |
| `thatch search <query> [store]` | Semantic cosine search (limit 10; `"all"` searches project + global) |

## Interactions with other features

- **Extraction pipeline** ([extraction.md](extraction.md)): the extraction sub-agent writes memories via `memory_remember`. The extraction buffer drains on any `memory_remember` call.
- **Deduplication** ([deduplication.md](deduplication.md)): `find_duplicates` scans stored memories for cosine-similar pairs. `dedup_mark_checked` records verdicts in the `dedup_pairs` table. Overwriting or forgetting a memory clears its dedup verdicts.
- **Hygiene** ([hygiene.md](hygiene.md)): staleness checks use `recall_count` and `last_recalled_at` to find memories nobody has read recently. Duplicate checks use cosine search. Orphaned-branch detection finds branch-scoped memories whose branch no longer exists.
- **Nudge pipeline** ([nudge-pipeline.md](nudge-pipeline.md)): the recall nudge uses `db.search()` — not `db.recall()` — to avoid inflating telemetry. The nudge fires when search results exceed the similarity threshold (default 0.55).
- **Prediction engine** ([prediction-engine.md](prediction-engine.md)) and **behavior engine** ([behavior-engine.md](behavior-engine.md)): these share the same embedding model but store vectors in separate tables (`prediction_matchers`, `prediction_predictions`, `behavior_matchers`, `behavior_behaviors`). They do not read from or write to the `entries` table.

## Source files

| File | Responsibility |
|------|---------------|
| `src/db.ts` | SQLite schema, CRUD for entries and stores, brute-force cosine search (`search` vs. `recall`), dedup verdict tracking, prediction and behavior tables |
| `src/embeddings.ts` | `BgeEmbeddingModel` (lazy-load, query/passage embed, mean pooling, L2 normalization) and `MockEmbeddingModel` for tests |
| `src/git.ts` | Detect repo identity (store name) from git remote; worktree-safe fallback chain |
| `src/tool-defs.ts` | Tool definitions — single source of truth for all tools, including the six memory tools |
| `bin/thatch` | CLI subcommands: `stores`, `list`, `show`, `forget`, `search` |

## Key invariants

1. **No global mutable state.** Every module accepts dependencies explicitly. `ThatchDB` takes a path; `BgeEmbeddingModel` takes an optional pipeline factory; tools receive a `ctx` with `db` and `model`.

2. **Embedding is a separate concern.** `db.ts` stores and retrieves BLOBs and compares vectors handed to it. It knows nothing about embedding models — it never calls `passageEmbed` or `queryEmbed`. The tool layer is the bridge: it embeds, then hands the vector to the DB.

3. **Embedding spaces are discriminated by vector dimension, not model tag.** The `model` column is written on every save and returned on every read, but no code path filters or branches on it. Dimension mismatch is the only guard. This means a same-dimension model switch produces silently wrong cosine scores, while a different-dimension switch produces silently skipped entries.

4. **Store creation is implicit.** The first `memory_remember` to a new store creates it. There is no explicit "create store" operation.

5. **Default recall scope is repo + global.** The tool layer hardcodes `[ctx.defaultStore, "global"]` when no `store` argument is provided. This is intentional — cross-project knowledge in the global store is always searched alongside project-specific memories.

6. **The write-time similarity warning never blocks the save.** `findSimilar` returns a warning, `remember` proceeds regardless. The warning asks the agent to reconcile after the fact.

7. **`search()` records no usage. `recall()` stamps telemetry. This is deliberate.** The recall nudge (plugin checking relevance) must not inflate the "used recently" signal. Only agent-initiated recall counts as actual usage.
