import { Database } from "bun:sqlite";
import { ScoringEngine } from "./scoring-engine";

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

const config = {
  matchersTable: "behavior_matchers",
  itemsTable: "behaviors",
  edgesTable: "behavior_edges",
  provenanceTable: "behavior_provenance",
  itemForeignKey: "behavior_id",
};

/**
 * Behavior engine: the LLM's codified self-discipline rules.
 * Same four-table shape as the prediction engine but separate
 * tables because the semantics differ. Predictions model what
 * the USER wants; behaviors model what the LLM should do.
 * Delegates to ScoringEngine for all SQL and scoring logic.
 */
export class BehaviorEngine {
  #engine: ScoringEngine;

  constructor(db: Database) {
    this.#engine = new ScoringEngine(db, config);
  }

  findBehaviorMatchers(stores: string[], queryEmbedding: Float32Array, opts?: { limit?: number }) {
    return this.#engine.findMatchers(stores, queryEmbedding, opts);
  }

  scoreBehaviors(matchers: { id: string; description: string; score: number }[]): ScoredBehavior[] {
    return this.#engine.scoreItems(matchers).map((s) => ({
      matcher_id: s.matcher_id,
      matcher_description: s.matcher_description,
      behavior_id: s.item_id,
      statement: s.statement,
      confidence: s.confidence,
      evidence_count: s.evidence_count,
      score: s.score,
      rationale: s.rationale,
    }));
  }

  scoreBehaviorNudge(stores: string[], embedding: Float32Array, threshold: number, limit = 5): BehaviorNudgeItem[] {
    return this.#engine.scoreNudge(stores, embedding, threshold, limit);
  }

  findNearestBehaviorMatcher(store: string, embedding: Float32Array, threshold: number): { id: string; description: string } | null {
    return this.#engine.findNearestMatcher(store, embedding, threshold);
  }

  createBehaviorMatcher(store: string, description: string, embedding: Float32Array, model: string): string {
    return this.#engine.createMatcher(store, description, embedding, model);
  }

  findNearestBehavior(store: string, embedding: Float32Array, threshold: number): BehaviorRow | null {
    return this.#engine.findNearestItem(store, embedding, threshold) as BehaviorRow | null;
  }

  createBehavior(store: string, statement: string, rationale: string, embedding: Float32Array, model: string): string {
    return this.#engine.createItem(store, statement, rationale, embedding, model);
  }

  createBehaviorEdge(matcherId: string, behaviorId: string, weight: number): void {
    return this.#engine.createEdge(matcherId, behaviorId, weight);
  }

  adjustBehaviorConfidence(behaviorId: string, signal: "confirm" | "disconfirm" | "soft"): void {
    return this.#engine.adjustConfidence(behaviorId, signal);
  }

  getBehavior(behaviorId: string): BehaviorRow | null {
    return this.#engine.getItem(behaviorId) as BehaviorRow | null;
  }

  addBehaviorProvenance(behaviorId: string, signal: string, detail: string): void {
    return this.#engine.addProvenance(behaviorId, signal, detail);
  }

  getBehaviorProvenance(behaviorId: string): { signal: string; detail: string | null; created_at: string }[] {
    return this.#engine.getProvenance(behaviorId);
  }

  deleteBehavior(behaviorId: string): boolean {
    return this.#engine.deleteItem(behaviorId);
  }

  listBehaviors(store: string) {
    return this.#engine.listItems(store);
  }
}
