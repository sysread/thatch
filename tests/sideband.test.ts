import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../src/db";
import { MockEmbeddingModel } from "./mocks/embeddings";
import {
  SidebandServer,
  sidebandMatch,
  sidebandPredictions,
  sidebandBehaviors,
  sidebandSocketPath,
} from "../src/sideband";

let dbDir: string;
let dbPath: string;
let db: ThatchDB;
let model: MockEmbeddingModel;
let sockPath: string;
let server: SidebandServer;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-sideband-"));
  dbPath = join(dbDir, "test.db");
  db = new ThatchDB(dbPath);
  model = new MockEmbeddingModel();
  sockPath = sidebandSocketPath(dbPath);
  server = new SidebandServer(sockPath, model, db);
  server.start();
});

afterEach(() => {
  server.stop();
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("sidebandSocketPath", () => {
  test("is deterministic from dbPath", () => {
    const a = sidebandSocketPath("/path/to/thatch.db");
    const b = sidebandSocketPath("/path/to/thatch.db");
    expect(a).toBe(b);
    expect(a).toContain("thatch-");
    expect(a.endsWith(".sock")).toBe(true);
  });

  test("different dbPaths produce different socket paths", () => {
    expect(sidebandSocketPath("/a.db")).not.toBe(sidebandSocketPath("/b.db"));
  });
});

describe("SidebandServer + sidebandMatch", () => {
  test("round-trip: returns matching memories above threshold", async () => {
    db.remember("s", "architecture", "content about architecture", await model.passageEmbed("architecture"), "mock");
    db.remember("s", "cooking", "content about cooking", await model.passageEmbed("cooking"), "mock");

    // MockEmbeddingModel is deterministic — same text produces same vector.
    // Use the same text as the stored memory to guarantee a high score.
    const res = await sidebandMatch(sockPath, "architecture", ["s", "global"], 0.0, 5);
    expect(res).not.toBeNull();
    expect(res!.matches.length).toBeGreaterThanOrEqual(1);
    expect(res!.matches[0].label).toBe("architecture");
    expect(res!.matches[0].score).toBeGreaterThan(0);
    expect(res!.totalAbove).toBeGreaterThanOrEqual(1);
  });

  test("filters out matches below threshold", async () => {
    db.remember("s", "architecture", "content", await model.passageEmbed("architecture"), "mock");
    db.remember("s", "cooking", "content", await model.passageEmbed("cooking"), "mock");

    // Threshold 0.99 — MockEmbeddingModel produces near-orthogonal vectors
    // for different texts, so only exact-match text scores ~1.0.
    const res = await sidebandMatch(sockPath, "architecture", ["s"], 0.99, 5);
    expect(res).not.toBeNull();
    expect(res!.matches.length).toBe(1);
    expect(res!.matches[0].label).toBe("architecture");
  });

  test("returns empty array when no memories exist", async () => {
    const res = await sidebandMatch(sockPath, "anything", ["s"], 0.0, 5);
    expect(res).not.toBeNull();
    expect(res!.matches).toEqual([]);
    expect(res!.totalAbove).toBe(0);
  });

  test("respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      db.remember("s", `entry-${i}`, `content-${i}`, await model.passageEmbed(`entry-${i}`), "mock");
    }
    const res = await sidebandMatch(sockPath, "entry-0", ["s"], 0.0, 3);
    expect(res!.matches.length).toBeLessThanOrEqual(3);
    // totalAbove counts everything above threshold, un-capped by limit.
    expect(res!.totalAbove).toBeGreaterThanOrEqual(3);
  });

  test("searches across multiple stores", async () => {
    db.remember("s", "project-mem", "content", await model.passageEmbed("project-mem"), "mock");
    db.remember("global", "global-mem", "content", await model.passageEmbed("global-mem"), "mock");

    const res = await sidebandMatch(sockPath, "global-mem", ["s", "global"], 0.99, 5);
    expect(res!.matches.some((m) => m.label === "global-mem" && m.store === "global")).toBe(true);
  });
});

describe("SidebandServer + sidebandPredictions", () => {
  test("round-trip: returns matching predictions above threshold", async () => {
    const matcherEmbed = await model.passageEmbed("deciding on test coverage");
    const predEmbed = await model.passageEmbed("aim for 90 percent coverage");
    db.createMatcher("s", "deciding on test coverage", matcherEmbed, "mock");
    const predId = db.createPrediction("s", "aim for 90 percent coverage", "user stated", predEmbed, "mock");
    db.createEdge(db.findMatchers(["s"], matcherEmbed)[0].id, predId, 1.0);

    const predictions = await sidebandPredictions(sockPath, "deciding on test coverage", ["s", "global"], 0.0, 5);
    expect(predictions).not.toBeNull();
    expect(predictions!.items.length).toBeGreaterThanOrEqual(1);
    expect(predictions!.items[0].statement).toBe("aim for 90 percent coverage");
    expect(predictions!.items[0].matcher_description).toBe("deciding on test coverage");
    expect(predictions!.itemsTotal).toBeGreaterThanOrEqual(1);
    expect(predictions!.matchersFired).toBeGreaterThanOrEqual(1);
  });

  test("returns empty array when no matchers match", async () => {
    const predictions = await sidebandPredictions(sockPath, "unrelated context", ["s"], 0.0, 5);
    expect(predictions).not.toBeNull();
    expect(predictions!.items).toEqual([]);
  });

  test("old-shape server (no stats fields) substitutes shown length, suppressing disclosure", async () => {
    // Version skew: an old server (from before the stats fields) answers
    // ok:true with the items only. The client substitutes the shown length
    // for each missing stat, so the renderer's itemsTotal > items.length
    // check comes out false and no disclosure line is fabricated.
    server.stop();
    const { createServer } = await import("node:net");
    const oldShape = JSON.stringify({
      ok: true,
      predictions: [{ confidence: 0.5, evidence_count: 0, matcher_description: "m", statement: "s" }],
    });
    const oldServer = createServer((socket) => {
      socket.on("data", () => socket.write(oldShape + "\n"));
    });
    oldServer.listen(sockPath);

    try {
      const predictions = await sidebandPredictions(sockPath, "anything", ["s"], 0.0, 5);
      expect(predictions).not.toBeNull();
      expect(predictions!.items.length).toBe(1);
      expect(predictions!.matchersFired).toBe(1);
      expect(predictions!.itemsTotal).toBe(1);
    } finally {
      oldServer.close();
    }
    // Restore the real server for the remaining tests.
    server.start();
  });

  test("returns null when server is not running", async () => {
    server.stop();
    const predictions = await sidebandPredictions(sockPath, "test", ["s"], 0.0, 5);
    expect(predictions).toBeNull();
  });
});

describe("SidebandServer + sidebandBehaviors", () => {
  test("round-trip: returns matching behaviors above threshold", async () => {
    const matcherEmbed = await model.passageEmbed("about to commit changes");
    const behaviorEmbed = await model.passageEmbed("run mise run check before committing");
    db.createBehaviorMatcher("s", "about to commit changes", matcherEmbed, "mock");
    const behaviorId = db.createBehavior("s", "run mise run check before committing", "quality gate", behaviorEmbed, "mock");
    db.createBehaviorEdge(db.findBehaviorMatchers(["s"], matcherEmbed)[0].id, behaviorId, 1.0);

    const behaviors = await sidebandBehaviors(sockPath, "about to commit changes", ["s", "global"], 0.0, 5);
    expect(behaviors).not.toBeNull();
    expect(behaviors!.items.length).toBeGreaterThanOrEqual(1);
    expect(behaviors!.items[0].statement).toBe("run mise run check before committing");
    expect(behaviors!.items[0].matcher_description).toBe("about to commit changes");
    expect(behaviors!.itemsTotal).toBeGreaterThanOrEqual(1);
    expect(behaviors!.matchersFired).toBeGreaterThanOrEqual(1);
  });

  test("returns empty array when no matchers match", async () => {
    const behaviors = await sidebandBehaviors(sockPath, "unrelated context", ["s"], 0.0, 5);
    expect(behaviors).not.toBeNull();
    expect(behaviors!.items).toEqual([]);
  });

  test("returns null when server is not running", async () => {
    server.stop();
    const behaviors = await sidebandBehaviors(sockPath, "test", ["s"], 0.0, 5);
    expect(behaviors).toBeNull();
  });
});

describe("sidebandMatch failure modes", () => {
  test("returns null when server is not running", async () => {
    server.stop();
    const matches = await sidebandMatch(sockPath, "test", ["s"], 0.0, 5);
    expect(matches).toBeNull();
  });

  test("returns null on timeout", async () => {
    // Start a server that never responds — we'll create a raw listener that
    // accepts the connection but doesn't write back.
    server.stop();
    const { createServer } = await import("node:net");
    const slowServer = createServer(() => {
      // Accept but don't respond — let the client time out.
    });
    slowServer.listen(sockPath);

    const matches = await sidebandMatch(sockPath, "test", ["s"], 0.0, 5, 100);
    expect(matches).toBeNull();

    slowServer.close();
  });

  test("cleans up stale socket file on connection error", async () => {
    // Stop the real server, leave the socket file in place.
    const { existsSync } = await import("node:fs");
    server.stop();
    // sideband stop() already removed the socket. Create a fake stale file.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sockPath, "stale");

    const matches = await sidebandMatch(sockPath, "test", ["s"], 0.0, 5);
    expect(matches).toBeNull();
    // The stale file should have been cleaned up by the error handler.
    expect(existsSync(sockPath)).toBe(false);
  });
});

describe("SidebandServer path and stop", () => {
  test("path getter returns the socket path", () => {
    expect(server.path).toBe(sockPath);
  });

  test("stop is safe to call twice (catch for already-removed socket)", () => {
    server.stop();
    // Second call hits the catch block — socket file already gone.
    server.stop();
    // Re-create for afterEach cleanup.
    server = new SidebandServer(sockPath, model, db);
    server.start();
  });
});
