# Development

## Architecture

Thatch is an opencode plugin — it runs inside opencode's Bun runtime. There is
no background process and no server of its own: everything happens inside
opencode's plugin hooks and tool dispatch.

```
opencode process
  └── Bun runtime
       ├── thatch plugin (src/index.ts)
       │    ├── git.ts        → detect repo identity (store name)
       │    ├── db.ts         → SQLite CRUD, cosine search, dedup verdicts
       │    ├── embeddings.ts → embedding model via transformers.js
       │    ├── tools.ts      → thatch_memory_* / thatch_store_* tools
       │    ├── extraction.ts → per-session tool-interaction buffers
       │    ├── prompts.ts    → system prompt / compaction / reminder text
       │    └── skills.ts     → SKILL.md content + installer
       └── LLM calls tools via opencode's tool dispatch
bin/thatch                    → standalone CLI over the same db.ts (needs bun)
```

## Module responsibilities

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Plugin entry. Wires DB, model, extraction; registers tools and hooks; installs skills. Also defines the dedup tools. |
| `git.ts` | Parse `owner/repo` from git remote. Worktree-safe fallback chain. |
| `db.ts` | SQLite schema, CRUD for entries/stores, brute-force cosine search, dedup-pair verdict tracking. |
| `embeddings.ts` | Lazy-load the embedding model. Expose `queryEmbed`/`passageEmbed` and the model `name` (stored as an informational tag). `MockEmbeddingModel` for tests. |
| `tools.ts` | Factories for the `thatch_memory_*` and `thatch_store_*` tools. Each accepts injected DB + model. |
| `extraction.ts` | Buffers non-thatch tool interactions per session and serializes them into the JSON payload the extraction nudge carries. |
| `prompts.ts` | Text constants: system prompt, compaction context, session-start reminder. Tool lists here must match `index.ts` registrations. |
| `skills.ts` | `SKILL.md` content for `thatch-fact-extractor` and `thatch-dedup-classifier`, plus the installer. |

## Plugin hooks

`index.ts` registers these opencode integration points:

| Hook | What it does |
|------|-------------|
| `experimental.chat.system.transform` | Appends the thatch system prompt (store names, usage rules). |
| `experimental.session.compacting` | Appends re-familiarization context so a compacted session still knows thatch exists. |
| `tool.execute.after` | Buffers every non-`thatch_*` tool call into the session's extraction buffer. This is a plugin hook, NOT a bus event — do not move it into the `event` handler; the event bus has no such event and it will silently never fire. |
| `chat.message` | If the session has buffered interactions, flushes them and injects a synthetic text part carrying the extraction nudge + JSON payload. |
| `event` (`session.created`) | Sends the session-start reminder via `client.session.prompt`. The session id is at `event.properties.info.id`. |
| `dispose` | Closes the DB. |

Hook failures are logged with a `[thatch]` prefix — never swallowed silently.
Two of these hooks were dead for weeks because failures were invisible.

## Design invariants

1. **No global mutable state.** Every module accepts its dependencies
   explicitly. The plugin entry wires real defaults; tests inject mocks.
2. **Embedding is a separate concern.** `db.ts` knows nothing about embedding
   models — it stores/retrieves BLOBs and compares vectors handed to it.
3. **Extraction and dedup are agent-driven.** The plugin never writes memories
   on its own. It buffers, nudges, and surfaces candidates; the agent does the
   writing through the ordinary tools (guided by the installed skills). There
   is deliberately no background classification or locking machinery.
4. **Embedding spaces are discriminated by vector dimension, not model tag.**
   `recall`/`findDuplicates` skip vectors whose length differs from the query.
   The `model` column is informational. Switching `THATCH_MODEL` makes old
   memories invisible to search (not corrupted) until re-embedded.
5. **Store creation is implicit.** First `remember` to a new store creates it.
6. **Default recall scope is repo + global.** The tool layer hardcodes this.
7. **Skills are plugin-owned files.** Installed to
   `$XDG_CONFIG_HOME/opencode/skills` (never into the worktree — that would
   dirty user repos); drifted content is overwritten on plugin init.

## Data flow

```
thatch_memory_remember(label, content)
  → model.passageEmbed("# label\n\ncontent") → Float32Array
  → db.remember(store, label, content, embedding, model.name, opts)
      overwrite:false → atomic INSERT (PK constraint rejects duplicates)
      overwrite:true  → upsert + clear stale dedup verdicts for that slug
  → confirmation string

thatch_memory_recall(query)
  → model.queryEmbed(query) → Float32Array
  → db.recall([repo, "global"], queryEmbedding, {branch?, limit})
      skips entries with mismatched embedding dimension
      cosine similarity, sort desc, top-N
  → formatted results with scores

dedup cycle (agent-driven)
  → thatch_find_duplicates → pairs above threshold, minus checked pairs
  → agent loads thatch-dedup-classifier skill, classifies each pair
  → merges/deletes via thatch_memory_remember(overwrite)/thatch_memory_forget
  → thatch_dedup_mark_checked records verdicts for surviving pairs
  (overwriting or forgetting an entry clears its verdicts → can re-flag)

extraction cycle (agent-driven)
  → tool.execute.after buffers non-thatch tool calls per session (max 20)
  → next chat.message flushes the buffer into a nudge part with JSON payload
  → agent loads thatch-fact-extractor skill, saves facts via thatch_memory_remember
```

## Database

- Single SQLite file at `$XDG_CONFIG_HOME/thatch/thatch.db`
  (default `~/.config/thatch/thatch.db`), WAL mode, 5s busy timeout.
- Tables: `stores(name PK)`,
  `entries(slug, store, label, content, embedding BLOB, model, branch,
  confidence, created_at, updated_at, PK(slug, store))`,
  `dedup_pairs(store, slug_a, slug_b, status, checked_at, PK(store, slug_a, slug_b))`.
- Embeddings are raw Float32Array bytes. Serialization honors
  `byteOffset`/`byteLength` — transformers.js can return views into larger
  tensor buffers, and serializing the whole backing buffer corrupts vectors.
- Slugs: lowercase, whitespace→`-`, unicode letters/digits preserved,
  hash fallback for all-symbol labels. ASCII slugs match earlier releases.

## Embeddings

- Default model: `Xenova/bge-small-en-v1.5` (384-dim), override with
  `THATCH_MODEL`.
- First load downloads ~34 MB from Hugging Face Hub; cached thereafter.
  Load is lazy (first embed call) and memoized against concurrent init.
- Query prefix: `"Represent this sentence for searching relevant passages: "`;
  passages get no prefix (BGE asymmetric-search convention).
- All embedding computation is local — no API calls.

## Local development

```bash
bun install        # deps
bun test           # full suite; no network, no real config dirs
opencode           # self-hosts via .opencode/plugins/thatch.ts
```

## Release

```bash
mise run release patch|minor|major
```

Bumps version, tags, pushes; GitHub Actions publishes to npm via OIDC trusted
publishing (no tokens — see `.github/workflows/publish.yml`).
