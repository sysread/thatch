import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../src/db";
import { MockEmbeddingModel } from "../src/embeddings";
import {
  SidebandServer,
  sidebandMatch,
  sidebandSocketPath,
  type SidebandMatch,
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
    const matches = await sidebandMatch(sockPath, "architecture", ["s", "global"], 0.0, 5);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(1);
    expect(matches![0].label).toBe("architecture");
    expect(matches![0].score).toBeGreaterThan(0);
  });

  test("filters out matches below threshold", async () => {
    db.remember("s", "architecture", "content", await model.passageEmbed("architecture"), "mock");
    db.remember("s", "cooking", "content", await model.passageEmbed("cooking"), "mock");

    // Threshold 0.99 — MockEmbeddingModel produces near-orthogonal vectors
    // for different texts, so only exact-match text scores ~1.0.
    const matches = await sidebandMatch(sockPath, "architecture", ["s"], 0.99, 5);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
    expect(matches![0].label).toBe("architecture");
  });

  test("returns empty array when no memories exist", async () => {
    const matches = await sidebandMatch(sockPath, "anything", ["s"], 0.0, 5);
    expect(matches).not.toBeNull();
    expect(matches).toEqual([]);
  });

  test("respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      db.remember("s", `entry-${i}`, `content-${i}`, await model.passageEmbed(`entry-${i}`), "mock");
    }
    const matches = await sidebandMatch(sockPath, "entry-0", ["s"], 0.0, 3);
    expect(matches!.length).toBeLessThanOrEqual(3);
  });

  test("searches across multiple stores", async () => {
    db.remember("s", "project-mem", "content", await model.passageEmbed("project-mem"), "mock");
    db.remember("global", "global-mem", "content", await model.passageEmbed("global-mem"), "mock");

    const matches = await sidebandMatch(sockPath, "global-mem", ["s", "global"], 0.99, 5);
    expect(matches!.some((m) => m.label === "global-mem" && m.store === "global")).toBe(true);
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
    const slowServer = createServer((socket) => {
      // Accept but don't respond — let the client time out.
    });
    slowServer.listen(sockPath);

    const matches = await sidebandMatch(sockPath, "test", ["s"], 0.0, 5, 100);
    expect(matches).toBeNull();

    slowServer.close();
  });

  test("cleans up stale socket file on connection error", async () => {
    // Stop the real server, leave the socket file in place.
    const { unlinkSync, existsSync } = await import("node:fs");
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
