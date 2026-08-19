import { Database } from "bun:sqlite";
import { blobToVector, cosineSimilarity } from "./vector-math";

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
 * Bayesian confidence model constants. The posterior is:
 *   p = (confirm_count + K * P0) / (confirm_count + disconfirm_count + K)
 * K is the prior strength (pseudo-evidence count): K=5 means 5
 * pseudo-evidence "anchors" the prior. P0 is the prior probability
 * (p=0.5 = "no preference either way"). W_SOFT is the fractional
 * weight for a soft (weak) signal: 0.25 means a soft disconfirm counts
 * as 1/4 of a full disconfirm.
 */
export const PREDICTION_K = 5;
export const PREDICTION_P0 = 0.5;
export const PREDICTION_W_SOFT = 0.25;

/**
 * Prediction engine: matchers (context patterns), predictions (graded
 * confidence statements), edges (weighted matcher-to-prediction links),
 * and provenance (audit trail). The statistical query is mechanical
 * (cosine + Bayesian scoring), not an LLM call. Formation and evaluation
 * are agent-driven via tool calls.
 */
export class PredictionEngine {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

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
    this.#db.run("INSERT OR IGNORE INTO stores (name) VALUES (?)", [store]);
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
    this.#db.run("INSERT OR IGNORE INTO stores (name) VALUES (?)", [store]);
    const id = crypto.randomUUID();
    const blob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO predictions (id, store, statement, rationale, embedding, model, confidence, confirm_count, disconfirm_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [id, store, statement, rationale, blob, model, PREDICTION_P0, now, now] as any,
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
    const deltaDisconfirm = signal === "disconfirm" ? 1 : (signal === "soft" ? PREDICTION_W_SOFT : 0);
    const k = PREDICTION_K;
    const p0 = PREDICTION_P0;
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
}
