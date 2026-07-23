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

export interface MatcherRow {
  id: string;
  store: string;
  description: string;
  embedding: Uint8Array | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface PredictionRow {
  id: string;
  store: string;
  statement: string;
  rationale: string | null;
  confidence: number;
  confirm_count: number;
  disconfirm_count: number;
  created_at: string;
  updated_at: string;
}

export interface PredictionNudgeItem {
  confidence: number;
  evidence_count: number;
  matcher_description: string;
  statement: string;
}

export interface ScoredPrediction {
  matcher_id: string;
  matcher_description: string;
  prediction_id: string;
  statement: string;
  confidence: number;
  evidence_count: number;
  score: number;
  rationale: string | null;
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
    // Enforce FK constraints per connection. The prediction tables use
    // ON DELETE CASCADE for edges and provenance; enabling this pragma
    // ensures those cascades fire. Also enforces the entries table's
    // existing FK to stores(name), which was declarative but unenforced
    // before this branch.
    this.#db.run("PRAGMA foreign_keys = ON");
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

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS prediction_matchers (
        id          TEXT PRIMARY KEY,
        store       TEXT NOT NULL REFERENCES stores(name),
        description TEXT NOT NULL,
        embedding   BLOB,
        model       TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS predictions (
        id              TEXT PRIMARY KEY,
        store           TEXT NOT NULL REFERENCES stores(name),
        statement       TEXT NOT NULL,
        rationale       TEXT,
        embedding       BLOB,
        model           TEXT,
        confidence      REAL NOT NULL DEFAULT 0.5,
        confirm_count   REAL NOT NULL DEFAULT 0,
        disconfirm_count REAL NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS prediction_edges (
        matcher_id    TEXT NOT NULL,
        prediction_id TEXT NOT NULL,
        weight        REAL NOT NULL DEFAULT 1.0,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY (matcher_id, prediction_id),
        FOREIGN KEY (matcher_id) REFERENCES prediction_matchers(id) ON DELETE CASCADE,
        FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS prediction_provenance (
        id            TEXT PRIMARY KEY,
        prediction_id TEXT NOT NULL,
        signal        TEXT NOT NULL,
        detail        TEXT,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
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
  // Prediction engine: matchers, predictions, edges, provenance
  // ---------------------------------------------------------------------------

  // Bayesian confidence model constants. The posterior is:
  //   p = (confirm_count + K * P0) / (confirm_count + disconfirm_count + K)
  // K is the prior strength (pseudo-evidence count): K=5 means 5
  // pseudo-evidence "anchors" the prior. P0 is the prior probability
  // (p=0.5 = "no preference either way"). W_SOFT is the fractional
  // weight for a soft (weak) signal: 0.25 means a soft disconfirm counts
  // as 1/4 of a full disconfirm.
  static readonly PREDICTION_K = 5;
  static readonly PREDICTION_P0 = 0.5;
  static readonly PREDICTION_W_SOFT = 0.25;

  /**
   * Brute-force cosine search over the matchers table for auto-fire.
   * Returns matchers ranked by similarity to the query embedding,
   * filtered by a noise floor (cosine >= 0.01) to exclude near-zero
   * and negative scores, and by model-space compatibility (dimension
   * match). Callers apply the actual relevance threshold (0.45 for
   * auto-fire in index.ts, caller-specified for sideband).
   */
  findMatchers(
    stores: string[],
    queryEmbedding: Float32Array,
    opts?: { limit?: number },
  ): { id: string; description: string; score: number }[] {
    if (stores.length === 0) return [];
    const limit = opts?.limit ?? 5;
    const placeholders = stores.map(() => "?").join(", ");
    const rows = this.#db
      .query(
        `SELECT id, description, embedding FROM prediction_matchers
         WHERE store IN (${placeholders}) AND embedding IS NOT NULL`,
      )
      .all(...(stores as [string, ...string[]])) as any[];

    const scored: { id: string; description: string; score: number }[] = [];
    for (const r of rows) {
      const emb = blobToVector(r.embedding);
      if (emb.length !== queryEmbedding.length) continue;
      const score = cosineSimilarity(queryEmbedding, emb);
      if (score >= 0.01) {
        scored.push({ id: r.id, description: r.description, score: Math.round(score * 1000) / 1000 });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Follows edges from matchers to scored predictions. Returns all
   * predictions reachable from any matching matcher, ranked by
   * cosine * weight * confidence.
   */
  scorePredictions(
    matchers: { id: string; description: string; score: number }[],
  ): ScoredPrediction[] {
    if (matchers.length === 0) return [];
    const matcherIds = matchers.map((m) => m.id);
    const placeholders = matcherIds.map(() => "?").join(", ");
    const rows = this.#db
      .query(
        `SELECT p.id, p.statement, p.rationale, p.confidence, p.confirm_count, p.disconfirm_count,
                e.matcher_id, e.weight
         FROM prediction_edges e
         JOIN predictions p ON e.prediction_id = p.id
         WHERE e.matcher_id IN (${placeholders})
         ORDER BY p.statement`,
      )
      .all(...(matcherIds as [string, ...string[]])) as any[];

    const matcherMap = new Map(matchers.map((m) => [m.id, m]));
    const scored: ScoredPrediction[] = [];
    for (const r of rows) {
      const matcher = matcherMap.get(r.matcher_id);
      if (!matcher) continue;

      const confidence = r.confidence as number;
      const evidence = Math.round(r.confirm_count + r.disconfirm_count);
      const score = matcher.score * (r.weight as number) * confidence;
      scored.push({
        matcher_id: r.matcher_id,
        matcher_description: matcher.description,
        prediction_id: r.id,
        statement: r.statement,
        confidence: Math.round(confidence * 1000) / 1000,
        evidence_count: evidence,
        score: Math.round(score * 1000) / 1000,
        rationale: r.rationale,
      });
    }
    scored.sort((a, b) => b.score - a.score);

    // Dedup by prediction_id: multiple matchers may link to the same
    // prediction via separate edges. Keep only the highest-scoring
    // entry per prediction so the nudge doesn't repeat the same
    // prediction with different matcher contexts.
    const seen = new Set<string>();
    return scored.filter((s) => {
      if (seen.has(s.prediction_id)) return false;
      seen.add(s.prediction_id);
      return true;
    });
  }

  /**
   * Full scoring pipeline for auto-fire and sideband: findMatchers,
   * filter by threshold, scorePredictions (which includes dedup by
   * prediction_id), slice, and map to PredictionNudgeItem. Shared by
   * index.ts (auto-fire) and sideband.ts (MCP path) to prevent
   * scoring-logic drift between the two host paths.
   */
  scorePredictionNudge(
    stores: string[],
    embedding: Float32Array,
    threshold: number,
    limit = 5,
  ): PredictionNudgeItem[] {
    const matchers = this.findMatchers(stores, embedding, { limit })
      .filter((m) => m.score >= threshold);
    if (matchers.length === 0) return [];
    return this.scorePredictions(matchers)
      .slice(0, limit)
      .map((s) => ({
        confidence: s.confidence,
        evidence_count: s.evidence_count,
        matcher_description: s.matcher_description,
        statement: s.statement,
      }));
  }

  /**
   * Finds the nearest matcher by cosine similarity above a caller-
   * specified threshold. Used for dedup at prediction_update time
   * (threshold 0.85), not auto-fire (use findMatchers for that).
   */
  findNearestMatcher(
    store: string,
    embedding: Float32Array,
    threshold: number,
  ): MatcherRow | null {
    const rows = this.#db
      .query("SELECT id, store, description, embedding, model, created_at, updated_at FROM prediction_matchers WHERE store = ? AND embedding IS NOT NULL")
      .all(store) as any[];

    let best: { row: any; score: number } | null = null;
    for (const r of rows) {
      const emb = blobToVector(r.embedding);
      if (emb.length !== embedding.length) continue;
      const score = cosineSimilarity(embedding, emb);
      if (score >= threshold && (!best || score > best.score)) {
        best = { row: r, score };
      }
    }
    if (!best) return null;
    return best.row as MatcherRow;
  }

  /** Creates a new matcher (context pattern) in the store, returning its id. */
  createMatcher(
    store: string,
    description: string,
    embedding: Float32Array,
    model: string,
  ): string {
    this.ensureStore(store);
    const id = crypto.randomUUID();
    const blob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const now = new Date().toISOString();
    this.#db.run(
      "INSERT INTO prediction_matchers (id, store, description, embedding, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, store, description, blob, model, now, now] as any,
    );
    return id;
  }

  /**
   * Finds the nearest prediction by cosine similarity across the
   * entire store (not scoped to a single matcher's edges). This
   * prevents duplicate predictions: when a new matcher is created,
   * it can link to an existing prediction via a new edge rather
   * than creating a second row with the same statement.
   */
  findNearestPrediction(
    store: string,
    embedding: Float32Array,
    threshold: number,
  ): PredictionRow | null {
    const rows = this.#db
      .query(
        `SELECT id, store, statement, rationale, confidence, confirm_count, disconfirm_count, created_at, updated_at, embedding
         FROM predictions
         WHERE store = ? AND embedding IS NOT NULL`,
      )
      .all(store) as any[];

    let best: { row: any; score: number } | null = null;
    for (const r of rows) {
      const emb = blobToVector(r.embedding);
      if (emb.length !== embedding.length) continue;
      const score = cosineSimilarity(embedding, emb);
      if (score >= threshold && (!best || score > best.score)) {
        best = { row: r, score };
      }
    }
    if (!best) return null;
    const { embedding: _, ...rest } = best.row;
    return rest as PredictionRow;
  }

  /**
   * Creates a new prediction, returning its id. Confidence is seeded
   * at p0 (the population prior).
   */
  createPrediction(
    store: string,
    statement: string,
    rationale: string,
    embedding: Float32Array,
    model: string,
  ): string {
    this.ensureStore(store);
    const id = crypto.randomUUID();
    const blob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO predictions (id, store, statement, rationale, embedding, model, confidence, confirm_count, disconfirm_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [id, store, statement, rationale, blob, model, ThatchDB.PREDICTION_P0, now, now] as any,
    );
    return id;
  }

  /** Ensures an edge links a matcher to a prediction. Does not overwrite existing edge weight. */
  createEdge(matcherId: string, predictionId: string, weight: number): void {
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO prediction_edges (matcher_id, prediction_id, weight, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(matcher_id, prediction_id) DO NOTHING`,
      [matcherId, predictionId, weight, now] as any,
    );
  }

/**
   * Adjusts a prediction's confidence by applying a signal, then
   * recomputing the Bayesian posterior. Mirrors samskara's
   * samskara_apply_evaluation: discount prior evidence is NOT applied
   * in v1 (no wall-clock decay), so counts accumulate monotonically.
   *
   * Signal mapping: "confirm" adds 1 to confirm_count; "disconfirm"
   * adds 1 to disconfirm_count; "soft" adds W_SOFT (0.25) to
   * disconfirm_count. The asymmetry (soft is a weak disconfirm, not
   * a weak confirm) is intentional: a soft signal means the user
   * partially disagreed, not partially agreed. There is no soft
   * confirm; use "confirm" for weak agreement.
   */
  adjustConfidence(predictionId: string, signal: "confirm" | "disconfirm" | "soft"): void {
    const deltaConfirm = signal === "confirm" ? 1 : 0;
    const deltaDisconfirm = signal === "disconfirm" ? 1 : (signal === "soft" ? ThatchDB.PREDICTION_W_SOFT : 0);
    const k = ThatchDB.PREDICTION_K;
    const p0 = ThatchDB.PREDICTION_P0;
    const now = new Date().toISOString();
    // Atomic UPDATE: uses the OLD column values in the confidence
    // expression, so (confirm_count + deltaConfirm) equals the new
    // confirm_count. No read-modify-write race between connections.
    this.#db.run(
      `UPDATE predictions
       SET confirm_count = confirm_count + ?,
           disconfirm_count = disconfirm_count + ?,
           confidence = (confirm_count + ? + ? * ?) / (confirm_count + ? + disconfirm_count + ? + ?),
           updated_at = ?
       WHERE id = ?`,
      [deltaConfirm, deltaDisconfirm, deltaConfirm, k, p0, deltaConfirm, deltaDisconfirm, k, now, predictionId] as any,
    );
  }

  /**
   * Returns the population prior p0 for a store. Falls back to
   * PREDICTION_P0 (0.5) when total evidence < 20; otherwise returns
   * confirm_count / total_evidence. v2 feature: not yet wired into
   * createPrediction, which uses flat PREDICTION_P0. v1 uses the
   * flat prior until enough evidence exists to derive a population rate.
   */
  populationP0(store: string): number {
    const row = this.#db
      .query(
        `SELECT SUM(confirm_count) AS c, SUM(disconfirm_count) AS d FROM predictions WHERE store = ?`,
      )
      .get(store) as { c: number | null; d: number | null } | null;
    const total = (row?.c ?? 0) + (row?.d ?? 0);
    if (total < 20) return ThatchDB.PREDICTION_P0;
    return row!.c! / total;
  }

  /**
   * Returns a prediction's metadata by id. Does not return the
   * embedding/model columns (creation-only, used by findNearestPrediction
   * for dedup at write time, not needed for display or scoring).
   */
  getPrediction(predictionId: string): PredictionRow | null {
    const row = this.#db
      .query(
        "SELECT id, store, statement, rationale, confidence, confirm_count, disconfirm_count, created_at, updated_at FROM predictions WHERE id = ?",
      )
      .get(predictionId) as any;
    if (!row) return null;
    return row as PredictionRow;
  }

  /**
   * Records a provenance entry (signal type + detail) for a prediction.
   * Provenance is an audit trail for the inspector and agent.
   */
  addProvenance(predictionId: string, signal: string, detail: string): void {
    const id = crypto.randomUUID();
    this.#db.run(
      "INSERT INTO prediction_provenance (id, prediction_id, signal, detail) VALUES (?, ?, ?, ?)",
      [id, predictionId, signal, detail] as any,
    );
  }

  /** Returns recent provenance entries for a prediction (newest first). */
  getProvenance(predictionId: string): { signal: string; detail: string | null; created_at: string }[] {
    return this.#db
      .query("SELECT signal, detail, created_at FROM prediction_provenance WHERE prediction_id = ? ORDER BY rowid DESC LIMIT 10")
      .all(predictionId) as any[];
  }

  /** Deletes a prediction. Edges and provenance cascade via FK ON DELETE CASCADE. */
  deletePrediction(predictionId: string): boolean {
    const result = this.#db.run("DELETE FROM predictions WHERE id = ?", [predictionId]);
    return result.changes > 0;
  }

  /** Lists all predictions with their matchers, for the inspector. */
  listPredictions(store: string): {
    id: string;
    statement: string;
    rationale: string | null;
    confidence: number;
    evidence_count: number;
    matchers: { id: string; description: string; weight: number }[];
  }[] {
    const predRows = this.#db
      .query(
        `SELECT id, statement, rationale, confidence, confirm_count, disconfirm_count
         FROM predictions WHERE store = ? ORDER BY confidence DESC`,
      )
      .all(store) as any[];

    return predRows.map((p) => {
      const edgeRows = this.#db
        .query(
          `SELECT e.matcher_id, e.weight, m.description
           FROM prediction_edges e
           JOIN prediction_matchers m ON e.matcher_id = m.id
           WHERE e.prediction_id = ?`,
        )
        .all(p.id) as any[];
      return {
        id: p.id,
        statement: p.statement,
        rationale: p.rationale,
        confidence: Math.round(p.confidence * 1000) / 1000,
        evidence_count: Math.round(p.confirm_count + p.disconfirm_count),
        matchers: edgeRows.map((e) => ({
          id: e.matcher_id,
          description: e.description,
          weight: e.weight,
        })),
      };
    });
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

  /** Runs fn inside a SQLite transaction (BEGIN/COMMIT/ROLLBACK). */
  transaction<T>(fn: () => T): T {
    const t = this.#db.transaction(fn);
    return t();
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
