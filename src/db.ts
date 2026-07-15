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
  archived: boolean;
  created_at: string;
  updated_at: string;
  recall_count: number;
  last_recalled_at: string | null;
}

/** A semantically-similar existing entry, surfaced at write time. */
export interface SimilarEntry {
  slug: string;
  label: string;
  score: number;
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
        archived  INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at TEXT,
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

  // Databases created before recall telemetry lack these columns; the CREATE
  // above only covers fresh files.
  #migrateColumns(): void {
    const existing = new Set(
      (this.#db.query("PRAGMA table_info(entries)").all() as any[]).map((r) => r.name),
    );
    const wanted: [string, string][] = [
      ["recall_count", "INTEGER NOT NULL DEFAULT 0"],
      ["last_recalled_at", "TEXT"],
      ["archived", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [col, decl] of wanted) {
      if (!existing.has(col)) {
        this.#db.run(`ALTER TABLE entries ADD COLUMN ${col} ${decl}`);
      }
    }
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

  /**
   * Slugs are the primary key half derived from labels. Unicode letters and
   * digits are preserved so non-English labels don't collapse onto each other;
   * all-symbol labels fall back to a hash so no label ever maps to "".
   * ASCII labels produce the same slugs as earlier releases.
   */
  slugify(label: string): string {
    const slug = label
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "")
      .replace(/-+/g, "-");
    if (slug) return slug;

    let h = 0;
    for (const ch of label) {
      h = ((h << 5) - h + ch.codePointAt(0)!) | 0;
    }
    return "x" + (h >>> 0).toString(36);
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
    opts?: { branch?: string; confidence?: number; overwrite?: boolean; archived?: boolean },
  ): { ok: true } | { ok: false; error: string } {
    const slug = this.slugify(label);
    this.ensureStore(store);

    const blob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const branch = opts?.branch ?? null;
    const confidence = opts?.confidence ?? null;
    const archived = opts?.archived === true ? 1 : (opts?.archived === false ? 0 : null);
    const now = new Date().toISOString();

    if (!opts?.overwrite) {
      try {
        this.#db.run(
          `INSERT INTO entries (slug, store, label, content, embedding, model, branch, confidence, archived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [slug, store, label, content, blob, model, branch, confidence, archived ?? 0, now, now] as any,
        );
        return { ok: true };
      } catch (err: any) {
        if (String(err?.code ?? err).includes("CONSTRAINT")) {
          return {
            ok: false,
            error: `A memory with label "${label}" already exists in store "${store}". ` +
              `Pass overwrite: true to replace it.`,
          };
        }
        throw err;
      }
    }

    const existing = this.#db
      .query("SELECT archived FROM entries WHERE slug = ? AND store = ?")
      .get(slug, store) as { archived: number } | null;

    if (existing && existing.archived && opts?.archived === undefined) {
      return {
        ok: false,
        error: `"${label}" is archived. Pass archived: true to keep it archived, or archived: false to unarchive it.`,
      };
    }

    // archived column for upsert: the INSERT VALUES always needs a non-null
    // value (NOT NULL constraint), so use archived ?? 0. To preserve the
    // existing value when the caller doesn't specify archived, the UPDATE
    // clause accepts a nullable extra param: NULL means "keep existing."
    this.#db.run(
      `
      INSERT INTO entries (slug, store, label, content, embedding, model, branch, confidence, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug, store) DO UPDATE SET
        label = excluded.label,
        content = excluded.content,
        embedding = excluded.embedding,
        model = excluded.model,
        branch = COALESCE(excluded.branch, entries.branch),
        confidence = COALESCE(excluded.confidence, entries.confidence),
        archived = COALESCE(?, entries.archived),
        updated_at = excluded.updated_at
      `,
      [slug, store, label, content, blob, model, branch, confidence, archived ?? 0, now, now, archived] as any,
    );

    this.#db.run(
      "DELETE FROM dedup_pairs WHERE store = ? AND (slug_a = ? OR slug_b = ?)",
      [store, slug, slug],
    );

    return { ok: true };
  }

  /**
   * Brute-force cosine similarity search across the given stores.
   * When branch is specified, includes project-wide (branch IS NULL) plus
   * branch-specific entries. Does NOT stamp recall telemetry — the prompt-aware
   * nudge uses this to check whether memories relate to a prompt without
   * polluting recall_count/last_recalled_at (the agent hasn't actually read
   * them yet, only the plugin has checked for relevance).
   */
  search(
    stores: string[],
    queryEmbedding: Float32Array,
    opts?: { branch?: string; limit?: number; includeArchived?: boolean },
  ): (MemoryRow & { _score: number })[] {
    if (stores.length === 0) return [];

    const limit = opts?.limit ?? 10;
    const branch = opts?.branch;
    const includeArchived = opts?.includeArchived ?? false;

    const placeholders = stores.map(() => "?").join(", ");

    interface SqlParams { sql: string; params: any[] }

    const { sql, params }: SqlParams = (() => {
      const clauses = ["store IN (" + placeholders + ")", "embedding IS NOT NULL"];
      if (!includeArchived) clauses.push("archived = 0");
      const base = `
        SELECT slug, store, label, content, embedding, model, branch, confidence, archived, created_at, updated_at, recall_count, last_recalled_at
        FROM entries
        WHERE ${clauses.join(" AND ")}
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

    // Entries embedded by a different model live in a different vector space;
    // comparing them would produce NaN or nonsense scores, so they're skipped
    // rather than ranked. Dimension is the discriminator — model tags are
    // informational only.
    const scored = rows.flatMap((row) => {
      row.archived = !!row.archived;
      const emb = blobToVector(row.embedding!);
      if (emb.length !== queryEmbedding.length) return [];
      return [{ ...row, embedding: row.embedding, _score: cosineSimilarity(queryEmbedding, emb) }];
    });

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }

  /**
   * Semantic recall for agent-initiated searches. Delegates to search() for
   * cosine scoring, then stamps recall telemetry — retrieval is the "used
   * recently" signal hygiene reporting keys on.
   */
  recall(
    stores: string[],
    queryEmbedding: Float32Array,
    opts?: { branch?: string; limit?: number; includeArchived?: boolean },
  ): (MemoryRow & { _score: number })[] {
    const top = this.search(stores, queryEmbedding, opts);

    if (top.length > 0) {
      const now = new Date().toISOString();
      const rowKeys = top.map(() => "(?, ?)").join(", ");
      this.#db.run(
        `UPDATE entries SET recall_count = recall_count + 1, last_recalled_at = ?
         WHERE (store, slug) IN (VALUES ${rowKeys})`,
        [now, ...top.flatMap((r) => [r.store, r.slug])] as any,
      );
    }

    return top;
  }

  /**
   * Entries in a store semantically close to the given embedding — the
   * write-time collision check. Unlike recall(), this records no telemetry:
   * it's the plugin looking, not the agent using.
   */
  findSimilar(
    store: string,
    embedding: Float32Array,
    opts?: { threshold?: number; limit?: number; excludeSlug?: string },
  ): SimilarEntry[] {
    const threshold = opts?.threshold ?? 0.85;
    const limit = opts?.limit ?? 3;

    const rows = this.#db
      .query("SELECT slug, label, embedding FROM entries WHERE store = ? AND archived = 0 AND embedding IS NOT NULL")
      .all(store) as any[];

    const hits: SimilarEntry[] = [];
    for (const r of rows) {
      if (r.slug === opts?.excludeSlug) continue;
      const emb = blobToVector(r.embedding);
      if (emb.length !== embedding.length) continue;
      const score = cosineSimilarity(embedding, emb);
      if (score >= threshold) {
        hits.push({ slug: r.slug, label: r.label, score: Math.round(score * 1000) / 1000 });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** Lists all entries in a store, returning metadata without content. */
  listEntries(store: string): { slug: string; label: string; branch: string | null; confidence: number | null; archived: boolean; updated_at: string }[] {
    return this.#db
      .query(
        "SELECT slug, label, branch, confidence, archived, updated_at FROM entries WHERE store = ? ORDER BY label",
      )
      .all(store)
      .map((r: any) => ({
        slug: r.slug,
        label: r.label,
        branch: r.branch,
        confidence: r.confidence,
        archived: !!r.archived,
        updated_at: r.updated_at,
      }));
  }

  /** Full content of a single entry by label. */
  showEntry(store: string, label: string): MemoryRow | null {
    const slug = this.slugify(label);
    const row = this.#db
      .query(
        "SELECT slug, store, label, content, embedding, model, branch, confidence, archived, created_at, updated_at, recall_count, last_recalled_at FROM entries WHERE slug = ? AND store = ?",
      )
      .get(slug, store) as Record<string, unknown> | null;
    if (!row) return null;
    row.archived = !!row.archived;
    return row as unknown as MemoryRow;
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
        "SELECT slug, label, content, embedding FROM entries WHERE store = ? AND archived = 0 AND embedding IS NOT NULL ORDER BY slug",
      )
      .all(store) as any[];

    if (rows.length < 2) return [];

    const entries = rows.map((r: any) => ({
      slug: r.slug,
      label: r.label,
      content: r.content,
      embedding: blobToVector(r.embedding),
    }));

    const candidates: DedupCandidate[] = [];
    const checked = this.#checkedPairs(store);

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const key = [entries[i].slug, entries[j].slug].sort().join("|");
        if (checked.has(key)) continue;
        if (entries[i].embedding.length !== entries[j].embedding.length) continue;

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

  // ---------------------------------------------------------------------------
  // Hygiene — signals for the session-start heartbeat. Staleness means
  // neither written nor recalled since the cutoff; recall telemetry keeps
  // actively-used old memories out of the count.
  // ---------------------------------------------------------------------------

  /** Entries neither updated nor recalled since the cutoff (ISO timestamp). */
  staleEntryCount(store: string, cutoffIso: string): number {
    const row = this.#db
      .query(
        `SELECT COUNT(*) AS n FROM entries
         WHERE store = ? AND archived = 0 AND max(updated_at, COALESCE(last_recalled_at, updated_at)) < ?`,
      )
      .get(store, cutoffIso) as any;
    return row?.n ?? 0;
  }

  /** Distinct branches that scoped memories reference in a store. */
  branchesInStore(store: string): string[] {
    return this.#db
      .query("SELECT DISTINCT branch FROM entries WHERE store = ? AND branch IS NOT NULL ORDER BY branch")
      .all(store)
      .map((r: any) => r.branch);
  }

  /** Number of entries scoped to any of the given branches. */
  entryCountForBranches(store: string, branches: string[]): number {
    if (branches.length === 0) return 0;
    const placeholders = branches.map(() => "?").join(", ");
    const row = this.#db
      .query(`SELECT COUNT(*) AS n FROM entries WHERE store = ? AND archived = 0 AND branch IN (${placeholders})`)
      .get(store, ...branches) as any;
    return row?.n ?? 0;
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

  close(): void {
    this.#db.close();
  }
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

/**
 * Reconstructs a Float32Array from a stored BLOB. The Uint8Array bun:sqlite
 * hands back may itself be a view, so honor its offset and length rather than
 * reading the whole backing buffer.
 */
function blobToVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/**
 * Cosine similarity between two Float32Array vectors of equal dimension.
 * Returns a value in [-1, 1]. Normalized embeddings will be close to [0, 1].
 * Throws on dimension mismatch — comparing vectors from different embedding
 * spaces is always a caller bug; callers filter by length first.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
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
