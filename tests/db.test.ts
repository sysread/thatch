import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
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

  test("throws on dimension mismatch", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow("dimension mismatch");
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

  test("preserves non-ASCII letters so distinct labels get distinct slugs", () => {
    const a = db.slugify("日本語のメモ");
    const b = db.slugify("Кириллица");
    expect(a).not.toBe("");
    expect(b).not.toBe("");
    expect(a).not.toBe(b);
  });

  test("all-symbol labels fall back to a non-empty hash slug", () => {
    const a = db.slugify("!!!");
    const b = db.slugify("???");
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
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

  test("round-trips an embedding that is a view into a larger buffer", () => {
    // Simulates transformers.js returning a tensor view: the Float32Array
    // starts at a non-zero byteOffset inside a larger ArrayBuffer.
    const backing = new Float32Array([9, 9, 0.1, 0.2, 0.3, 0.4, 9, 9]);
    const view = backing.subarray(2, 6);
    db.remember("s", "view-test", "content", view, "m");

    const results = db.recall(["s"], new Float32Array([0.1, 0.2, 0.3, 0.4]));
    expect(results.length).toBe(1);
    expect(results[0]._score).toBeCloseTo(1, 5);
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

  test("returns empty for empty store list", () => {
    const results = db.recall([], new Float32Array(4));
    expect(results).toEqual([]);
  });

  test("skips entries embedded with a different dimensionality", () => {
    db.remember("s", "old-model", "content", new Float32Array([1, 0, 0, 0]), "old");
    db.remember("s", "new-model", "content", new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), "new");

    const results = db.recall(["s"], new Float32Array([1, 0, 0, 0]));
    expect(results.map((r) => r.label)).toEqual(["old-model"]);
    expect(results.every((r) => Number.isFinite(r._score))).toBe(true);
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

// ---------------------------------------------------------------------------
// deduplication
// ---------------------------------------------------------------------------

describe("dedup", () => {
  const embA = new Float32Array([1, 0, 0, 0]);
  const embB = new Float32Array([0.999, 0.04, 0, 0]);
  const embC = new Float32Array([0, 1, 0, 0]);

  test("findDuplicates surfaces similar pairs above threshold", () => {
    db.remember("s", "first", "content a", embA, "m");
    db.remember("s", "second", "content b", embB, "m");
    db.remember("s", "unrelated", "content c", embC, "m");

    const pairs = db.findDuplicates("s", 0.85);
    expect(pairs.length).toBe(1);
    const labels = [pairs[0].labelA, pairs[0].labelB].sort();
    expect(labels).toEqual(["first", "second"]);
  });

  test("checked pairs are not re-reported", () => {
    db.remember("s", "first", "content a", embA, "m");
    db.remember("s", "second", "content b", embB, "m");

    db.markPairChecked("s", db.slugify("first"), db.slugify("second"), "unrelated");
    expect(db.findDuplicates("s", 0.85)).toEqual([]);
  });

  test("overwriting an entry clears its checked-pair verdicts", () => {
    db.remember("s", "first", "content a", embA, "m");
    db.remember("s", "second", "content b", embB, "m");
    db.markPairChecked("s", db.slugify("first"), db.slugify("second"), "unrelated");

    db.remember("s", "first", "new content", embA, "m", { overwrite: true });
    expect(db.findDuplicates("s", 0.85).length).toBe(1);
  });

  test("pairs with mismatched embedding dimensions are skipped", () => {
    db.remember("s", "small", "content", new Float32Array([1, 0]), "m");
    db.remember("s", "large", "content", new Float32Array([1, 0, 0, 0]), "m");
    expect(db.findDuplicates("s", 0.1)).toEqual([]);
  });

  test("forgetting an entry clears its dedup pairs", () => {
    db.remember("s", "first", "content a", embA, "m");
    db.remember("s", "second", "content b", embB, "m");
    db.markPairChecked("s", db.slugify("first"), db.slugify("second"), "duplicate");

    db.forgetEntry("s", "second");
    db.remember("s", "second", "content b again", embB, "m");
    expect(db.findDuplicates("s", 0.85).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// findSimilar (write-time collision check)
// ---------------------------------------------------------------------------

describe("findSimilar", () => {
  const embA = new Float32Array([1, 0, 0, 0]);
  const embNear = new Float32Array([0.999, 0.04, 0, 0]);
  const embFar = new Float32Array([0, 1, 0, 0]);

  test("returns entries above the threshold, ranked by score", () => {
    db.remember("s", "near", "content", embA, "m");
    db.remember("s", "far", "content", embFar, "m");

    const hits = db.findSimilar("s", embNear);
    expect(hits.length).toBe(1);
    expect(hits[0].label).toBe("near");
    expect(hits[0].score).toBeGreaterThanOrEqual(0.85);
  });

  test("excludes the given slug (the entry being overwritten)", () => {
    db.remember("s", "self", "content", embA, "m");
    const hits = db.findSimilar("s", embA, { excludeSlug: db.slugify("self") });
    expect(hits).toEqual([]);
  });

  test("skips dimension-mismatched entries", () => {
    db.remember("s", "other-space", "content", new Float32Array(8).fill(0.5), "m");
    expect(db.findSimilar("s", embA)).toEqual([]);
  });

  test("records no recall telemetry", () => {
    db.remember("s", "quiet", "content", embA, "m");
    db.findSimilar("s", embA);
    expect(db.showEntry("s", "quiet")?.recall_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recall telemetry
// ---------------------------------------------------------------------------

describe("recall telemetry", () => {
  test("recall stamps returned rows and only returned rows", () => {
    const embA = new Float32Array([1, 0, 0, 0]);
    const embB = new Float32Array([0.9, 0.1, 0, 0]);
    const embC = new Float32Array([0, 0, 1, 0]);
    db.remember("s", "hit-1", "content", embA, "m");
    db.remember("s", "hit-2", "content", embB, "m");
    db.remember("s", "miss", "content", embC, "m");

    db.recall(["s"], embA, { limit: 2 });

    expect(db.showEntry("s", "hit-1")?.recall_count).toBe(1);
    expect(db.showEntry("s", "hit-2")?.recall_count).toBe(1);
    expect(db.showEntry("s", "hit-1")?.last_recalled_at).toBeTruthy();
    expect(db.showEntry("s", "miss")?.recall_count).toBe(0);
    expect(db.showEntry("s", "miss")?.last_recalled_at).toBeNull();

    db.recall(["s"], embA, { limit: 1 });
    expect(db.showEntry("s", "hit-1")?.recall_count).toBe(2);
    expect(db.showEntry("s", "hit-2")?.recall_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// hygiene queries
// ---------------------------------------------------------------------------

describe("hygiene", () => {
  const emb = new Float32Array([1, 0, 0, 0]);
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  test("staleEntryCount counts entries neither updated nor recalled since cutoff", () => {
    db.remember("s", "old", "content", emb, "m");
    expect(db.staleEntryCount("s", future)).toBe(1);
    expect(db.staleEntryCount("s", past)).toBe(0);
  });

  test("a recall refreshes an otherwise-stale entry", () => {
    db.remember("s", "used", "content", emb, "m");

    // Backdate the write far past the cutoff, so only recall telemetry can
    // keep the entry out of the stale count.
    const raw = new Database(dbPath);
    raw.run("UPDATE entries SET updated_at = '2000-01-01T00:00:00Z' WHERE slug = 'used'");
    raw.close();

    expect(db.staleEntryCount("s", past)).toBe(1);
    db.recall(["s"], emb);
    expect(db.staleEntryCount("s", past)).toBe(0);
  });

  test("branchesInStore lists distinct scoped branches", () => {
    db.remember("s", "a", "content", emb, "m", { branch: "feature/x" });
    db.remember("s", "b", "content", emb, "m", { branch: "feature/x" });
    db.remember("s", "c", "content", emb, "m", { branch: "feature/y" });
    db.remember("s", "d", "content", emb, "m");
    expect(db.branchesInStore("s")).toEqual(["feature/x", "feature/y"]);
  });

  test("entryCountForBranches counts scoped entries; empty branch list is zero", () => {
    db.remember("s", "a", "content", emb, "m", { branch: "feature/x" });
    db.remember("s", "b", "content", emb, "m", { branch: "feature/x" });
    db.remember("s", "c", "content", emb, "m", { branch: "feature/y" });
    expect(db.entryCountForBranches("s", ["feature/x"])).toBe(2);
    expect(db.entryCountForBranches("s", [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// schema migration
// ---------------------------------------------------------------------------

describe("migration", () => {
  test("opening a pre-telemetry database adds the new columns", () => {
    const oldPath = join(dbDir, "old.db");
    const raw = new Database(oldPath, { create: true });
    raw.run(`
      CREATE TABLE entries (
        slug TEXT NOT NULL, store TEXT NOT NULL, label TEXT NOT NULL,
        content TEXT NOT NULL, embedding BLOB, model TEXT, branch TEXT,
        confidence INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (slug, store)
      )
    `);
    raw.run("INSERT INTO entries (slug, store, label, content) VALUES ('a', 's', 'A', 'old content')");
    raw.close();

    const migrated = new ThatchDB(oldPath);
    const entry = migrated.showEntry("s", "A");
    expect(entry).not.toBeNull();
    expect(entry!.recall_count).toBe(0);
    expect(entry!.last_recalled_at).toBeNull();
    migrated.close();
  });
});
