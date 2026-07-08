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
mise run check    # bun test + markdownlint (the CI gate)
mise run lint-md  # markdownlint only
```

`mise run check` is the canonical quality gate (also run by CI on push/PR to
`main`). Markdownlint enforces structural correctness on `README.md` and `docs/`
excluding `docs/plans/`; see `.markdownlint-cli2.jsonc` for rule config.

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
- `findSimilar`: threshold/ranking, self-exclusion, dimension skipping, no
  telemetry side effects
- Recall telemetry: returned rows (and only returned rows) stamped
- Hygiene queries: stale counting with recall-refresh, branch listing/counts
- Column migration: pre-telemetry databases gain the new columns on open

### `tests/git.test.ts`

- `parseGitUrl` across SSH shorthand, HTTPS/HTTP, `ssh://`, `git://`,
  GitLab/self-hosted, hyphens/dots, trailing whitespace, unparseable input

### `tests/git-integration.test.ts`

- `detectRepo` against real temp git repos: HTTPS remote, SSH remote,
  no-`.git`-suffix remote, no-remote fallback, non-git-directory fallback
- `listBranches`: local branches listed; empty outside a git repo

### `tests/embeddings.test.ts`

- `MockEmbeddingModel` contract: dims, loaded, determinism, query/passage
  equivalence, distinct texts → distinct near-orthogonal vectors, model name
- `BgeEmbeddingModel` (with injected pipeline factory): lazy-load, loaded
  state, concurrent load memoization, error retry, query prefix for
  asymmetric search, passage has no prefix, model name tag, default model name

### `tests/tools.test.ts`

- `thatch_memory_remember`: happy path, duplicate rejection, overwrite,
  explicit store, metadata
- `thatch_memory_recall`: default repo+global scope, empty results, store
  override, limit
- `thatch_memory_list` / `show` / `forget`: found, not-found, store override
- `thatch_store_list`
- `thatch_find_duplicates`: surfaces similar pairs, cluster grouping,
  no-match message, store override, skips checked pairs
- `thatch_dedup_mark_checked`: records verdict, store override
- Write-time collision warning: fires on similar content, silent for
  unrelated content, never warns against itself on overwrite

### `tests/plugin.test.ts`

- `server` export shape: all eight tools, every hook present, tools carry
  description/args/execute
- System transform and compaction hooks append their text
- `tool.execute.after` → `chat.message` extraction round-trip: nudge carries
  the JSON payload, buffers are per-session, flush is one-shot, `thatch_*`
  tools are excluded from buffering
- Skill files land under the redirected `XDG_CONFIG_HOME`
- `event` handler: calls `client.session.prompt` on `session.created` with
  correct session ID and nudge text; ignores non-`session.created` events
- `sessionStartReminder`: includes store name and recall instructions

### `tests/hygiene.test.ts`

- `hygieneReport`: silent on a healthy store; counts duplicate candidates,
  stale memories, and orphaned branch-scoped memories (against a real temp
  git repo); skips the branch check outside a git repo
- `sessionStartReminder` hygiene block: appended when present, omitted when
  null, single-arg call unchanged

## Known gaps

- `BgeEmbeddingModel`'s default `PipelineFactory` (the real HF import) is
  untested — exercising it means downloading the real model, which violates
  the no-network rule. The lazy-load logic is tested with an injected mock
  factory. The real model is exercised indirectly by any real opencode use.
- The skill install failure path in `index.ts` has no test (would require
  mocking `fs` to force a write error).
- `bin/thatch` has no automated tests; it is a thin shell over `db.ts`.

## Use cases

See `docs/qa/use-cases/` for manual end-to-end scenarios with preconditions,
steps, and expected results.
