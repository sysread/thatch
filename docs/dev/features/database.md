# Database

Thatch stores all data in a single SQLite file. The schema has 11 tables organized around three concerns: memory entries, the prediction engine, and the behavior engine.

## Configuration

- Default path: `$XDG_CONFIG_HOME/thatch/thatch.db` (override via `THATCH_DB_PATH`)
- PRAGMAs: `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`
- Single file, no external services

## Schema overview

11 tables in three groups:

| Group | Tables | Purpose |
|-------|--------|---------|
| Memory | `stores`, `entries`, `dedup_pairs` | Core memory CRUD + dedup verdicts |
| Prediction engine | `prediction_matchers`, `predictions`, `prediction_edges`, `prediction_provenance` | User decision model |
| Behavior engine | `behavior_matchers`, `behaviors`, `behavior_edges`, `behavior_provenance` | LLM self-discipline rules |

The prediction and behavior engines share the same four-table shape (matchers, items, edges, provenance) with different table names. They are separate because the semantics differ: predictions model what the user wants; behaviors model what the LLM should do.

## Memory tables

### stores

Registry of all store names. The `global` store is inserted automatically at schema init.

```sql
stores(name TEXT PRIMARY KEY)
```

### entries

The core table. Memory entries with embeddings, metadata, and usage telemetry.

```sql
entries(
  slug TEXT NOT NULL,
  store TEXT NOT NULL REFERENCES stores(name),
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  model TEXT,
  branch TEXT,
  confidence INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at TEXT,
  PRIMARY KEY (slug, store)
)
```

- `slug`: derived from label via `slugify()`. Unicode letters/digits preserved. All-symbol labels fall back to hash.
- `embedding`: raw Float32Array bytes. Null if not yet embedded.
- `model`: embedding model tag (informational; dimension is the real discriminator).
- `branch`: git branch scope. Null = project-wide.
- `confidence`: 1-10 scale. Null = unset.
- `archived`: 0 = live, 1 = archived. Search, dedup, and staleness queries all exclude archived by default.
- `recall_count` / `last_recalled_at`: usage telemetry, stamped by `db.recall()` (not `db.search()`).

### dedup_pairs

Records which duplicate-candidate pairs have been reviewed.

```sql
dedup_pairs(
  store TEXT NOT NULL,
  slug_a TEXT NOT NULL,
  slug_b TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (store, slug_a, slug_b)
)
```

- Slugs stored sorted (a < b) for canonical matching.
- `status`: "duplicate", "supplement", "contradiction", or "unrelated".
- Overwriting or forgetting either memory clears the verdict (DELETE in `remember()` and `forgetEntry()`).

## Prediction engine tables

### prediction_matchers

Situation descriptions that trigger predictions. Embedded, cosine-matched at `chat.message`.

```sql
prediction_matchers(
  id TEXT PRIMARY KEY,
  store TEXT NOT NULL REFERENCES stores(name),
  description TEXT NOT NULL,
  embedding BLOB,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

### predictions

User preference predictions with Bayesian confidence.

```sql
predictions(
  id TEXT PRIMARY KEY,
  store TEXT NOT NULL REFERENCES stores(name),
  statement TEXT NOT NULL,
  rationale TEXT,
  embedding BLOB,
  model TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  confirm_count REAL NOT NULL DEFAULT 0,
  disconfirm_count REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

- `confidence`: Bayesian posterior. `p = (confirm + K*P0) / (confirm + disconfirm + K)`, K=5, P0=0.5.
- `confirm_count` / `disconfirm_count`: REAL (fractional for soft signals, weight 0.25).

### prediction_edges

Many-to-many links between matchers and predictions.

```sql
prediction_edges(
  matcher_id TEXT NOT NULL REFERENCES prediction_matchers(id) ON DELETE CASCADE,
  prediction_id TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (matcher_id, prediction_id)
)
```

### prediction_provenance

Audit trail of every signal applied to a prediction.

```sql
prediction_provenance(
  id TEXT PRIMARY KEY,
  prediction_id TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  signal TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
)
```

- `signal`: "confirm", "disconfirm", "soft", or "create".

## Behavior engine tables

Same shape as prediction engine, with behavior-specific semantics.

### behavior_matchers

```sql
behavior_matchers(
  id TEXT PRIMARY KEY,
  store TEXT NOT NULL REFERENCES stores(name),
  description TEXT NOT NULL,
  embedding BLOB,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

### behaviors

```sql
behaviors(
  id TEXT PRIMARY KEY,
  store TEXT NOT NULL REFERENCES stores(name),
  statement TEXT NOT NULL,
  rationale TEXT,
  embedding BLOB,
  model TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  confirm_count REAL NOT NULL DEFAULT 0,
  disconfirm_count REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

### behavior_edges

```sql
behavior_edges(
  matcher_id TEXT NOT NULL REFERENCES behavior_matchers(id) ON DELETE CASCADE,
  behavior_id TEXT NOT NULL REFERENCES behaviors(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (matcher_id, behavior_id)
)
```

### behavior_provenance

```sql
behavior_provenance(
  id TEXT PRIMARY KEY,
  behavior_id TEXT NOT NULL REFERENCES behaviors(id) ON DELETE CASCADE,
  signal TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
)
```

- `signal`: "confirm" (ham), "disconfirm" (spam), or "codify".

## Schema migration

`recall_count`, `last_recalled_at`, and `archived` are added to pre-existing databases by an idempotent column migration at init. The migration uses `PRAGMA table_info` to check for the column's existence, then `ALTER TABLE ADD COLUMN` if missing. This handles databases created before these columns existed.

## Embedding serialization

Embeddings are raw Float32Array bytes stored as BLOBs. Serialization honors `byteOffset`/`byteLength` — transformers.js can return views into larger tensor buffers, and serializing the whole backing buffer corrupts vectors. Always serialize the view's own bytes, not the underlying buffer.

## Key invariants

- Single SQLite file, WAL mode, 5s busy timeout, foreign keys ON.
- Embedding spaces are discriminated by vector dimension, not model tag.
- Embedding serialization honors `byteOffset`/`byteLength` (views into larger buffers).
- Slugs are slugified labels; slug + store = composite PK.
- Dedup verdicts auto-clear when either memory is overwritten or forgotten.
- Archived memories excluded from search, dedup, and staleness by default.
- Column migration is idempotent (`PRAGMA table_info` + `ALTER TABLE`).

## Interactions with other features

- Memory store ([memory-store.md](memory-store.md)): `entries` table is the core; `stores` table is the registry
- Deduplication ([deduplication.md](deduplication.md)): `dedup_pairs` table tracks reviewed pairs
- Prediction engine ([prediction-engine.md](prediction-engine.md)): 4 prediction tables
- Behavior engine ([behavior-engine.md](behavior-engine.md)): 4 behavior tables
- Hygiene ([hygiene.md](hygiene.md)): `staleEntryCount` uses `recall_count` and `last_recalled_at`; `branchesInStore` uses `branch` column

## Source files

- `src/db.ts` — all schema, CRUD, search, scoring, migrations
