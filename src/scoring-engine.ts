import { Database } from "bun:sqlite";
import { blobToVector, cosineSimilarity } from "./vector-math";

/**
 * Bayesian confidence model constants shared by both engines. The
 * posterior is:
 *   p = (confirm_count + K * P0) / (confirm_count + disconfirm_count + K)
 * K is the prior strength (pseudo-evidence count): K=5 means 5
 * pseudo-evidence "anchors" the prior. P0 is the prior probability
 * (p=0.5 = "no preference either way"). W_SOFT is the fractional
 * weight for a soft (weak) signal: 0.25 means a soft disconfirm
 * counts as 1/4 of a full disconfirm.
 */
export const PREDICTION_K = 5;
export const PREDICTION_P0 = 0.5;
export const PREDICTION_W_SOFT = 0.25;

export interface ScoredItem {
  matcher_id: string;
  matcher_description: string;
  item_id: string;
  statement: string;
  confidence: number;
  evidence_count: number;
  score: number;
  rationale: string | null;
}

export interface NudgeItem {
  confidence: number;
  evidence_count: number;
  matcher_description: string;
  statement: string;
}

/**
 * Raw row from the items table (predictions or behaviors). Returned by
 * findNearestItem and getItem. The wrapper engines cast this to their
 * own PredictionRow / BehaviorRow types, which have the same shape.
 */
export interface ItemRow {
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

export interface EngineConfig {
  matchersTable: string;
  itemsTable: string;
  edgesTable: string;
  provenanceTable: string;
  /** FK column in edges and provenance tables that references the items table id */
  itemForeignKey: string;
}

/**
 * Generic scoring engine shared by the prediction and behavior engines.
 * Both use the same four-table shape (matchers, items, edges, provenance)
 * with the same Bayesian confidence model. The only differences are
 * table names and FK column names, which are fixed at module load time.
 *
 * Table names are interpolated into SQL strings, not parameterized with ?,
 * because SQLite does not support parameterized table names. This is safe
 * because the config values are compile-time constants, not user input.
 */
export class ScoringEngine {
  #db: Database;
  #cfg: EngineConfig;

  constructor(db: Database, cfg: EngineConfig) {
    this.#db = db;
    this.#cfg = cfg;
  }

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
        `SELECT id, description, embedding FROM ${this.#cfg.matchersTable}
         WHERE store IN (${placeholders}) AND embedding IS NOT NULL`,
      )
      .all(...(stores as [string, ...string[]])) as any[];

    const scored: { id: string; description: string; score: number }[] = [];
    for (const r of rows) {
      const emb = blobToVector(r.embedding);
      if (emb.length !== queryEmbedding.length) continue;
      const score = cosineSimilarity(queryEmbedding, emb);
      // Noise floor: filter near-zero and negative cosine scores.
      // Callers apply the actual relevance threshold (e.g., 0.60).
      if (score >= 0.01) {
        scored.push({ id: r.id, description: r.description, score: Math.round(score * 1000) / 1000 });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  scoreItems(
    matchers: { id: string; description: string; score: number }[],
  ): ScoredItem[] {
    if (matchers.length === 0) return [];
    const matcherIds = matchers.map((m) => m.id);
    const placeholders = matcherIds.map(() => "?").join(", ");
    const { itemsTable, edgesTable, itemForeignKey } = this.#cfg;
    const rows = this.#db
      .query(
        `SELECT p.id, p.statement, p.rationale, p.confidence, p.confirm_count, p.disconfirm_count,
                e.matcher_id, e.weight
         FROM ${edgesTable} e
         JOIN ${itemsTable} p ON e.${itemForeignKey} = p.id
         WHERE e.matcher_id IN (${placeholders})
         ORDER BY p.statement`,
      )
      .all(...(matcherIds as [string, ...string[]])) as any[];

    const matcherMap = new Map(matchers.map((m) => [m.id, m]));
    const scored: ScoredItem[] = [];
    for (const r of rows) {
      const matcher = matcherMap.get(r.matcher_id);
      if (!matcher) continue;

      const confidence = r.confidence as number;
      const evidence = Math.round(r.confirm_count + r.disconfirm_count);
      const score = matcher.score * (r.weight as number) * confidence;
      scored.push({
        matcher_id: r.matcher_id,
        matcher_description: matcher.description,
        item_id: r.id,
        statement: r.statement,
        confidence: Math.round(confidence * 1000) / 1000,
        evidence_count: evidence,
        score: Math.round(score * 1000) / 1000,
        rationale: r.rationale,
      });
    }
    scored.sort((a, b) => b.score - a.score);

    // Dedup by item ID: multiple matchers may link to the same item
    // via separate edges. Keep only the highest-scoring entry per item
    // so the nudge does not repeat the same item with different matcher
    // contexts.
    const seen = new Set<string>();
    return scored.filter((s) => {
      if (seen.has(s.item_id)) return false;
      seen.add(s.item_id);
      return true;
    });
  }

  scoreNudge(
    stores: string[],
    embedding: Float32Array,
    threshold: number,
    limit = 5,
  ): NudgeItem[] {
    const matchers = this.findMatchers(stores, embedding, { limit })
      .filter((m) => m.score >= threshold);
    if (matchers.length === 0) return [];
    return this.scoreItems(matchers)
      .slice(0, limit)
      .map((s) => ({
        confidence: s.confidence,
        evidence_count: s.evidence_count,
        matcher_description: s.matcher_description,
        statement: s.statement,
      }));
  }

  findNearestMatcher(
    store: string,
    embedding: Float32Array,
    threshold: number,
  ): { id: string; description: string } | null {
    const rows = this.#db
      .query(`SELECT id, description, embedding FROM ${this.#cfg.matchersTable} WHERE store = ? AND embedding IS NOT NULL`)
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
    return { id: best.row.id, description: best.row.description };
  }

  createMatcher(
    store: string,
    description: string,
    embedding: Float32Array,
    model: string,
  ): string {
    this.#db.run("INSERT OR IGNORE INTO stores (name) VALUES (?)", [store]);
    const id = crypto.randomUUID();
    const blob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO ${this.#cfg.matchersTable} (id, store, description, embedding, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, store, description, blob, model, now, now] as any,
    );
    return id;
  }

  findNearestItem(
    store: string,
    embedding: Float32Array,
    threshold: number,
  ): ItemRow | null {
    const { itemsTable } = this.#cfg;
    const rows = this.#db
      .query(
        `SELECT id, store, statement, rationale, confidence, confirm_count, disconfirm_count, created_at, updated_at, embedding
         FROM ${itemsTable}
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
    return rest;
  }

  createItem(
    store: string,
    statement: string,
    rationale: string,
    embedding: Float32Array,
    model: string,
  ): string {
    this.#db.run("INSERT OR IGNORE INTO stores (name) VALUES (?)", [store]);
    const id = crypto.randomUUID();
    const blob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO ${this.#cfg.itemsTable} (id, store, statement, rationale, embedding, model, confidence, confirm_count, disconfirm_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [id, store, statement, rationale, blob, model, PREDICTION_P0, now, now] as any,
    );
    return id;
  }

  createEdge(matcherId: string, itemId: string, weight: number): void {
    const now = new Date().toISOString();
    const { edgesTable, itemForeignKey } = this.#cfg;
    this.#db.run(
      `INSERT INTO ${edgesTable} (matcher_id, ${itemForeignKey}, weight, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(matcher_id, ${itemForeignKey}) DO NOTHING`,
      [matcherId, itemId, weight, now] as any,
    );
  }

  adjustConfidence(itemId: string, signal: "confirm" | "disconfirm" | "soft"): void {
    // The asymmetry (soft is a weak disconfirm, not a weak confirm) is
    // intentional: a soft signal means the user partially disagreed, not
    // partially agreed. There is no soft confirm; use "confirm" for weak
    // agreement.
    const deltaConfirm = signal === "confirm" ? 1 : 0;
    const deltaDisconfirm = signal === "disconfirm" ? 1 : (signal === "soft" ? PREDICTION_W_SOFT : 0);
    const k = PREDICTION_K;
    const p0 = PREDICTION_P0;
    const now = new Date().toISOString();
    // Atomic UPDATE: SQLite evaluates SET clause expressions using
    // pre-update column values, so (confirm_count + ?) equals the new
    // confirm_count in both the SET assignment and the confidence
    // expression. No read-modify-write race between connections.
    this.#db.run(
      `UPDATE ${this.#cfg.itemsTable}
       SET confirm_count = confirm_count + ?,
           disconfirm_count = disconfirm_count + ?,
           confidence = (confirm_count + ? + ? * ?) / (confirm_count + ? + disconfirm_count + ? + ?),
           updated_at = ?
       WHERE id = ?`,
      [deltaConfirm, deltaDisconfirm, deltaConfirm, k, p0, deltaConfirm, deltaDisconfirm, k, now, itemId] as any,
    );
  }

  getItem(itemId: string): ItemRow | null {
    const row = this.#db
      .query(
        `SELECT id, store, statement, rationale, confidence, confirm_count, disconfirm_count, created_at, updated_at FROM ${this.#cfg.itemsTable} WHERE id = ?`,
      )
      .get(itemId) as any;
    if (!row) return null;
    return row;
  }

  addProvenance(itemId: string, signal: string, detail: string): void {
    const id = crypto.randomUUID();
    const { provenanceTable, itemForeignKey } = this.#cfg;
    this.#db.run(
      `INSERT INTO ${provenanceTable} (id, ${itemForeignKey}, signal, detail) VALUES (?, ?, ?, ?)`,
      [id, itemId, signal, detail] as any,
    );
  }

  getProvenance(itemId: string): { signal: string; detail: string | null; created_at: string }[] {
    const { provenanceTable, itemForeignKey } = this.#cfg;
    return this.#db
      .query(`SELECT signal, detail, created_at FROM ${provenanceTable} WHERE ${itemForeignKey} = ? ORDER BY rowid DESC LIMIT 10`)
      .all(itemId) as any[];
  }

  deleteItem(itemId: string): boolean {
    const result = this.#db.run(`DELETE FROM ${this.#cfg.itemsTable} WHERE id = ?`, [itemId]);
    return result.changes > 0;
  }

  listItems(store: string): {
    id: string;
    statement: string;
    rationale: string | null;
    confidence: number;
    evidence_count: number;
    matchers: { id: string; description: string; weight: number }[];
  }[] {
    const { itemsTable, edgesTable, matchersTable, itemForeignKey } = this.#cfg;
    const itemRows = this.#db
      .query(
        `SELECT id, statement, rationale, confidence, confirm_count, disconfirm_count
         FROM ${itemsTable} WHERE store = ? ORDER BY confidence DESC`,
      )
      .all(store) as any[];

    return itemRows.map((p) => {
      const edgeRows = this.#db
        .query(
          `SELECT e.matcher_id, e.weight, m.description
           FROM ${edgesTable} e
           JOIN ${matchersTable} m ON e.matcher_id = m.id
           WHERE e.${itemForeignKey} = ?`,
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
}
