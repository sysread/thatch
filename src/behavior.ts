import { Database } from "bun:sqlite";
import { blobToVector, cosineSimilarity } from "./vector-math";
import { PREDICTION_K, PREDICTION_P0, PREDICTION_W_SOFT } from "./prediction";

export interface BehaviorRow {
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

export interface BehaviorNudgeItem {
  confidence: number;
  evidence_count: number;
  matcher_description: string;
  statement: string;
}

export interface ScoredBehavior {
  matcher_id: string;
  matcher_description: string;
  behavior_id: string;
  statement: string;
  confidence: number;
  evidence_count: number;
  score: number;
  rationale: string | null;
}

/**
 * Behavior engine: the LLM's codified self-discipline rules. Same
 * four-table shape as the prediction engine (matchers, behaviors,
 * edges, provenance) but separate tables because the semantics differ.
 * Predictions model what the USER wants; behaviors model what the
 * LLM should do. The LLM grades its own behaviors (ham/spam), while
 * the user is the ground truth for predictions.
 */
export class BehaviorEngine {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Brute-force cosine search over behavior_matchers. Same pattern as
   * PredictionEngine.findMatchers but against the behavior tables.
   */
  findBehaviorMatchers(
    stores: string[],
    queryEmbedding: Float32Array,
    opts?: { limit?: number },
  ): { id: string; description: string; score: number }[] {
    if (stores.length === 0) return [];
    const limit = opts?.limit ?? 5;
    const placeholders = stores.map(() => "?").join(", ");
    const rows = this.#db
      .query(
        `SELECT id, description, embedding FROM behavior_matchers
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
   * Follows edges from matchers to scored behaviors. Same pattern as
   * PredictionEngine.scorePredictions but against the behavior tables.
   */
  scoreBehaviors(
    matchers: { id: string; description: string; score: number }[],
  ): ScoredBehavior[] {
    if (matchers.length === 0) return [];
    const matcherIds = matchers.map((m) => m.id);
    const placeholders = matcherIds.map(() => "?").join(", ");
    const rows = this.#db
      .query(
        `SELECT b.id, b.statement, b.rationale, b.confidence, b.confirm_count, b.disconfirm_count,
                e.matcher_id, e.weight
         FROM behavior_edges e
         JOIN behaviors b ON e.behavior_id = b.id
         WHERE e.matcher_id IN (${placeholders})
         ORDER BY b.statement`,
      )
      .all(...(matcherIds as [string, ...string[]])) as any[];

    const matcherMap = new Map(matchers.map((m) => [m.id, m]));
    const scored: ScoredBehavior[] = [];
    for (const r of rows) {
      const matcher = matcherMap.get(r.matcher_id);
      if (!matcher) continue;

      const confidence = r.confidence as number;
      const evidence = Math.round(r.confirm_count + r.disconfirm_count);
      const score = matcher.score * (r.weight as number) * confidence;
      scored.push({
        matcher_id: r.matcher_id,
        matcher_description: matcher.description,
        behavior_id: r.id,
        statement: r.statement,
        confidence: Math.round(confidence * 1000) / 1000,
        evidence_count: evidence,
        score: Math.round(score * 1000) / 1000,
        rationale: r.rationale,
      });
    }
    scored.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    return scored.filter((s) => {
      if (seen.has(s.behavior_id)) return false;
      seen.add(s.behavior_id);
      return true;
    });
  }

  /**
   * Full scoring pipeline for auto-fire and sideband. Shared by index.ts
   * and sideband.ts to prevent scoring-logic drift.
   */
  scoreBehaviorNudge(
    stores: string[],
    embedding: Float32Array,
    threshold: number,
    limit = 5,
  ): BehaviorNudgeItem[] {
    const matchers = this.findBehaviorMatchers(stores, embedding, { limit })
      .filter((m) => m.score >= threshold);
    if (matchers.length === 0) return [];
    return this.scoreBehaviors(matchers)
      .slice(0, limit)
      .map((s) => ({
        confidence: s.confidence,
        evidence_count: s.evidence_count,
        matcher_description: s.matcher_description,
        statement: s.statement,
      }));
  }

  findNearestBehaviorMatcher(
    store: string,
    embedding: Float32Array,
    threshold: number,
  ): { id: string; description: string } | null {
    const rows = this.#db
      .query("SELECT id, description, embedding FROM behavior_matchers WHERE store = ? AND embedding IS NOT NULL")
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

  createBehaviorMatcher(
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
      "INSERT INTO behavior_matchers (id, store, description, embedding, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, store, description, blob, model, now, now] as any,
    );
    return id;
  }

  findNearestBehavior(
    store: string,
    embedding: Float32Array,
    threshold: number,
  ): BehaviorRow | null {
    const rows = this.#db
      .query(
        `SELECT id, store, statement, rationale, confidence, confirm_count, disconfirm_count, created_at, updated_at, embedding
         FROM behaviors
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
    return rest as BehaviorRow;
  }

  createBehavior(
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
      `INSERT INTO behaviors (id, store, statement, rationale, embedding, model, confidence, confirm_count, disconfirm_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [id, store, statement, rationale, blob, model, PREDICTION_P0, now, now] as any,
    );
    return id;
  }

  createBehaviorEdge(matcherId: string, behaviorId: string, weight: number): void {
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO behavior_edges (matcher_id, behavior_id, weight, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(matcher_id, behavior_id) DO NOTHING`,
      [matcherId, behaviorId, weight, now] as any,
    );
  }

  /**
   * Adjusts a behavior's confidence using the same Bayesian posterior
   * as the prediction engine. The ham/spam feedback from the LLM maps
   * to confirm/disconfirm: relevant (ham) = confirm, not relevant (spam)
   * = disconfirm.
   */
  adjustBehaviorConfidence(behaviorId: string, signal: "confirm" | "disconfirm" | "soft"): void {
    const deltaConfirm = signal === "confirm" ? 1 : 0;
    const deltaDisconfirm = signal === "disconfirm" ? 1 : (signal === "soft" ? PREDICTION_W_SOFT : 0);
    const k = PREDICTION_K;
    const p0 = PREDICTION_P0;
    const now = new Date().toISOString();
    this.#db.run(
      `UPDATE behaviors
       SET confirm_count = confirm_count + ?,
           disconfirm_count = disconfirm_count + ?,
           confidence = (confirm_count + ? + ? * ?) / (confirm_count + ? + disconfirm_count + ? + ?),
           updated_at = ?
       WHERE id = ?`,
      [deltaConfirm, deltaDisconfirm, deltaConfirm, k, p0, deltaConfirm, deltaDisconfirm, k, now, behaviorId] as any,
    );
  }

  getBehavior(behaviorId: string): BehaviorRow | null {
    const row = this.#db
      .query(
        "SELECT id, store, statement, rationale, confidence, confirm_count, disconfirm_count, created_at, updated_at FROM behaviors WHERE id = ?",
      )
      .get(behaviorId) as any;
    if (!row) return null;
    return row as BehaviorRow;
  }

  addBehaviorProvenance(behaviorId: string, signal: string, detail: string): void {
    const id = crypto.randomUUID();
    this.#db.run(
      "INSERT INTO behavior_provenance (id, behavior_id, signal, detail) VALUES (?, ?, ?, ?)",
      [id, behaviorId, signal, detail] as any,
    );
  }

  getBehaviorProvenance(behaviorId: string): { signal: string; detail: string | null; created_at: string }[] {
    return this.#db
      .query("SELECT signal, detail, created_at FROM behavior_provenance WHERE behavior_id = ? ORDER BY rowid DESC LIMIT 10")
      .all(behaviorId) as any[];
  }

  deleteBehavior(behaviorId: string): boolean {
    const result = this.#db.run("DELETE FROM behaviors WHERE id = ?", [behaviorId]);
    return result.changes > 0;
  }

  listBehaviors(store: string): {
    id: string;
    statement: string;
    rationale: string | null;
    confidence: number;
    evidence_count: number;
    matchers: { id: string; description: string; weight: number }[];
  }[] {
    const rows = this.#db
      .query(
        `SELECT id, statement, rationale, confidence, confirm_count, disconfirm_count
         FROM behaviors WHERE store = ? ORDER BY confidence DESC`,
      )
      .all(store) as any[];

    return rows.map((b) => {
      const edgeRows = this.#db
        .query(
          `SELECT e.matcher_id, e.weight, m.description
           FROM behavior_edges e
           JOIN behavior_matchers m ON e.matcher_id = m.id
           WHERE e.behavior_id = ?`,
        )
        .all(b.id) as any[];
      return {
        id: b.id,
        statement: b.statement,
        rationale: b.rationale,
        confidence: Math.round(b.confidence * 1000) / 1000,
        evidence_count: Math.round(b.confirm_count + b.disconfirm_count),
        matchers: edgeRows.map((e) => ({
          id: e.matcher_id,
          description: e.description,
          weight: e.weight,
        })),
      };
    });
  }
}
