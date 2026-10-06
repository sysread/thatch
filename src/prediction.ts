import { Database } from "bun:sqlite";
import { blobToVector, cosineSimilarity } from "./vector-math";
import { ScoringEngine, type NudgeItem, PREDICTION_K, PREDICTION_P0, PREDICTION_W_SOFT } from "./scoring-engine";

export { PREDICTION_K, PREDICTION_P0, PREDICTION_W_SOFT };

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

export interface PredictionNudgeItem extends NudgeItem {}

/** A pair of predictions that are cosine-close enough to be wordings of the
 *  same preference. Returned by findPredictionDuplicates for agent review. */
export interface PredictionDedupCandidate {
  store: string;
  predictionA: string;
  statementA: string;
  predictionB: string;
  statementB: string;
  cosine: number;
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

const config = {
  matchersTable: "prediction_matchers",
  itemsTable: "predictions",
  edgesTable: "prediction_edges",
  provenanceTable: "prediction_provenance",
  itemForeignKey: "prediction_id",
};

/**
 * Prediction engine: matchers (context patterns), predictions (graded
 * confidence statements), edges (weighted matcher-to-prediction links),
 * and provenance (audit trail). Delegates to ScoringEngine for all
 * SQL and scoring logic. Wraps the generic return types with
 * prediction-specific type names for caller clarity.
 */
export class PredictionEngine {
  #engine: ScoringEngine;
  // Kept for the dedup pass, whose tables are prediction-only (the shared
  // ScoringEngine stays unaware of them; the behavior engine has no pair
  // verdicts yet).
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
    this.#engine = new ScoringEngine(db, config);
  }

  findMatchers(stores: string[], queryEmbedding: Float32Array, opts?: { limit?: number }) {
    return this.#engine.findMatchers(stores, queryEmbedding, opts);
  }

  scorePredictions(matchers: { id: string; description: string; score: number }[]): ScoredPrediction[] {
    return this.#engine.scoreItems(matchers).map((s) => ({
      matcher_id: s.matcher_id,
      matcher_description: s.matcher_description,
      prediction_id: s.item_id,
      statement: s.statement,
      confidence: s.confidence,
      evidence_count: s.evidence_count,
      score: s.score,
      rationale: s.rationale,
    }));
  }

  scorePredictionNudge(stores: string[], embedding: Float32Array, threshold: number, limit = 5): PredictionNudgeItem[] {
    return this.#engine.scoreNudge(stores, embedding, threshold, limit);
  }

  findNearestMatcher(store: string, embedding: Float32Array, threshold: number): { id: string; description: string } | null {
    return this.#engine.findNearestMatcher(store, embedding, threshold);
  }

  createMatcher(store: string, description: string, embedding: Float32Array, model: string): string {
    return this.#engine.createMatcher(store, description, embedding, model);
  }

  findNearestPrediction(store: string | string[], embedding: Float32Array, threshold: number): PredictionRow | null {
    return this.#engine.findNearestItem(store, embedding, threshold) as PredictionRow | null;
  }

  createPrediction(store: string, statement: string, rationale: string, embedding: Float32Array, model: string): string {
    return this.#engine.createItem(store, statement, rationale, embedding, model);
  }

  createEdge(matcherId: string, predictionId: string, weight: number): void {
    return this.#engine.createEdge(matcherId, predictionId, weight);
  }

  adjustConfidence(predictionId: string, signal: "confirm" | "disconfirm" | "soft"): void {
    return this.#engine.adjustConfidence(predictionId, signal);
  }

  getPrediction(predictionId: string): PredictionRow | null {
    return this.#engine.getItem(predictionId) as PredictionRow | null;
  }

  addProvenance(predictionId: string, signal: string, detail: string): void {
    return this.#engine.addProvenance(predictionId, signal, detail);
  }

  getProvenance(predictionId: string): { signal: string; detail: string | null; created_at: string }[] {
    return this.#engine.getProvenance(predictionId);
  }

  deletePrediction(predictionId: string): boolean {
    return this.#engine.deleteItem(predictionId);
  }

  listPredictions(store: string) {
    return this.#engine.listItems(store);
  }

  /**
   * Corpus-level dedup: pairwise cosine over the store's predictions,
   * skipping pairs already adjudicated in prediction_dedup_pairs. The
   * cosine-only counterpart of the memory side's findDuplicates
   * (src/db.ts) - the co-fire refinement in the compounds plan layers
   * behavioral evidence on top of this same method later. Threshold 0.70
   * because [0.85, 1] is already caught at write time
   * (findNearestPrediction) and below 0.70 short-statement embeddings get
   * too noisy to call duplicates.
   */
  findPredictionDuplicates(store: string, threshold = 0.70): PredictionDedupCandidate[] {
    const rows = this.#db
      .query(
        "SELECT id, statement, embedding FROM predictions WHERE store = ? AND embedding IS NOT NULL ORDER BY id",
      )
      .all(store) as any[];

    if (rows.length < 2) return [];

    const preds = rows.map((r: any) => ({
      id: r.id as string,
      statement: r.statement as string,
      embedding: blobToVector(r.embedding),
    }));

    const checked = this.#checkedPairs(store);
    const candidates: PredictionDedupCandidate[] = [];
    for (let i = 0; i < preds.length; i++) {
      for (let j = i + 1; j < preds.length; j++) {
        const key = [preds[i].id, preds[j].id].sort().join("|");
        if (checked.has(key)) continue;
        if (preds[i].embedding.length !== preds[j].embedding.length) continue;

        const cosine = cosineSimilarity(preds[i].embedding, preds[j].embedding);
        if (cosine >= threshold) {
          candidates.push({
            store,
            predictionA: preds[i].id,
            statementA: preds[i].statement,
            predictionB: preds[j].id,
            statementB: preds[j].statement,
            cosine: Math.round(cosine * 1000) / 1000,
          });
        }
      }
    }

    candidates.sort((a, b) => b.cosine - a.cosine);
    return candidates;
  }

  /**
   * Record a pair verdict (duplicate | distinct) so findPredictionDuplicates
   * stops surfacing it. The id pair is stored in canonical sorted order -
   * the same contract as dedup_pairs - so (A,B) and (B,A) are one row.
   */
  markPairChecked(store: string, idA: string, idB: string, status: string): void {
    const [a, b] = [idA, idB].sort();
    this.#db.run(
      `INSERT INTO prediction_dedup_pairs (store, id_a, id_b, status, checked_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT (store, id_a, id_b) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at`,
      [store, a, b, status],
    );
  }

  #checkedPairs(store: string): Set<string> {
    const rows = this.#db
      .query("SELECT id_a, id_b FROM prediction_dedup_pairs WHERE store = ?")
      .all(store) as any[];
    return new Set(rows.map((r: any) => [r.id_a, r.id_b].sort().join("|")));
  }
}
