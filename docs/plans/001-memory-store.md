# Plan 001 — Memory Store

## Synopsis

Thatch is an opencode plugin providing persistent memory via local embeddings and
SQLite. Stores are containers keyed by git repo identity (`owner/repo`) with a
shared `global` store for cross-project knowledge.

## Decisions

### Scope

- **OpenCode plugin only** — no standalone CLI, no MCP mode. Runs entirely inside
  opencode's Bun runtime.
- Distributed as an npm package. Users add `"thatch"` to their `opencode.json`
  `plugin` array.

### Store naming

- `<owner>/<repo>` parsed from `git remote get-url origin`.
- Worktree-safe: `git rev-parse --git-common-dir` finds canonical repo root.
- Fallback chain: git remote → git common dir basename → CWD basename.
- Stores are created implicitly on first write (no explicit create tool).

### Tool surface

**`thatch_store_*`** — container management

| Tool | Behavior |
|------|----------|
| `thatch_store_list` | All stores in the database |

**`thatch_memory_*`** — CRUD on memories within a store

| Tool | Behavior |
|------|----------|
| `thatch_memory_remember` | Embed content, upsert into store. Rejects duplicate labels unless `overwrite: true`. |
| `thatch_memory_recall` | Embed query, cosine-similarity across `[repo-store]` + `global`, return top-N. |
| `thatch_memory_list` | Labels + metadata in a store. |
| `thatch_memory_show` | Full content by exact label. |
| `thatch_memory_forget` | Delete by label. |

Default search scope for `recall` is always repo store + global. Any tool
accepts an explicit `store` param to override the default.

### Tech stack

| Layer | Choice |
|-------|--------|
| SQLite | `bun:sqlite` (built-in, zero dependency) |
| Embeddings | `@huggingface/transformers` v4, `Xenova/bge-small-en-v1.5` (384-dim, 34 MB) |
| Vector search | Hand-rolled cosine similarity on Float32Array (5 lines, no dependency) |
| Plugin API | V1 (`server` export) — custom tools via `tool()` helper |
| Validation | Zod via `tool.schema` from `@opencode-ai/plugin` |

### Database

- **Path**: `~/.config/thatch/thatch.db` (single SQLite file, WAL mode)
- **Schema**: `stores(name TEXT PK)`, `entries(slug TEXT, store TEXT, label TEXT, content TEXT, embedding BLOB, model TEXT, branch TEXT, confidence INTEGER, created_at TEXT, updated_at TEXT, PRIMARY KEY (slug, store))`
- Embeddings stored as raw Float32Array bytes in BLOB columns.

### BGE model handling

- Query embedding: prefixed with `"Represent this sentence for searching relevant passages: "`
- Passage (memory) embedding: no prefix
- Model lazy-loaded on first `remember` or `recall` call.
- Model files cached by Hugging Face Hub in `~/.cache/huggingface/`.

### Test principles

- Tests never reach outside the sandbox or make network calls.
- SQLite tests use `:memory:` databases.
- Embedding model is mocked in tests.
- Git detection tests use temp directories with stub repos.
- `HOME` is overridden to a temp directory for path resolution.

## Architecture

```
src/index.ts         V1 plugin entry — exports `server` function
src/git.ts           Repo name detection
src/db.ts            SQLite schema, CRUD, brute-force search
src/embeddings.ts    BGE model lazy-load, embed API
src/tools.ts         Tool definitions (thatch_memory_*, thatch_store_*)
```

Each module accepts its dependencies explicitly (DB path, repo name, model
handle) so tests can inject mocks. The plugin entry wires them together with
real defaults.

## Dependencies

### Runtime

- `@huggingface/transformers` ^4 — `package.json` dependency

### Built-in (no install needed)

- `bun:sqlite` — Bun built-in
- `@opencode-ai/plugin` — provided by opencode runtime (devDependency for types)

### Dev

- `@opencode-ai/plugin` ^1 — types
- `@types/bun` — Bun type definitions
- TypeScript
