# QA — Test Plan

Thatch uses `bun:test` for all testing. Tests do not reach outside the sandbox
or make network calls.

## Test conventions

- **DB tests**: use `:memory:` databases, never real files
- **Embedding tests**: mock the embedding model with a fixed Float32Array
- **Git tests**: create temp directories with stub repos
- **Tool tests**: inject mock DB + model via factory functions
- **Path tests**: override `HOME` to a temp directory

## Running tests

```bash
bun test          # all tests
bun test --watch  # watch mode
```

## Test categories

### Unit — `tests/db.test.ts`

- Schema creation and migration
- CRUD operations on entries
- Store creation and listing
- Search (cosine similarity ranking)
- Overwrite protection
- Branch-scoped queries
- Edge cases: empty content, special characters in labels, concurrent writes

### Unit — `tests/git.test.ts`

- Parse HTTPS remote URLs
- Parse SSH remote URLs
- Parse git:// remote URLs
- Worktree detection (git-common-dir fallback)
- Non-git directory fallback
- Slash/hyphen handling in repo names

### Unit — `tests/embeddings.test.ts`

- Query embedding prefix application
- Passage embedding (no prefix)
- Model lazy loading
- Error handling when model fails to load
- Dimensionality consistency

### Unit — `tests/tools.test.ts`

- `thatch_memory_remember` — happy path, duplicate rejection, overwrite
- `thatch_memory_recall` — default scope (repo + global), explicit store, empty results
- `thatch_memory_list` — populated store, empty store
- `thatch_memory_show` — found, not found
- `thatch_memory_forget` — exists, doesn't exist
- `thatch_store_list` — populated, empty
- Argument validation (missing required fields)
- Default store resolution

## Use cases

See `docs/qa/use-cases/` for detailed scenarios with preconditions, steps, and
expected results.
