# QA — Test Plan

Thatch uses `bun:test`. The full suite runs in well under a second with no
network access and no writes outside temp directories.

## Test conventions

- **DB tests** create a real SQLite file in a `mkdtempSync` temp directory,
  removed in `afterEach`. (Real files, not `:memory:` — WAL behavior differs.)
- **Embedding tests** use `MockEmbeddingModel`: hash-seeded deterministic
  vectors, so identical texts embed identically and unrelated texts land
  near-orthogonal. The real `BgeEmbeddingModel` is never instantiated in
  tests — nothing downloads models.
- **Git unit tests** exercise `parseGitUrl` on strings; **git integration
  tests** create throwaway repos in temp directories and run real git.
- **Tool tests** build tools via the factory functions with an injected temp
  DB + mock model, then call `execute` directly.
- **Plugin tests** call the `server` entry with a mock client and redirect
  `THATCH_DB_PATH` and `XDG_CONFIG_HOME` into a temp directory so skill
  installation never touches the real `~/.config`.

## Running tests

```bash
bun test          # all tests
bun test --watch  # watch mode
```

## Test files and coverage

### `tests/db.test.ts`

- `cosineSimilarity`: identical/orthogonal/opposite/zero vectors; throws on
  dimension mismatch
- Schema creation, store creation/idempotence
- `slugify`: ASCII, unicode preservation, hash fallback for all-symbol labels
- `remember`: insert, duplicate rejection without `overwrite`, overwrite,
  metadata, embedding round-trip through a view with non-zero `byteOffset`
- `recall`: ranking, multi-store, unknown store, empty store list, limit,
  branch scoping, skipping dimension-mismatched entries
- `listEntries`, `showEntry`, `forgetEntry`
- Dedup: `findDuplicates` thresholding, checked-pair suppression, verdict
  invalidation on overwrite and forget, dimension-mismatch pair skipping

### `tests/git.test.ts`

- `parseGitUrl` across SSH shorthand, HTTPS/HTTP, `ssh://`, `git://`,
  GitLab/self-hosted, hyphens/dots, trailing whitespace, unparseable input

### `tests/git-integration.test.ts`

- `detectRepo` against real temp git repos: HTTPS remote, SSH remote,
  no-`.git`-suffix remote, no-remote fallback, non-git-directory fallback

### `tests/embeddings.test.ts`

- `MockEmbeddingModel` contract: dims, loaded, determinism, query/passage
  equivalence, distinct texts → distinct near-orthogonal vectors, model name

### `tests/tools.test.ts`

- `thatch_memory_remember`: happy path, duplicate rejection, overwrite,
  explicit store, metadata
- `thatch_memory_recall`: default repo+global scope, empty results, store
  override, limit
- `thatch_memory_list` / `show` / `forget`: found, not-found, store override
- `thatch_store_list`

### `tests/plugin.test.ts`

- `server` export shape: all eight tools, every hook present, tools carry
  description/args/execute
- System transform and compaction hooks append their text
- `tool.execute.after` → `chat.message` extraction round-trip: nudge carries
  the JSON payload, buffers are per-session, flush is one-shot, `thatch_*`
  tools are excluded from buffering
- Skill files land under the redirected `XDG_CONFIG_HOME`

## Known gaps

- `BgeEmbeddingModel` itself (lazy load memoization, query prefixing) is
  untested — exercising it means downloading the real model, which violates
  the no-network rule. It is exercised indirectly by any real opencode use.
- The `event`/`session.created` reminder path has no test (needs a fuller
  opencode client mock).
- `bin/thatch` has no automated tests; it is a thin shell over `db.ts`.

## Use cases

See `docs/qa/use-cases/` for manual end-to-end scenarios with preconditions,
steps, and expected results.
