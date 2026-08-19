import { Database } from "bun:sqlite";
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

  constructor(db: Database) {
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

  findNearestPrediction(store: string, embedding: Float32Array, threshold: number): PredictionRow | null {
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
}
