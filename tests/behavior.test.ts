import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../src/db";
import { MockEmbeddingModel } from "./mocks/embeddings";
import { seedDefaultBehaviors } from "../src/seed-behaviors";

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
  dbDir = mkdtempSync(join(tmpdir(), "thatch-behavior-test-"));
  dbPath = join(dbDir, "test.db");
  db = new ThatchDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("behavior engine schema", () => {
  test("tables exist after init", () => {
    const behaviors = db.listBehaviors(store);
    expect(behaviors).toEqual([]);
  });
});

describe("behavior matcher creation and lookup", () => {
  test("createBehaviorMatcher returns an id and findBehaviorMatchers finds it", () => {
    const embed = makeEmbed(42);
    const id = db.createBehaviorMatcher(store, "reviewing a PR for rename detection", embed, "test-model");
    expect(id).toBeTruthy();

    const found = db.findBehaviorMatchers([store], embed, { limit: 5 });
    expect(found.length).toBe(1);
    expect(found[0].id).toBe(id);
    expect(found[0].description).toBe("reviewing a PR for rename detection");
    expect(found[0].score).toBeCloseTo(1, 3);
  });

  test("findNearestBehaviorMatcher returns the closest above threshold", () => {
    const embed1 = makeEmbed(1);
    const embed2 = makeEmbed(2);
    db.createBehaviorMatcher(store, "situation A", embed1, "test-model");
    db.createBehaviorMatcher(store, "situation B", embed2, "test-model");

    const nearest = db.findNearestBehaviorMatcher(store, embed1, 0.5);
    expect(nearest).not.toBeNull();
    expect(nearest!.description).toBe("situation A");
  });

  test("findNearestBehaviorMatcher returns null below threshold", () => {
    const embed1 = makeEmbed(1);
    const embed2 = makeEmbed(999);
    db.createBehaviorMatcher(store, "situation A", embed1, "test-model");

    const nearest = db.findNearestBehaviorMatcher(store, embed2, 0.99);
    expect(nearest).toBeNull();
  });
});

describe("behavior creation and confidence", () => {
  test("createBehavior seeds confidence at p0", () => {
    const embed = makeEmbed(10);
    const id = db.createBehavior(store, "check the whole codebase for a library before importing it", "reason", embed, "m");
    const behavior = db.getBehavior(id);
    expect(behavior).not.toBeNull();
    expect(behavior!.confidence).toBeCloseTo(0.5, 5);
    expect(behavior!.confirm_count).toBe(0);
    expect(behavior!.disconfirm_count).toBe(0);
  });

  test("adjustBehaviorConfidence confirm increases confidence (ham)", () => {
    const embed = makeEmbed(10);
    const id = db.createBehavior(store, "read the full function before editing", "reason", embed, "m");
    db.adjustBehaviorConfidence(id, "confirm");
    const behavior = db.getBehavior(id);
    expect(behavior!.confirm_count).toBe(1);
    expect(behavior!.confidence).toBeGreaterThan(0.5);
  });

  test("adjustBehaviorConfidence disconfirm decreases confidence (spam)", () => {
    const embed = makeEmbed(10);
    const id = db.createBehavior(store, "read the full function before editing", "reason", embed, "m");
    db.adjustBehaviorConfidence(id, "disconfirm");
    const behavior = db.getBehavior(id);
    expect(behavior!.disconfirm_count).toBe(1);
    expect(behavior!.confidence).toBeLessThan(0.5);
  });

  test("adjustBehaviorConfidence soft adds fractional disconfirm", () => {
    const embed = makeEmbed(10);
    const id = db.createBehavior(store, "check for disabled tests", "reason", embed, "m");
    db.adjustBehaviorConfidence(id, "soft");
    const behavior = db.getBehavior(id);
    expect(behavior!.disconfirm_count).toBeCloseTo(0.25, 5);
    expect(behavior!.confidence).toBeLessThan(0.5);
  });

  test("multiple confirms push confidence toward 1", () => {
    const embed = makeEmbed(10);
    const id = db.createBehavior(store, "investigate before touching", "reason", embed, "m");
    for (let i = 0; i < 25; i++) db.adjustBehaviorConfidence(id, "confirm");
    const behavior = db.getBehavior(id);
    expect(behavior!.confirm_count).toBe(25);
    expect(behavior!.confidence).toBeGreaterThan(0.9);
  });
});

describe("behavior edges and scoring", () => {
  test("createBehaviorEdge links matcher to behavior and scoreBehaviors returns scored", () => {
    const matcherEmbed = makeEmbed(1);
    const behaviorEmbed = makeEmbed(2);
    const matcherId = db.createBehaviorMatcher(store, "editing a large function", matcherEmbed, "m");
    const behaviorId = db.createBehavior(store, "read the whole function first", "discipline rule", behaviorEmbed, "m");
    db.createBehaviorEdge(matcherId, behaviorId, 1.0);

    const matchers = [{ id: matcherId, description: "editing a large function", score: 0.9 }];
    const scored = db.scoreBehaviors(matchers);
    expect(scored.length).toBe(1);
    expect(scored[0].behavior_id).toBe(behaviorId);
    expect(scored[0].statement).toBe("read the whole function first");
    expect(scored[0].score).toBeCloseTo(0.9 * 1.0 * 0.5, 2);
  });

  test("scoreBehaviors returns empty for no matchers", () => {
    expect(db.scoreBehaviors([])).toEqual([]);
  });

  test("multiple matchers reaching the same behavior are deduped by behavior_id", () => {
    const m1 = db.createBehaviorMatcher(store, "editing a large function", makeEmbed(1), "m");
    const m2 = db.createBehaviorMatcher(store, "refactoring code", makeEmbed(2), "m");
    const behaviorId = db.createBehavior(store, "read the whole function first", "reason", makeEmbed(3), "m");
    db.createBehaviorEdge(m1, behaviorId, 1.0);
    db.createBehaviorEdge(m2, behaviorId, 0.8);

    const matchers = [
      { id: m1, description: "editing a large function", score: 0.9 },
      { id: m2, description: "refactoring code", score: 0.8 },
    ];
    const scored = db.scoreBehaviors(matchers);
    expect(scored.length).toBe(1);
    expect(scored[0].behavior_id).toBe(behaviorId);
    expect(scored[0].matcher_id).toBe(m1);
  });

  test("createBehaviorEdge does not overwrite existing edge weight", () => {
    const m1 = db.createBehaviorMatcher(store, "editing", makeEmbed(1), "m");
    const behaviorId = db.createBehavior(store, "read first", "reason", makeEmbed(2), "m");
    db.createBehaviorEdge(m1, behaviorId, 0.7);

    db.createBehaviorEdge(m1, behaviorId, 1.0);

    const matchers = [{ id: m1, description: "editing", score: 0.9 }];
    const scored = db.scoreBehaviors(matchers);
    expect(scored.length).toBe(1);
    expect(scored[0].score).toBeCloseTo(0.9 * 0.7 * 0.5, 2);
  });
});

describe("findNearestBehavior", () => {
  test("finds behavior in store above threshold", () => {
    const matcherId = db.createBehaviorMatcher(store, "ctx", makeEmbed(1), "m");
    const behaviorId = db.createBehavior(store, "do the right thing", "reason", makeEmbed(42), "m");
    db.createBehaviorEdge(matcherId, behaviorId, 1.0);

    const found = db.findNearestBehavior(store, makeEmbed(42), 0.5);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(behaviorId);
  });

  test("returns null when no behavior is above threshold", () => {
    db.createBehavior(store, "do the right thing", "reason", makeEmbed(42), "m");
    const found = db.findNearestBehavior(store, makeEmbed(999), 0.99);
    expect(found).toBeNull();
  });
});

describe("behavior provenance", () => {
  test("addBehaviorProvenance records entries and getBehaviorProvenance reads them back", () => {
    const behaviorId = db.createBehavior(store, "check for disabled tests", "reason", makeEmbed(1), "m");
    db.addBehaviorProvenance(behaviorId, "confirm", "ham: relevant to this PR review");
    db.addBehaviorProvenance(behaviorId, "disconfirm", "spam: not relevant to this task");

    const provenance = db.getBehaviorProvenance(behaviorId);
    expect(provenance.length).toBe(2);
    expect(provenance[0].signal).toBe("disconfirm");
    expect(provenance[0].detail).toBe("spam: not relevant to this task");
    expect(provenance[1].signal).toBe("confirm");
    expect(provenance[1].detail).toBe("ham: relevant to this PR review");
  });

  test("deleteBehavior cascades to edges and provenance", () => {
    const matcherId = db.createBehaviorMatcher(store, "ctx", makeEmbed(1), "m");
    const behaviorId = db.createBehavior(store, "check library before importing", "reason", makeEmbed(2), "m");
    db.createBehaviorEdge(matcherId, behaviorId, 1.0);
    db.addBehaviorProvenance(behaviorId, "confirm", "ham");

    const deleted = db.deleteBehavior(behaviorId);
    expect(deleted).toBe(true);

    expect(db.getBehavior(behaviorId)).toBeNull();
    expect(db.getBehaviorProvenance(behaviorId)).toEqual([]);
    const matchers = [{ id: matcherId, description: "ctx", score: 0.9 }];
    expect(db.scoreBehaviors(matchers)).toEqual([]);
  });

  test("deleteBehavior returns false for non-existent id", () => {
    expect(db.deleteBehavior("nonexistent-id")).toBe(false);
  });
});

describe("listBehaviors", () => {
  test("lists behaviors with their matchers sorted by confidence", () => {
    const m1 = db.createBehaviorMatcher(store, "editing a large function", makeEmbed(1), "m");
    const b1 = db.createBehavior(store, "read the whole function first", "reason", makeEmbed(2), "m");
    db.createBehaviorEdge(m1, b1, 1.0);
    db.adjustBehaviorConfidence(b1, "confirm");
    db.adjustBehaviorConfidence(b1, "confirm");

    const b2 = db.createBehavior(store, "check for disabled tests", "reason2", makeEmbed(3), "m");
    db.createBehaviorEdge(m1, b2, 1.0);

    const list = db.listBehaviors(store);
    expect(list.length).toBe(2);
    expect(list[0].confidence).toBeGreaterThan(list[1].confidence);
    expect(list[0].statement).toBe("read the whole function first");
    expect(list[0].matchers.length).toBe(1);
    expect(list[0].matchers[0].description).toBe("editing a large function");
  });

  test("empty store returns empty list", () => {
    expect(db.listBehaviors(store)).toEqual([]);
  });
});

describe("scoreBehaviorNudge", () => {
  test("returns BehaviorNudgeItem array with threshold filtering", () => {
    const matcherEmbed = makeEmbed(1);
    const behaviorEmbed = makeEmbed(2);
    const matcherId = db.createBehaviorMatcher(store, "editing a large function", matcherEmbed, "m");
    const behaviorId = db.createBehavior(store, "read the whole function first", "reason", behaviorEmbed, "m");
    db.createBehaviorEdge(matcherId, behaviorId, 1.0);

    const highThreshold = db.scoreBehaviorNudge([store], matcherEmbed, 1.01);
    expect(highThreshold).toEqual([]);

    const items = db.scoreBehaviorNudge([store], matcherEmbed, 0.0, 5);
    expect(items.length).toBe(1);
    expect(items[0].statement).toBe("read the whole function first");
    expect(items[0].confidence).toBeCloseTo(0.5, 2);
    expect(items[0].evidence_count).toBe(0);
  });

  test("deduplicates by behavior_id when multiple matchers link to same behavior", () => {
    const m1 = db.createBehaviorMatcher(store, "editing a large function", makeEmbed(1), "m");
    const m2 = db.createBehaviorMatcher(store, "refactoring code", makeEmbed(2), "m");
    const behaviorId = db.createBehavior(store, "read the whole function first", "reason", makeEmbed(3), "m");
    db.createBehaviorEdge(m1, behaviorId, 1.0);
    db.createBehaviorEdge(m2, behaviorId, 1.0);

    const items = db.scoreBehaviorNudge([store], makeEmbed(1), 0.0, 5);
    expect(items.length).toBe(1);
  });
});

describe("seedDefaultBehaviors", () => {
  let seedDb: ThatchDB;
  let seedDir: string;
  let seedModel: MockEmbeddingModel;

  beforeEach(() => {
    seedDir = mkdtempSync(join(tmpdir(), "thatch-seed-"));
    seedDb = new ThatchDB(join(seedDir, "test.db"));
    seedModel = new MockEmbeddingModel();
  });

  afterEach(() => {
    seedDb.close();
    rmSync(seedDir, { recursive: true, force: true });
  });

  test("seeds default behaviors into global store on first run", async () => {
    await seedDefaultBehaviors(seedDb, seedModel);

    const behaviors = seedDb.listBehaviors("global");
    expect(behaviors.length).toBe(9);
    const wrapUp = behaviors.find((b) => b.statement.includes("loose ends"));
    expect(wrapUp).toBeDefined();
    expect(wrapUp!.matchers.length).toBe(1);
    expect(wrapUp!.matchers[0].description).toContain("wrapping up");
    const finalize = behaviors.find((b) => b.matchers.some((m) => m.description.includes("committing")));
    expect(finalize).toBeDefined();
    expect(finalize!.matchers[0].description).toContain("committing");
    const research = behaviors.find((b) => b.matchers.some((m) => m.description.includes("new project")));
    expect(research).toBeDefined();
    const snag = behaviors.find((b) => b.matchers.some((m) => m.description.includes("dead end")));
    expect(snag).toBeDefined();
    const debugArch = behaviors.find((b) => b.matchers.some((m) => m.description.includes("debugging")));
    expect(debugArch).toBeDefined();
    const planArch = behaviors.find((b) => b.matchers.some((m) => m.description.includes("planning a change")));
    expect(planArch).toBeDefined();
  });

  test("is idempotent: second call does not duplicate", async () => {
    await seedDefaultBehaviors(seedDb, seedModel);
    await seedDefaultBehaviors(seedDb, seedModel);

    const behaviors = seedDb.listBehaviors("global");
    expect(behaviors.length).toBe(9);
  });

  test("does not seed into project store", async () => {
    await seedDefaultBehaviors(seedDb, seedModel);

    expect(seedDb.listBehaviors(store).length).toBe(0);
  });

  test("stamps rationale with seed-version tag", async () => {
    await seedDefaultBehaviors(seedDb, seedModel);

    const behaviors = seedDb.listBehaviors("global");
    for (const b of behaviors) {
      expect(b.rationale).toContain("seed-version:");
    }
  });

  test("replaces outdated behavior on version mismatch", async () => {
    // Seed with current version
    await seedDefaultBehaviors(seedDb, seedModel);
    const before = seedDb.listBehaviors("global");
    expect(before.length).toBe(9);

    // Simulate an old version: find one behavior, delete it, and recreate
    // with the same key stamp but an old version stamp.
    const target = before[0];
    const oldKey = target.rationale?.match(/seed-key:([^\s]+)/)?.[1];
    expect(oldKey).toBeDefined();

    seedDb.deleteBehavior(target.id);

    const oldBehaviorEmbed = await seedModel.passageEmbed(target.statement);
    const sitEmbed = await seedModel.passageEmbed(target.matchers[0].description);
    const matcherId = seedDb.findNearestBehaviorMatcher("global", sitEmbed, 0.85)!.id;
    const behaviorId = seedDb.createBehavior(
      "global",
      target.statement,
      `old rationale seed-key:${oldKey} seed-version:0.0.1`,
      oldBehaviorEmbed,
      seedModel.name,
    );
    seedDb.createBehaviorEdge(matcherId, behaviorId, 1.0);

    // Re-seed: should find the behavior by key, detect version mismatch, replace
    await seedDefaultBehaviors(seedDb, seedModel);

    const after = seedDb.listBehaviors("global");
    expect(after.length).toBe(9);
    // The replaced behavior should have the current version stamp
    const replaced = after.find((b) =>
      b.matchers.some((m) => m.description === target.matchers[0].description),
    );
    expect(replaced).toBeDefined();
    expect(replaced!.rationale).toContain(`seed-key:${oldKey}`);
    expect(replaced!.rationale).toContain("seed-version:");
  });

  test("does not overwrite user-codified behaviors", async () => {
    // Seed with current version
    await seedDefaultBehaviors(seedDb, seedModel);
    expect(seedDb.listBehaviors("global").length).toBe(9);

    // User codifies a behavior without any seed-key stamp
    const sitEmbed = await seedModel.passageEmbed("when working on documentation");
    const behaviorEmbed = await seedModel.passageEmbed("check the docs build before committing");
    const matcherId = seedDb.createBehaviorMatcher("global", "when working on documentation", sitEmbed, seedModel.name);
    const behaviorId = seedDb.createBehavior(
      "global",
      "check the docs build before committing",
      "user-defined rationale with no seed stamps",
      behaviorEmbed,
      seedModel.name,
    );
    seedDb.createBehaviorEdge(matcherId, behaviorId, 1.0);

    // Re-seed: should NOT touch the user-codified behavior
    await seedDefaultBehaviors(seedDb, seedModel);

    const after = seedDb.listBehaviors("global");
    expect(after.length).toBe(10); // 9 seeded + 1 user-codified
    const userBehavior = after.find((b) => b.rationale === "user-defined rationale with no seed stamps");
    expect(userBehavior).toBeDefined();
  });
});
