import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB, cosineSimilarity } from "../src/db";

let dbPath: string;
let dbDir: string;
let db: ThatchDB;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-test-"));
  dbPath = join(dbDir, "test.db");
  db = new ThatchDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  test("identical vectors score 1", () => {
    const a = new Float32Array([1, 2, 3]);
    const score = cosineSimilarity(a, a);
    expect(score).toBeCloseTo(1, 5);
  });

  test("orthogonal vectors score 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    const score = cosineSimilarity(a, b);
    expect(score).toBeCloseTo(0, 5);
  });

  test("opposite vectors score -1", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    const score = cosineSimilarity(a, b);
    expect(score).toBeCloseTo(-1, 5);
  });

  test("zero vector returns 0", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([1, 0]);
    const score = cosineSimilarity(a, b);
    expect(score).toBe(0);
  });

  test("normalized vectors within [0, 1]", () => {
    const a = new Float32Array([0.6, 0.8]);
    const b = new Float32Array([0.8, 0.6]);
    const score = cosineSimilarity(a, b);
    expect(score).toBeCloseTo(0.96, 2);
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("schema", () => {
  test("creates stores and entries tables", () => {
    const rows = db.listStores();
    // global is seeded automatically
    expect(rows).toContain("global");
    expect(rows.length).toBe(1);
  });

  test("global store exists at init", () => {
    const stores = db.listStores();
    expect(stores).toEqual(["global"]);
  });
});

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

describe("stores", () => {
  test("listStores returns all stores", () => {
    db.ensureStore("foo");
    db.ensureStore("bar");
    const stores = db.listStores();
    expect(stores).toContain("global");
    expect(stores).toContain("foo");
    expect(stores).toContain("bar");
  });

  test("ensureStore is idempotent", () => {
    db.ensureStore("foo");
    db.ensureStore("foo");
    const stores = db.listStores();
    expect(stores.filter((s) => s === "foo").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    expect(db.slugify("Hello World")).toBe("hello-world");
  });

  test("strips special characters", () => {
    expect(db.slugify("foo:bar!@#baz")).toBe("foobarbaz");
  });

  test("preserves hyphens and underscores", () => {
    expect(db.slugify("my_memory-name")).toBe("my_memory-name");
  });

  test("collapses multiple hyphens", () => {
    expect(db.slugify("a   b")).toBe("a-b");
  });

  test("trims whitespace", () => {
    expect(db.slugify("  hello  ")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// remember
// ---------------------------------------------------------------------------

describe("remember", () => {
  const emb = new Float32Array(4).fill(0.1);

  test("writes a new entry and auto-creates the store", () => {
    const result = db.remember("my-project", "Test Label", "# Test Label\n\nSome content", emb, "test-model");
    expect(result.ok).toBe(true);

    const stores = db.listStores();
    expect(stores).toContain("my-project");
  });

  test("rejects duplicate label without overwrite", () => {
    db.remember("s", "label", "content", emb, "m");
    const result = db.remember("s", "label", "content 2", emb, "m");
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("already exists");
  });

  test("overwrites when overwrite: true", () => {
    db.remember("s", "label", "original", emb, "m");
    const result = db.remember("s", "label", "updated", emb, "m", { overwrite: true });
    expect(result.ok).toBe(true);

    const entry = db.showEntry("s", "label");
    expect(entry?.content).toBe("updated");
  });

  test("stores branch and confidence metadata", () => {
    db.remember("s", "branch-test", "content", emb, "m", {
      branch: "feature/x",
      confidence: 7,
    });

    const entry = db.showEntry("s", "branch-test");
    expect(entry?.branch).toBe("feature/x");
    expect(entry?.confidence).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

describe("recall", () => {
  test("ranks results by cosine similarity", () => {
    // Seed entries with distinct embeddings
    const embA = new Float32Array([1, 0, 0, 0]);
    const embB = new Float32Array([0, 1, 0, 0]);
    const embC = new Float32Array([0.7071, 0.7071, 0, 0]);

    db.remember("store", "A", "first", embA, "m");
    db.remember("store", "B", "second", embB, "m");
    db.remember("store", "C", "third", embC, "m");

    // Query close to A
    const query = new Float32Array([1, 0, 0, 0]);
    const results = db.recall(["store"], query);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].label).toBe("A");
  });

  test("searches across multiple stores", () => {
    const emb = new Float32Array(4).fill(0.25);
    db.remember("s1", "a", "content a", emb, "m");
    db.remember("s2", "b", "content b", emb, "m");

    const results = db.recall(["s1", "s2"], emb);
    expect(results.length).toBe(2);
    const stores = results.map((r) => r.store).sort();
    expect(stores).toEqual(["s1", "s2"]);
  });

  test("returns empty for unknown store", () => {
    const results = db.recall(["nonexistent"], new Float32Array(4));
    expect(results).toEqual([]);
  });

  test("respects limit", () => {
    const emb = new Float32Array(4).fill(0.25);
    for (let i = 0; i < 5; i++) {
      db.remember("s", `entry-${i}`, `content ${i}`, emb, "m");
    }
    const results = db.recall(["s"], emb, { limit: 2 });
    expect(results.length).toBe(2);
  });

  test("branch filter includes project-wide and branch-specific", () => {
    const emb = new Float32Array(4).fill(0.25);
    db.remember("s", "global-entry", "global", emb, "m"); // branch = null
    db.remember("s", "branch-entry", "branch", emb, "m", { branch: "main" });
    db.remember("s", "other-entry", "other", emb, "m", { branch: "feature/x" });

    const results = db.recall(["s"], emb, { branch: "main" });
    const labels = results.map((r) => r.label).sort();
    expect(labels).toContain("global-entry");
    expect(labels).toContain("branch-entry");
    expect(labels).not.toContain("other-entry");
  });
});

// ---------------------------------------------------------------------------
// listEntries
// ---------------------------------------------------------------------------

describe("listEntries", () => {
  test("returns metadata for all entries in a store", () => {
    const emb = new Float32Array(4);
    db.remember("s", "alpha", "content", emb, "m");
    db.remember("s", "beta", "content", emb, "m", { branch: "dev", confidence: 5 });

    const entries = db.listEntries("s");
    expect(entries.length).toBe(2);
    expect(entries[0].label).toBe("alpha");
    expect(entries[1].label).toBe("beta");
    expect(entries[1].branch).toBe("dev");
    expect(entries[1].confidence).toBe(5);
  });

  test("empty store returns empty array", () => {
    const entries = db.listEntries("nonexistent");
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// showEntry
// ---------------------------------------------------------------------------

describe("showEntry", () => {
  test("returns full entry by label", () => {
    const emb = new Float32Array(4).fill(0.5);
    db.remember("s", "memory", "# memory\n\nThe content", emb, "m");

    const entry = db.showEntry("s", "memory");
    expect(entry).not.toBeNull();
    expect(entry!.label).toBe("memory");
    expect(entry!.content).toContain("The content");
    expect(entry!.created_at).toBeTruthy();
    expect(entry!.updated_at).toBeTruthy();
  });

  test("returns null for unknown label", () => {
    const entry = db.showEntry("s", "nope");
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// forgetEntry
// ---------------------------------------------------------------------------

describe("forgetEntry", () => {
  test("deletes an existing entry", () => {
    const emb = new Float32Array(4);
    db.remember("s", "remove-me", "content", emb, "m");
    expect(db.entryExists("s", db.slugify("remove-me"))).toBe(true);

    const result = db.forgetEntry("s", "remove-me");
    expect(result).toBe(true);
    expect(db.entryExists("s", db.slugify("remove-me"))).toBe(false);
  });

  test("returns false for unknown label", () => {
    const result = db.forgetEntry("s", "nope");
    expect(result).toBe(false);
  });
});
