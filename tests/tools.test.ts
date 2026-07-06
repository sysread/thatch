import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../src/db";
import { MockEmbeddingModel } from "../src/embeddings";
import {
  createRememberTool,
  createRecallTool,
  createListTool,
  createShowTool,
  createForgetTool,
  createListStoresTool,
  createFindDuplicatesTool,
  createMarkCheckedTool,
} from "../src/tools";

let dbPath: string;
let dbDir: string;
let db: ThatchDB;
let model: MockEmbeddingModel;
const defaultStore = "test-owner/test-repo";

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-tool-test-"));
  dbPath = join(dbDir, "test.db");
  db = new ThatchDB(dbPath);
  model = new MockEmbeddingModel();
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// thatch_memory_remember
// ---------------------------------------------------------------------------

describe("thatch_memory_remember", () => {
  test("saves a memory and returns confirmation", async () => {
    const tool = createRememberTool(db, model, defaultStore);
    const result = await tool.execute({
      label: "My Memory",
      content: "Some content to remember",
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("[saved]");
    expect(result).toContain(defaultStore);
    expect(result).toContain("My Memory");
  });

  test("warns when content resembles an existing memory", async () => {
    // The mock model hashes the full content including the label heading, so
    // "same body, different label" embeds orthogonally. Seed the existing
    // entry with the exact vector the new save will produce, which is what
    // a real model yields for near-identical content.
    const newContent = "# Different Label\n\nThe staging DB lives on host-7";
    db.remember(defaultStore, "Original", "The staging DB lives on host-7",
      await model.passageEmbed(newContent), model.name);

    const tool = createRememberTool(db, model, defaultStore);
    const result = await tool.execute({
      label: "Different Label",
      content: "The staging DB lives on host-7",
    });

    expect(result).toContain("[saved]");
    expect(result).toContain("semantically similar");
    expect(result).toContain('"Original"');
    expect(result).toContain("thatch_dedup_mark_checked");
  });

  test("does not warn for unrelated content", async () => {
    const tool = createRememberTool(db, model, defaultStore);
    await tool.execute({ label: "One", content: "The staging DB lives on host-7" });
    const result = await tool.execute({ label: "Two", content: "Cats enjoy cardboard boxes" });

    expect(result).toContain("[saved]");
    expect(result).not.toContain("semantically similar");
  });

  test("does not warn against itself on overwrite", async () => {
    const tool = createRememberTool(db, model, defaultStore);
    await tool.execute({ label: "Self", content: "Same content" });
    const result = await tool.execute({ label: "Self", content: "Same content", overwrite: true });

    expect(result).toContain("[saved]");
    expect(result).not.toContain("semantically similar");
  });

  test("rejects duplicate label", async () => {
    const tool = createRememberTool(db, model, defaultStore);

    await tool.execute({ label: "Dup", content: "First" });
    const result = await tool.execute({ label: "Dup", content: "Second" });

    expect(typeof result).toBe("string");
    expect(result).toContain("already exists");
  });

  test("overwrites when overwrite: true", async () => {
    const tool = createRememberTool(db, model, defaultStore);

    await tool.execute({ label: "Over", content: "Original" });
    const result = await tool.execute({ label: "Over", content: "Updated", overwrite: true });

    expect(typeof result).toBe("string");
    expect(result).toContain("[saved]");

    const entry = db.showEntry(defaultStore, "Over");
    expect(entry?.content).toContain("Updated");
  });

  test("uses explicit store argument", async () => {
    const tool = createRememberTool(db, model, defaultStore);
    const result = await tool.execute({
      label: "Custom Store Entry",
      content: "Content",
      store: "other/other-repo",
    });

    expect(result).toContain("other/other-repo");

    const entry = db.showEntry("other/other-repo", "Custom Store Entry");
    expect(entry).not.toBeNull();
  });

  test("stores branch and confidence metadata", async () => {
    const tool = createRememberTool(db, model, defaultStore);
    await tool.execute({
      label: "Branch Test",
      content: "Content",
      branch: "feature/x",
      confidence: 9,
    });

    const entry = db.showEntry(defaultStore, "Branch Test");
    expect(entry?.branch).toBe("feature/x");
    expect(entry?.confidence).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// thatch_memory_recall
// ---------------------------------------------------------------------------

describe("thatch_memory_recall", () => {
  test("searches repo + global by default", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const recall = createRecallTool(db, model, defaultStore);

    await remember.execute({ label: "Repo Memory", content: "In repo store", store: defaultStore });
    await remember.execute({ label: "Global Memory", content: "In global store", store: "global" });

    const result = await recall.execute({ query: "something" });
    expect(typeof result).toBe("string");
    expect(result).not.toBe("No matching memories found.");
  });

  test("returns empty result message for no matches", async () => {
    const recall = createRecallTool(db, model, defaultStore);
    // Don't seed any memories in "empty-store"
    const result = await recall.execute({ query: "nothing", store: "empty-store" });
    expect(result).toBe("No matching memories found.");
  });

  test("respects store override", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const recall = createRecallTool(db, model, defaultStore);

    await remember.execute({ label: "Only Here", content: "Only in this store", store: "isolated" });

    const result = await recall.execute({ query: "Only Here", store: "isolated" });
    expect(result).toContain("Only Here");
  });

  test("respects limit parameter", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const recall = createRecallTool(db, model, defaultStore);

    for (let i = 0; i < 5; i++) {
      await remember.execute({ label: `Entry ${i}`, content: `Content ${i}` });
    }

    // limit 1 should return at most 1 result separator
    const result = await recall.execute({ query: "Entry", limit: 1 });
    const separator = "-----";
    // Should have at most 1 result (0 separators) or be the empty message
    if (result !== "No matching memories found.") {
      const parts = result.split(separator);
      expect(parts.length).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// thatch_memory_list
// ---------------------------------------------------------------------------

describe("thatch_memory_list", () => {
  test("lists entries in a store", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const list = createListTool(db, defaultStore);

    await remember.execute({ label: "Alpha", content: "A" });
    await remember.execute({ label: "Beta", content: "B" });

    const result = await list.execute({});
    expect(typeof result).toBe("string");
    expect(result).toContain("Alpha");
    expect(result).toContain("Beta");
  });

  test("empty store returns message", async () => {
    const list = createListTool(db, defaultStore);
    const result = await list.execute({});
    expect(result).toContain("No memories");
  });

  test("respects store argument", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const list = createListTool(db, defaultStore);

    await remember.execute({ label: "Other", content: "C", store: "other" });

    const result = await list.execute({ store: "other" });
    expect(result).toContain("Other");
  });
});

// ---------------------------------------------------------------------------
// thatch_memory_show
// ---------------------------------------------------------------------------

describe("thatch_memory_show", () => {
  test("shows full content of a memory", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const show = createShowTool(db, defaultStore);

    await remember.execute({ label: "Show Me", content: "Detailed content here" });

    const result = await show.execute({ label: "Show Me" });
    expect(typeof result).toBe("string");
    expect(result).toContain("Detailed content here");
    expect(result).toContain(defaultStore);
  });

  test("returns not-found message for unknown label", async () => {
    const show = createShowTool(db, defaultStore);
    const result = await show.execute({ label: "Nope" });
    expect(result).toContain("No memory");
    expect(result).toContain("Nope");
  });

  test("respects store argument", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const show = createShowTool(db, defaultStore);

    await remember.execute({ label: "Cross Store", content: "Content", store: "other" });

    const result = await show.execute({ label: "Cross Store", store: "other" });
    expect(result).toContain("Content");
  });
});

// ---------------------------------------------------------------------------
// thatch_memory_forget
// ---------------------------------------------------------------------------

describe("thatch_memory_forget", () => {
  test("deletes an existing memory", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const forget = createForgetTool(db, defaultStore);

    await remember.execute({ label: "Delete Me", content: "Temp" });
    const result = await forget.execute({ label: "Delete Me" });

    expect(result).toContain("[forgotten]");
    expect(result).toContain("Delete Me");

    const entry = db.showEntry(defaultStore, "Delete Me");
    expect(entry).toBeNull();
  });

  test("returns not-found for unknown label", async () => {
    const forget = createForgetTool(db, defaultStore);
    const result = await forget.execute({ label: "Ghost" });
    expect(result).toContain("No memory");
  });
});

// ---------------------------------------------------------------------------
// thatch_store_list
// ---------------------------------------------------------------------------

describe("thatch_store_list", () => {
  test("lists stores including global", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const listStores = createListStoresTool(db);

    await remember.execute({ label: "Trigger", content: "Creates store" });

    const result = await listStores.execute({});
    expect(result).toContain("global");
    expect(result).toContain(defaultStore);
  });
});

// ---------------------------------------------------------------------------
// thatch_find_duplicates
// ---------------------------------------------------------------------------

describe("thatch_find_duplicates", () => {
  test("surfaces similar pairs above threshold", async () => {
    // Use DB directly to control embeddings (mock model produces different
    // vectors for different texts, even with similar content)
    const emb = new Float32Array(384).fill(0.5);
    db.remember(defaultStore, "Alpha", "# Alpha\n\nContent", emb, "mock");
    db.remember(defaultStore, "Beta", "# Beta\n\nContent", emb, "mock");

    const findDups = createFindDuplicatesTool(db, defaultStore);
    const result = await findDups.execute({ threshold: 0.9 });

    expect(typeof result).toBe("string");
    expect(result).toContain("Alpha");
    expect(result).toContain("Beta");
    expect(result).toContain("score:");
  });

  test("groups related pairs into one cluster", async () => {
    const emb = new Float32Array(384).fill(0.5);
    const other = new Float32Array(384).fill(-0.5).map((v, i) => (i % 2 === 0 ? 0.5 : -0.5));
    db.remember(defaultStore, "Frag A", "# Frag A\n\nSame", emb, "mock");
    db.remember(defaultStore, "Frag B", "# Frag B\n\nSame", emb, "mock");
    db.remember(defaultStore, "Frag C", "# Frag C\n\nSame", emb, "mock");
    db.remember(defaultStore, "Loner X", "# Loner X\n\nOther", new Float32Array(other), "mock");
    db.remember(defaultStore, "Loner Y", "# Loner Y\n\nOther", new Float32Array(other), "mock");

    const findDups = createFindDuplicatesTool(db, defaultStore);
    const result = await findDups.execute({ threshold: 0.9 });

    // Three mutually-similar fragments = one cluster of 3 (three pairs);
    // the two loners form a separate cluster of 2.
    expect(result).toContain("Cluster of 3:");
    expect(result).toContain("Cluster of 2:");
    expect((result as string).match(/Cluster of /g)?.length).toBe(2);
  });

  test("returns message when no duplicates found", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const findDups = createFindDuplicatesTool(db, defaultStore);

    await remember.execute({ label: "Unique One", content: "Completely different" });
    await remember.execute({ label: "Unique Two", content: "Nothing alike at all xyz" });

    const result = await findDups.execute({ threshold: 0.9 });
    expect(result).toContain("No duplicate candidates");
  });

  test("respects store argument", async () => {
    const emb = new Float32Array(384).fill(0.5);
    db.remember("isolated", "Iso A", "# Iso A\n\nSame", emb, "mock");
    db.remember("isolated", "Iso B", "# Iso B\n\nSame", emb, "mock");

    const findDups = createFindDuplicatesTool(db, defaultStore);
    const result = await findDups.execute({ store: "isolated", threshold: 0.9 });

    expect(result).toContain("Iso A");
    expect(result).toContain("Iso B");
  });

  test("skips checked pairs", async () => {
    const emb = new Float32Array(384).fill(0.5);
    db.remember(defaultStore, "Pair A", "# Pair A\n\nSame", emb, "mock");
    db.remember(defaultStore, "Pair B", "# Pair B\n\nSame", emb, "mock");

    const findDups = createFindDuplicatesTool(db, defaultStore);
    const markChecked = createMarkCheckedTool(db, defaultStore);

    // Mark as checked
    await markChecked.execute({ label_a: "Pair A", label_b: "Pair B", status: "unrelated" });

    // Should not surface the pair
    const result = await findDups.execute({ threshold: 0.9 });
    expect(result).toContain("No duplicate candidates");
  });
});

// ---------------------------------------------------------------------------
// thatch_dedup_mark_checked
// ---------------------------------------------------------------------------

describe("thatch_dedup_mark_checked", () => {
  test("records verdict and returns confirmation", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const markChecked = createMarkCheckedTool(db, defaultStore);

    await remember.execute({ label: "Mem X", content: "Content" });
    await remember.execute({ label: "Mem Y", content: "Content" });

    const result = await markChecked.execute({
      label_a: "Mem X",
      label_b: "Mem Y",
      status: "duplicate",
    });

    expect(result).toContain("[checked]");
    expect(result).toContain("Mem X");
    expect(result).toContain("Mem Y");
    expect(result).toContain("duplicate");
  });

  test("respects store argument", async () => {
    const remember = createRememberTool(db, model, defaultStore);
    const markChecked = createMarkCheckedTool(db, defaultStore);

    await remember.execute({ label: "Store A", content: "X", store: "other-store" });
    await remember.execute({ label: "Store B", content: "X", store: "other-store" });

    const result = await markChecked.execute({
      label_a: "Store A",
      label_b: "Store B",
      status: "supplement",
      store: "other-store",
    });

    expect(result).toContain("other-store");
  });
});
