# Memory Store

The memory store is thatch's core feature: a SQLite-backed store of memories with semantic search via local embeddings. Everything else thatch does — extraction, hygiene, nudges, predictions, behaviors — reads from or writes to this store.

## What it does

The store persists memories keyed by label, scoped to a project store or the shared "global" store. Each memory is a labeled chunk of text an agent writes for a future session of itself to read.

- Stores memories keyed by label within a store. The store name is auto-detected from the git remote — the `owner/repo` slug — or falls back to `"global"` for cross-project knowledge.
- Semantic search via cosine similarity over BGE-small-en-v1.5 embeddings (384 dimensions, ~34 MB). The model runs locally and is lazy-loaded.
- Six tools: `memory_remember`, `memory_recall`, `memory_list`, `memory_show`, `memory_forget`, and `store_list`. All are defined in `src/tool-defs.ts`.
- Branch scoping. Memories can be scoped to a git branch for work-in-progress context, or left unscoped for project-wide knowledge. Branch-scoped memories are recalled alongside project-wide ones when the branch matches. An empty branch string is not a scope: `remember` coerces `""` to unscoped (git refnames are never empty), and renderers show any non-null scope so no scoping is invisible.
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
- `THATCH_MODEL=mock` selects `MockEmbeddingModel`: deterministic vectors derived from the exact input text (query path includes the prefix), no download and no ONNX. Supported in production source so the spawned tiers (MCP server, embedding daemon, hook one-shots) can assert real vectors hermetically; the in-process test mock in `tests/mocks/embeddings.ts` shares the same derivation.
- The model can be overridden via the `THATCH_MODEL` environment variable.
- Backend: runs on onnxruntime-web's pure-JS/wasm runtime by default. Before
  transformers initializes, `configureBackend()` pins
  `globalThis[Symbol.for("onnxruntime")]` to onnxruntime-web, so no
  onnxruntime-node NAPI wrap finalizers exist to panic Bun at process
  teardown (oven-sh/bun#34664). `THATCH_EMBEDDING_BACKEND=native` opts back
  into onnxruntime-node. Wasm runs single-threaded and uses
  `device: "auto"` with an explicit `wasm` execution provider (the override
  branch leaves transformers' device allowlist empty, so named devices throw).
- Native-memory hygiene: each embed copies the vector out of the output
  tensor, then disposes the tensor; after 10 idle minutes the pipeline's
  native sessions are released (an embed lazily re-loads). The plugin's
  `dispose` hook releases them at shutdown. All release paths are
  best-effort and never throw.

### The shared embedding daemon (MCP paths)

On Claude Code, every session runs its own `thatch mcp` process, and each
would otherwise load its own copy of the model (~1.6 GB warm RSS at 0.4.3;
issue #26 measured ~935 MB per session across 72 concurrent sessions on
0.3.5). The MCP paths
therefore share ONE model through a daemon: `src/embed-daemon/` moves the
model into one long-lived process per DB path, and every MCP session keeps
its session-scoped state (store detection, branch scope, chat identity) and
sends raw embed requests to it.

- The MCP server's model is built by `resolveEmbeddingModel` (`src/embed-daemon/client.ts`), which returns a `RemoteEmbeddingModel` implementing the same `EmbeddingModel` interface; the opencode plugin path is untouched (`SharedModelPool` already shares one model there).
- Resolution is lazy and memoized: at the first embed the wrapper probes the daemon socket (`cacheDir/embed.sock`); with no listener it spawns the daemon once (`ensureDaemonRunning`, `src/embed-daemon/supervisor.ts`); with a failed spawn or a model-name mismatch at hello it enters the `local-locked` state (the in-process model, locked in for the process lifetime). A healthy daemon means a session never imports the ONNX runtime at all.
- The cache dir is `/tmp/thatch-<uid>/thatch-<sha256(dbPath)[:16]>` on unix (created 0700 by the daemon; `tmpdir()` where /tmp is missing or unwritable, and on Windows). The base deliberately does NOT use `tmpdir()`: a direnv'd nix develop shell gives every shell its own TMPDIR, and that once produced 18 daemons for one DB path, each holding its own lock - the single-owner lock is only single-owner within one TMPDIR base, so the daemon anchors on `/tmp`, which no shell can vary (`<uid>` scopes the dir per user on shared machines). The sideband socket and version file keep `tmpdir()` because they are same-env by construction (hooks inherit their server's env); the daemon is the only cross-session actor.
- The wire contract (`src/embed-daemon/protocol.ts`) is newline-delimited JSON: connect, hello (answered with model, version, pid - before any model load, so cold starts never convert sessions to local-locked), at most one embed, close. Vector length is opaque; the DB discriminates spaces by dimension.
- Fallback has two forms: at resolve time (only a FAILED spawn attempt locks local), and at request time (a dead daemon delegates that embed to the lazy local model and the next embed re-probes, so recovery is automatic; three consecutive timeouts prefer local for a 60 s cool-down so a wedged daemon costs at most three slow embeds per minute).
- Lifecycle: the daemon's single-owner lock is SQLite's own - a `BEGIN EXCLUSIVE` transaction held for its lifetime on a dedicated `embed.lock.db` beside the socket (never on `thatch.db`, which would starve every writer). The kernel releases the lock when the holder dies, so there is no stale-lock path. A losing daemon exits 0 before touching the socket; the daemon idles out after `embedDaemon.idleExitMinutes` (default 30; `THATCH_EMBED_DAEMON_IDLE_MS` overrides) with no embed requests (hello never re-arms the timer), and disposes the model before every exit path (Bun #34664). Clients never unlink socket files; the next daemon unlinks a stale one under the lock.
- Bundled (plugin-regime) sessions participate fully - they probe, connect, and spawn like standalone sessions. The bundled mode's founding rule (skip machine-shared state) applies to state with COLLIDING multi-writer semantics (sideband socket, version file); the daemon has single-owner semantics (the sqlite lock), so the exclusion does not apply.

### Write path (memory_remember)

```text
agent calls memory_remember(label?, content, opts) - label is derived from the content's first heading or line when omitted
  → model.passageEmbed("# label\n\ncontent")  →  Float32Array
  → db.findSimilar(store, embedding, { excludeSlug })  →  write-time collision check
  → db.remember(store, label, content, embedding, model.name, opts)
      one write-lock-first transaction (BEGIN IMMEDIATE) around everything below
      entry creation (bare save, or overwrite onto an absent label):
        tombstone check FIRST (see Deletion guards) → held on a match
        bare save onto an existing label → the "already exists" error (PK constraint)
      entry update (overwrite: true resolving to a live row):
        tombstone check skipped → upsert + clear stale dedup verdicts for that slug
  → return confirmation + warning if similar memories found
```

The tool prepends `# ${label}\n\n` to the content before embedding. The stored `content` column holds this full formatted text — it is the exact input that was embedded, so a future re-embed requires no reconstruction.

The `findSimilar` call is a write-time collision check with no telemetry. It excludes the slug being written (self-exclusion on overwrite). If it finds entries with cosine ≥ 0.85, the return value includes a warning listing them.

The save always proceeds. The warning asks the agent to reconcile — merge into one entry (overwrite + forget the other) or record that they are genuinely distinct via `dedup_mark_checked`.

On overwrite, the upsert clears stale dedup verdicts: any `dedup_pairs` rows referencing that slug are deleted, since the content change may resolve or create duplicates.

The transaction is write-lock-first (`BEGIN IMMEDIATE`, `forgetEntry`'s pattern): the lock is taken before the tombstone and entry reads, so two thatch processes doing label maintenance on one store serialize — one commits, the other re-reads fresh state under the lock and upserts — instead of racing a deferred read snapshot into a spurious busy failure the agent must retry its way out of. A busy error is caught onto the failure arm rather than thrown (a thrown remember would surface as a host tool error and drain the extraction buffer through the fail-open gate on unreadable output shapes).

The tool description carries the overwrite hygiene line — an overwrite replaces the entry's whole content; do not overwrite with placeholder or test text. Prompt-level guidance by design: a mechanical similarity floor would block a legitimate two-word correction exactly as well as it blocks junk (both are dissimilar to the old content).

### Deletion guards (tombstones)

Forgetting a memory means "deleted, and guarded" (ruled November 2026,
after a live incident: a deliberate forget was silently undone ~90
seconds later because the fact-extractor re-derived the deleted memory
from a buffered `thatch show` output and minted it back).

`db.forgetEntry` is transactional and write-lock-first: it takes the
write lock (BEGIN IMMEDIATE), reads the doomed row's content and
embedding under the lock, INSERT OR REPLACEs a `memory_tombstones` row,
then deletes the entry and its dedup verdicts. Tombstone before delete,
the chat subsystem's ordering for the same hazard class.

`db.remember` runs the tombstone check FIRST on entry-creation writes -
before the label checks and before `ensureStore` (a held write creates
nothing). A creation is held when the content hash matches exactly or
the embedding's cosine similarity against a tombstone embedding is ≥
0.90 (`MEMORY_TOMBSTONE_THRESHOLD`; higher than `findSimilar`'s 0.85
because a hold is heavier than a warning, and the asymmetry favors
matching: a false hold is visible and one-step recoverable, a false
miss silently undoes a deliberate forget).

Scope inversion (November 2026): the guard originally policed every
write path (`bd2872c`); it now governs entry creation only. A write
carrying `overwrite: true` that resolves to a live row at `(slug,
store)` is an update and skips the guard entirely — updating a live
record cannot resurrect a deleted one, and the deleted sibling stays
deleted. Three live reports drove the narrowing: a keeper restore, an
enriched correction, and a polarity-negating correction of live
siblings were all held by tombstones of deleted near-duplicates.
Deleting a near-duplicate plants a guard in the content neighborhood
the live sibling shares, and an embedding of a negation sits close to
what it negates — so on the overwrite path the guard's only observable
effect was holding legitimate corrections. Accepted cost: a deliberate
overwrite can carry deliberately forgotten content under a live label
without a hold. The create-path hold and the CLI un-guard remain the
deliberate-deletion defenses.

The check and the insert run inside remember's write-lock-first
transaction (see the write path above); a busy/snapshot error from that
wrapping is caught onto the failure arm rather than thrown (a thrown
remember would drain the buffer through the fail-open gate on
unreadable output shapes).

The held write returns `{ ok: false, error, held }` - the error field
carries the fully formatted `[held]` message (the `MEMORY_HELD_MARKER`
constant lives in `src/db.ts`, the emitter), which the tool execute and
the CLI emit verbatim. The message contains no `[saved]` marker anywhere
(the MCP queue's drain gate is inclusion-based) and names the guard's
label, the deletion date, and the un-guard command. `held` is metadata
for tests, never a formatting source.

The un-guard is CLI-only by design: `thatch tombstones --clear <label>
[store]` calls `clearMemoryTombstones`, which removes every content
generation's row for the (store, slug) and never touches entries.
`memory_forget` deliberately does NOT clear guards: in the coexist state
(a live entry plus a same-label tombstone from an earlier generation),
overloading forget would delete the live entry and still not re-admit.
The tool API stays special-case-free; forget's output contract is
byte-identical to before the feature.

Tombstones are permanent until cleared - no TTL (unlike
`chat_leave_tombstones`, which age out: those are leave markers for
never-reused session ids; these guard re-mintable content). Residual
blind spots, named: the guard is store-scoped like every other memory
surface, so a cross-store re-mint passes; a sufficiently different
paraphrase of deleted content passes (the threshold trade); and
pre-feature deletions wrote no tombstones.

### Accept-then-teach guards

Three memory-tool keys are schema-optional but required in practice:
`memory_remember`'s `content` and `memory_show`/`memory_forget`'s `label`.
When a call omits the key, execute returns a teaching message naming the
right parameter and, for show/forget, how to find exact labels
(`memory_list` or `memory_recall`, then retry with the label copied in
full) instead of the call dying at validation. When the call MISNAMES the
key, the near-miss reaches the guard (unknown keys survive host
validation: the MCP validator clone deep-passthroughs and the opencode
plugin's declared schema permits them), and the guard answers with the
correction: "you passed 'labels'; did you mean
'label'?" - teach-only, the misnamed key's value is never applied.
Optionality is what makes the teaching reachable: on the
opencode v2 host the plugin's zod schema is compiled to JSON Schema and the
HOST validates, so a key left in the schema's required array rejects the
call before any plugin code runs (the declared v2 schema permits unknown
keys for the same reason - see `docs/dev/mcp-parity.md`). A `[saved]`
output is what drains the
extraction buffer and completes claims (both the opencode hook and the
MCP-host queue gate on the shared `MEMORY_SAVED_MARKER` constant from
`src/tool-defs.ts`), so a teaching-only call never drains; a `[forgotten]`
output only bumps the child deletion metric. The gates are fail-open on
output shapes they cannot read, and the execute-wrapped Code Mode path
stays ungated (its code-scan cannot see results); the residual
false-positives and the full contract are in `docs/dev/gotchas.md`
("LLMs guess tool-call shapes").

### Miss suggestions (did-you-mean)

A `memory_show`/`memory_forget` miss against a stored label appends a
fuzzy suggestion line: `Did you mean "X"?` (or git's "one of these"
phrasing for several, max 3). Candidates are the labels of the SAME store,
archived included. The matcher (`src/fuzzy.ts`) is a restricted
Damerau-Levenshtein with git's empirically-derived weights (adjacent
transposition free, substitution 2, insertion 1, deletion 3) and a
length-scaled threshold; it is git-strict - when nothing is close, no
suggestion line is appended, and a far-off label never gets a fallback guess.

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

- `search()`, `findDuplicates()`, and the hygiene queries (`staleEntryCount`, `branchesInStore`) all filter `WHERE archived = 0`.
- To search archived memories: pass `includeArchived: true` to `memory_recall`.
- To archive: write with `archived: true`. To unarchive: write with `archived: false`.
- Updating an already-archived memory requires an explicit `archived` parameter. The guard prevents accidental unarchival — the caller must consciously pass `archived: true` to keep it archived or `archived: false` to unarchive it.

### Slug generation

`slugify()` converts a label to a slug: lowercase, whitespace to hyphen, Unicode letters and digits preserved. All-symbol labels fall back to a hash so no label ever maps to an empty slug. ASCII labels produce the same slugs as earlier releases.

The slug plus store name form the composite primary key: `PRIMARY KEY (slug, store)`.

### CLI access

The `bin/thatch` CLI reads the store, and writes one way: `thatch
remember` saves through the same `memory_remember` tool execute() the
agents use (see [cli.md](cli.md)):

| Command | Description |
|---------|-------------|
| `thatch stores` | List all stores |
| `thatch list [store]` | List memory labels in a store |
| `thatch show <label> [store]` | Display one memory |
| `thatch forget <label> [store]` | Delete one memory |
| `thatch search <query> [store]` | Semantic cosine search (limit 10; `"all"` searches project + global) |
| `thatch remember <content> [flags]` | Save a memory (tool-equivalent write; `--label`, `--store`, `--branch`, `--confidence`, `--overwrite`) |

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
| `bin/thatch` | CLI subcommands: `stores`, `list`, `show`, `forget`, `search`, `remember` |
| `src/memory-write.ts` | `thatch remember` input parsing (shell flags + stdin -> memory_remember's argument shape); the write itself stays in the tool |

## Key invariants

1. **No global mutable state.** Every module accepts dependencies explicitly. `ThatchDB` takes a path; `BgeEmbeddingModel` takes an optional pipeline factory; tools receive a `ctx` with `db` and `model`.

2. **Embedding is a separate concern.** `db.ts` stores and retrieves BLOBs and compares vectors handed to it. It knows nothing about embedding models — it never calls `passageEmbed` or `queryEmbed`. The tool layer is the bridge: it embeds, then hands the vector to the DB.

3. **Embedding spaces are discriminated by vector dimension, not model tag.** The `model` column is written on every save and returned on every read, but no code path filters or branches on it. Dimension mismatch is the only guard. This means a same-dimension model switch produces silently wrong cosine scores, while a different-dimension switch produces silently skipped entries.

4. **Store creation is implicit.** The first `memory_remember` to a new store creates it. There is no explicit "create store" operation.

5. **Default recall scope is repo + global.** The tool layer hardcodes `[ctx.defaultStore, "global"]` when no `store` argument is provided. This is intentional — cross-project knowledge in the global store is always searched alongside project-specific memories.

6. **The write-time similarity warning never blocks the save.** `findSimilar` returns a warning, `remember` proceeds regardless. The warning asks the agent to reconcile after the fact.

7. **`search()` records no usage. `recall()` stamps telemetry. This is deliberate.** The recall nudge (plugin checking relevance) must not inflate the "used recently" signal. Only agent-initiated recall counts as actual usage.
