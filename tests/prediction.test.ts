import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../src/db";

let dbPath: string;
let dbDir: string;
let db: ThatchDB;
const store = "test-store";

function makeEmbed(seed: number, dim = 384): Float32Array {
  const vec = new Float32Array(dim);
  let h = seed;
  for (let i = 0; i < dim; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h |= 0;
    vec[i] = h / 0x80000000;
  }
  return vec;
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-pred-test-"));
  dbPath = join(dbDir, "test.db");
  db = new ThatchDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("prediction engine schema", () => {
  test("tables exist after init", () => {
    const tables = db.listPredictions(store);
    expect(tables).toEqual([]);
  });

  test("populationP0 returns fallback on empty store", () => {
    expect(db.populationP0(store)).toBe(0.5);
  });
});

describe("matcher creation and lookup", () => {
  test("createMatcher returns an id and findMatchers finds it", () => {
    const embed = makeEmbed(42);
    const id = db.createMatcher(store, "reviewing a PR with tech debt", embed, "test-model");
    expect(id).toBeTruthy();

    const found = db.findMatchers([store], embed, { limit: 5 });
    expect(found.length).toBe(1);
    expect(found[0].id).toBe(id);
    expect(found[0].description).toBe("reviewing a PR with tech debt");
    expect(found[0].score).toBeCloseTo(1, 3);
  });

  test("findNearestMatcher returns the closest above threshold", () => {
    const embed1 = makeEmbed(1);
    const embed2 = makeEmbed(2);
    db.createMatcher(store, "situation A", embed1, "test-model");
    db.createMatcher(store, "situation B", embed2, "test-model");

    const nearest = db.findNearestMatcher(store, embed1, 0.5);
    expect(nearest).not.toBeNull();
    expect(nearest!.description).toBe("situation A");
  });

  test("findNearestMatcher returns null below threshold", () => {
    const embed1 = makeEmbed(1);
    const embed2 = makeEmbed(999);
    db.createMatcher(store, "situation A", embed1, "test-model");

    const nearest = db.findNearestMatcher(store, embed2, 0.99);
    expect(nearest).toBeNull();
  });
});

describe("prediction creation and confidence", () => {
  test("createPrediction seeds confidence at p0", () => {
    const embed = makeEmbed(10);
    const predId = db.createPrediction(store, "skip it", "user said skip", embed, "m");
    const pred = db.getPrediction(predId);
    expect(pred).not.toBeNull();
    expect(pred!.confidence).toBeCloseTo(0.5, 5);
    expect(pred!.confirm_count).toBe(0);
    expect(pred!.disconfirm_count).toBe(0);
  });

  test("adjustConfidence confirm increases confidence", () => {
    const embed = makeEmbed(10);
    const predId = db.createPrediction(store, "skip it", "reason", embed, "m");
    db.adjustConfidence(predId, "confirm");
    const pred = db.getPrediction(predId);
    expect(pred!.confirm_count).toBe(1);
    expect(pred!.confidence).toBeGreaterThan(0.5);
  });

  test("adjustConfidence disconfirm decreases confidence", () => {
    const embed = makeEmbed(10);
    const predId = db.createPrediction(store, "skip it", "reason", embed, "m");
    db.adjustConfidence(predId, "disconfirm");
    const pred = db.getPrediction(predId);
    expect(pred!.disconfirm_count).toBe(1);
    expect(pred!.confidence).toBeLessThan(0.5);
  });

  test("adjustConfidence soft adds fractional disconfirm", () => {
    const embed = makeEmbed(10);
    const predId = db.createPrediction(store, "skip it", "reason", embed, "m");
    db.adjustConfidence(predId, "soft");
    const pred = db.getPrediction(predId);
    expect(pred!.disconfirm_count).toBeCloseTo(0.25, 5);
    expect(pred!.confidence).toBeLessThan(0.5);
  });

  test("multiple confirms push confidence toward 1", () => {
    const embed = makeEmbed(10);
    const predId = db.createPrediction(store, "skip it", "reason", embed, "m");
    for (let i = 0; i < 25; i++) db.adjustConfidence(predId, "confirm");
    const pred = db.getPrediction(predId);
    expect(pred!.confirm_count).toBe(25);
    expect(pred!.confidence).toBeGreaterThan(0.9);
  });
});

describe("edges and scoring", () => {
  test("createEdge links matcher to prediction and scorePredictions returns scored", () => {
    const matcherEmbed = makeEmbed(1);
    const predEmbed = makeEmbed(2);
    const matcherId = db.createMatcher(store, "PR with tech debt", matcherEmbed, "m");
    const predId = db.createPrediction(store, "skip it", "user prefers skip", predEmbed, "m");
    db.createEdge(matcherId, predId, 1.0);

    const matchers = [{ id: matcherId, description: "PR with tech debt", score: 0.9 }];
    const scored = db.scorePredictions(matchers);
    expect(scored.length).toBe(1);
    expect(scored[0].prediction_id).toBe(predId);
    expect(scored[0].statement).toBe("skip it");
    expect(scored[0].score).toBeCloseTo(0.9 * 1.0 * 0.5, 2);
  });

  test("scorePredictions returns empty for no matchers", () => {
    expect(db.scorePredictions([])).toEqual([]);
  });

  test("multiple matchers reaching the same prediction are deduped by prediction_id", () => {
    const m1 = db.createMatcher(store, "PR review", makeEmbed(1), "m");
    const m2 = db.createMatcher(store, "code review", makeEmbed(2), "m");
    const predId = db.createPrediction(store, "skip tech debt", "reason", makeEmbed(3), "m");
    db.createEdge(m1, predId, 1.0);
    db.createEdge(m2, predId, 0.8);

    const matchers = [
      { id: m1, description: "PR review", score: 0.9 },
      { id: m2, description: "code review", score: 0.8 },
    ];
    const scored = db.scorePredictions(matchers);
    // Both matchers link to the same prediction; dedup keeps only the
    // highest-scoring entry (m1, score 0.9 * 1.0 * 0.5 = 0.45).
    expect(scored.length).toBe(1);
    expect(scored[0].prediction_id).toBe(predId);
    expect(scored[0].matcher_id).toBe(m1);
  });

  test("createEdge does not overwrite existing edge weight", () => {
    const m1 = db.createMatcher(store, "PR review", makeEmbed(1), "m");
    const predId = db.createPrediction(store, "skip", "reason", makeEmbed(2), "m");
    db.createEdge(m1, predId, 0.7);

    // Second call with different weight should NOT overwrite (ON CONFLICT DO NOTHING).
    db.createEdge(m1, predId, 1.0);

    const matchers = [{ id: m1, description: "PR review", score: 0.9 }];
    const scored = db.scorePredictions(matchers);
    expect(scored.length).toBe(1);
    expect(scored[0].score).toBeCloseTo(0.9 * 0.7 * 0.5, 2);
  });
});

describe("findNearestPrediction", () => {
  test("finds prediction in store above threshold", () => {
    const matcherId = db.createMatcher(store, "ctx", makeEmbed(1), "m");
    const predId = db.createPrediction(store, "skip", "reason", makeEmbed(42), "m");
    db.createEdge(matcherId, predId, 1.0);

    const found = db.findNearestPrediction(store, makeEmbed(42), 0.5);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(predId);
  });

  test("returns null when no prediction is above threshold", () => {
    const matcherId = db.createMatcher(store, "ctx", makeEmbed(1), "m");
    const predId = db.createPrediction(store, "skip", "reason", makeEmbed(42), "m");
    db.createEdge(matcherId, predId, 1.0);

    const found = db.findNearestPrediction(store, makeEmbed(999), 0.99);
    expect(found).toBeNull();
  });

  test("finds prediction regardless of which matcher links to it", () => {
    const matcherA = db.createMatcher(store, "context A", makeEmbed(1), "m");
    const predId = db.createPrediction(store, "skip", "reason", makeEmbed(42), "m");
    db.createEdge(matcherA, predId, 1.0);

    // Search without any matcher context: should still find it
    const found = db.findNearestPrediction(store, makeEmbed(42), 0.5);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(predId);
  });
});

describe("provenance", () => {
  test("addProvenance records entries and getProvenance reads them back", () => {
    const predId = db.createPrediction(store, "skip", "reason", makeEmbed(1), "m");
    db.addProvenance(predId, "confirm", "user said yes skip it");
    db.addProvenance(predId, "disconfirm", "user said no fix it");

    const provenance = db.getProvenance(predId);
    expect(provenance.length).toBe(2);
    // Newest first (ordered by rowid DESC, which matches insertion order)
    expect(provenance[0].signal).toBe("disconfirm");
    expect(provenance[0].detail).toBe("user said no fix it");
    expect(provenance[1].signal).toBe("confirm");
    expect(provenance[1].detail).toBe("user said yes skip it");
  });

  test("deletePrediction cascades to edges and provenance", () => {
    const matcherId = db.createMatcher(store, "ctx", makeEmbed(1), "m");
    const predId = db.createPrediction(store, "skip", "reason", makeEmbed(2), "m");
    db.createEdge(matcherId, predId, 1.0);
    db.addProvenance(predId, "confirm", "user said yes");

    const deleted = db.deletePrediction(predId);
    expect(deleted).toBe(true);

    // Prediction is gone
    expect(db.getPrediction(predId)).toBeNull();
    // Provenance is gone (cascade)
    expect(db.getProvenance(predId)).toEqual([]);
    // Prediction is no longer found by scoring
    const matchers = [{ id: matcherId, description: "ctx", score: 0.9 }];
    expect(db.scorePredictions(matchers)).toEqual([]);
  });

  test("deletePrediction returns false for non-existent id", () => {
    expect(db.deletePrediction("nonexistent-id")).toBe(false);
  });
});

describe("listPredictions", () => {
  test("lists predictions with their matchers sorted by confidence", () => {
    const m1 = db.createMatcher(store, "PR review", makeEmbed(1), "m");
    const p1 = db.createPrediction(store, "skip", "reason", makeEmbed(2), "m");
    db.createEdge(m1, p1, 1.0);
    db.adjustConfidence(p1, "confirm");
    db.adjustConfidence(p1, "confirm");

    const p2 = db.createPrediction(store, "fix it", "reason2", makeEmbed(3), "m");
    db.createEdge(m1, p2, 1.0);

    const list = db.listPredictions(store);
    expect(list.length).toBe(2);
    expect(list[0].confidence).toBeGreaterThan(list[1].confidence);
    expect(list[0].statement).toBe("skip");
    expect(list[0].matchers.length).toBe(1);
    expect(list[0].matchers[0].description).toBe("PR review");
  });

  test("empty store returns empty list", () => {
    expect(db.listPredictions(store)).toEqual([]);
  });
});

describe("populationP0", () => {
  test("returns 0.5 with under 20 total evidence", () => {
    const predId = db.createPrediction(store, "skip", "r", makeEmbed(1), "m");
    db.adjustConfidence(predId, "confirm");
    db.adjustConfidence(predId, "confirm");
    expect(db.populationP0(store)).toBe(0.5);
  });

  test("returns population hit rate with sufficient evidence", () => {
    for (let i = 0; i < 15; i++) {
      const predId = db.createPrediction(store, `pred-${i}`, "r", makeEmbed(i + 10), "m");
      db.adjustConfidence(predId, "confirm");
    }
    for (let i = 0; i < 5; i++) {
      const predId = db.createPrediction(store, `dis-${i}`, "r", makeEmbed(i + 100), "m");
      db.adjustConfidence(predId, "disconfirm");
    }
    expect(db.populationP0(store)).toBeCloseTo(15 / 20, 2);
  });
});

describe("adjustConfidence signal edge cases", () => {
  test("adjustConfidence with non-existent prediction ID is a no-op", () => {
    // Should not throw; the UPDATE matches 0 rows.
    db.adjustConfidence("nonexistent-id", "confirm");
  });
});

describe("scorePredictionNudge", () => {
  test("returns PredictionNudgeItem array with threshold filtering", () => {
    const matcherEmbed = makeEmbed(1);
    const predEmbed = makeEmbed(2);
    const matcherId = db.createMatcher(store, "PR review", matcherEmbed, "m");
    const predId = db.createPrediction(store, "skip tech debt", "reason", predEmbed, "m");
    db.createEdge(matcherId, predId, 1.0);

    // Threshold above 1.0 filters out everything
    const highThreshold = db.scorePredictionNudge([store], matcherEmbed, 1.01);
    expect(highThreshold).toEqual([]);

    // Low threshold (0.0) returns the prediction
    const items = db.scorePredictionNudge([store], matcherEmbed, 0.0, 5);
    expect(items.length).toBe(1);
    expect(items[0].statement).toBe("skip tech debt");
    expect(items[0].confidence).toBeCloseTo(0.5, 2);
    expect(items[0].evidence_count).toBe(0);
  });

  test("deduplicates by prediction_id when multiple matchers link to same prediction", () => {
    const m1 = db.createMatcher(store, "PR review", makeEmbed(1), "m");
    const m2 = db.createMatcher(store, "code review", makeEmbed(2), "m");
    const predId = db.createPrediction(store, "skip tech debt", "reason", makeEmbed(3), "m");
    db.createEdge(m1, predId, 1.0);
    db.createEdge(m2, predId, 1.0);

    // Use a query embedding that matches m1 above 0.0 threshold
    const items = db.scorePredictionNudge([store], makeEmbed(1), 0.0, 5);
    expect(items.length).toBe(1);
  });
});
