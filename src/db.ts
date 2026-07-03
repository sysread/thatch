import { Database } from "bun:sqlite";

export interface MemoryRow {
  slug: string;
  store: string;
  label: string;
  content: string;
  embedding: Uint8Array | null;
  model: string | null;
  branch: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
  dedup_checked_at: string | null;
}

export interface DedupCandidate {
  store: string;
  slugA: string;
  labelA: string;
  contentA: string;
  slugB: string;
  labelB: string;
  contentB: string;
  score: number;
}

/**
 * SQLite-backed store for thatch. All stores live in a single database
 * partitioned by a `store` column. Embeddings are raw Float32Array bytes
 * stored as BLOBs. Similarity search is brute-force cosine in JS.
 */
export class ThatchDB {
  #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true });
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run("PRAGMA busy_timeout = 5000");
    this.#initSchema();
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  #initSchema(): void {
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS stores (
        name TEXT PRIMARY KEY
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS entries (
        slug      TEXT NOT NULL,
        store     TEXT NOT NULL REFERENCES stores(name),
        label     TEXT NOT NULL,
        content   TEXT NOT NULL,
        embedding BLOB,
        model     TEXT,
        branch    TEXT,
        confidence INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (slug, store)
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS dedup_pairs (
        store     TEXT NOT NULL,
        slug_a    TEXT NOT NULL,
        slug_b    TEXT NOT NULL,
        status    TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (store, slug_a, slug_b)
      )
    `);

    this.#db.run("INSERT OR IGNORE INTO stores (name) VALUES ('global')");

    this.#migrateColumns();
  }

  #migrateColumns(): void {
    for (const col of ["dedup_checked_at"]) {
      if (!this.#columnExists("entries", col)) {
        this.#db.run(`ALTER TABLE entries ADD COLUMN ${col} TEXT`);
      }
    }
  }

  #columnExists(table: string, column: string): boolean {
    const rows = this.#db
      .query(`PRAGMA table_info(${table})`)
      .all() as any[];
    return rows.some((r: any) => r.name === column);
  }

  // ---------------------------------------------------------------------------
  // Stores
  // ---------------------------------------------------------------------------

  /** Lists all store names in the database. */
  listStores(): string[] {
    return this.#db
      .query("SELECT name FROM stores ORDER BY name")
      .all()
      .map((r: any) => r.name);
  }

  /** Ensures a store exists, creating it if it doesn't. Idempotent. */
  ensureStore(name: string): void {
    this.#db.run("INSERT OR IGNORE INTO stores (name) VALUES (?)", [name]);
  }

  // ---------------------------------------------------------------------------
  // Entries
  // ---------------------------------------------------------------------------

  slugify(label: string): string {
    return label
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "")
      .replace(/-+/g, "-");
  }

  entryExists(store: string, slug: string): boolean {
    const row = this.#db
      .query("SELECT 1 FROM entries WHERE slug = ? AND store = ?")
      .get(slug, store);
    return row !== null;
  }

  /**
   * Upserts a memory entry. Returns { ok: false } if a memory with the same
   * label already exists and `overwrite` is not set.
   */
  remember(
    store: string,
    label: string,
    content: string,
    embedding: Float32Array,
    model: string,
    opts?: { branch?: string; confidence?: number; overwrite?: boolean },
  ): { ok: true } | { ok: false; error: string } {
    const slug = this.slugify(label);
    this.ensureStore(store);

    if (this.entryExists(store, slug) && !opts?.overwrite) {
      return {
        ok: false,
        error: `A memory with label "${label}" already exists in store "${store}". ` +
          `Pass overwrite: true to replace it.`,
      };
    }

    const blob = new Uint8Array(embedding.buffer);
    const branch = opts?.branch ?? null;
    const confidence = opts?.confidence ?? null;
    const now = new Date().toISOString();

    this.#db.run(
      `
      INSERT INTO entries (slug, store, label, content, embedding, model, branch, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug, store) DO UPDATE SET
        label = excluded.label,
        content = excluded.content,
        embedding = excluded.embedding,
        model = excluded.model,
        branch = COALESCE(excluded.branch, entries.branch),
        confidence = COALESCE(excluded.confidence, entries.confidence),
        updated_at = excluded.updated_at
      `,
      [slug, store, label, content, blob, model, branch, confidence, now, now],
    );

    return { ok: true };
  }

  /**
   * Brute-force cosine similarity search across the given stores.
   * When branch is specified, includes project-wide (branch IS NULL) plus
   * branch-specific entries.
   */
  recall(
    stores: string[],
    queryEmbedding: Float32Array,
    opts?: { branch?: string; limit?: number },
  ): (MemoryRow & { _score: number })[] {
    const limit = opts?.limit ?? 10;
    const branch = opts?.branch;

    const placeholders = stores.map(() => "?").join(", ");

    interface SqlParams { sql: string; params: any[] }

    const { sql, params }: SqlParams = (() => {
      const base = `
        SELECT slug, store, label, content, embedding, model, branch, confidence, created_at, updated_at
        FROM entries
        WHERE store IN (${placeholders}) AND embedding IS NOT NULL
      `;

      if (branch) {
        return {
          sql: base + " AND (branch IS NULL OR branch = ?)",
          params: [...stores, branch],
        };
      }
      return { sql: base, params: stores };
    })();

    const rows = this.#db.query(sql).all(...(params as [any, ...any[]])) as unknown as MemoryRow[];

    if (rows.length === 0) return [];

    const scored = rows.map((row) => {
      const emb = new Float32Array(row.embedding!.buffer);
      return { ...row, embedding: row.embedding, _score: cosineSimilarity(queryEmbedding, emb) };
    });

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }

  /** Lists all entries in a store, returning metadata without content. */
  listEntries(store: string): { slug: string; label: string; branch: string | null; confidence: number | null; updated_at: string }[] {
    return this.#db
      .query(
        "SELECT slug, label, branch, confidence, updated_at FROM entries WHERE store = ? ORDER BY label",
      )
      .all(store)
      .map((r: any) => ({
        slug: r.slug,
        label: r.label,
        branch: r.branch,
        confidence: r.confidence,
        updated_at: r.updated_at,
      }));
  }

  /** Full content of a single entry by label. */
  showEntry(store: string, label: string): MemoryRow | null {
    const slug = this.slugify(label);
    return this.#db
      .query(
        "SELECT slug, store, label, content, embedding, model, branch, confidence, created_at, updated_at, dedup_checked_at FROM entries WHERE slug = ? AND store = ?",
      )
      .get(slug, store) as MemoryRow | null;
  }

  forgetEntry(store: string, label: string): boolean {
    const slug = this.slugify(label);
    if (!this.entryExists(store, slug)) return false;
    this.#db.run("DELETE FROM entries WHERE slug = ? AND store = ?", [slug, store]);
    this.#db.run("DELETE FROM dedup_pairs WHERE store = ? AND (slug_a = ? OR slug_b = ?)", [store, slug, slug]);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Deduplication
  // ---------------------------------------------------------------------------

  /** Finds pairs of entries with cosine similarity above the threshold. */
  findDuplicates(store: string, threshold = 0.85): DedupCandidate[] {
    const rows = this.#db
      .query(
        "SELECT slug, label, content, embedding FROM entries WHERE store = ? AND embedding IS NOT NULL ORDER BY slug",
      )
      .all(store) as any[];

    if (rows.length < 2) return [];

    const entries = rows.map((r: any) => ({
      slug: r.slug,
      label: r.label,
      content: r.content,
      embedding: new Float32Array(r.embedding.buffer),
    }));

    const candidates: DedupCandidate[] = [];
    const checked = this.#checkedPairs(store);

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const key = [entries[i].slug, entries[j].slug].sort().join("|");
        if (checked.has(key)) continue;

        const score = cosineSimilarity(entries[i].embedding, entries[j].embedding);
        if (score >= threshold) {
          candidates.push({
            store,
            slugA: entries[i].slug,
            labelA: entries[i].label,
            contentA: entries[i].content,
            slugB: entries[j].slug,
            labelB: entries[j].label,
            contentB: entries[j].content,
            score: Math.round(score * 1000) / 1000,
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  #checkedPairs(store: string): Set<string> {
    const rows = this.#db
      .query("SELECT slug_a, slug_b FROM dedup_pairs WHERE store = ?")
      .all(store) as any[];
    return new Set(rows.map((r: any) => [r.slug_a, r.slug_b].sort().join("|")));
  }

  /** Records a pair as reviewed with its classification. */
  markPairChecked(store: string, slugA: string, slugB: string, status: string): void {
    const [a, b] = [slugA, slugB].sort();
    const now = new Date().toISOString();
    this.#db.run(
      "INSERT OR REPLACE INTO dedup_pairs (store, slug_a, slug_b, status, checked_at) VALUES (?, ?, ?, ?, ?)",
      [store, a, b, status, now],
    );
  }

  /** Marks entries as dedup-checked so they're skipped in future passes. */
  markEntriesReviewed(store: string, slugs: string[]): void {
    if (slugs.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = slugs.map(() => "?").join(", ");
    this.#db.run(
      `UPDATE entries SET dedup_checked_at = ? WHERE store = ? AND slug IN (${placeholders})`,
      [now, store, ...slugs],
    );
  }

  close(): void {
    this.#db.close();
  }
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two Float32Array vectors.
 * Returns a value in [-1, 1]. Normalized embeddings will be close to [0, 1].
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}
