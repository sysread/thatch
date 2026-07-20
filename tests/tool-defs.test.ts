import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ThatchDB } from "../src/db";
import { MockEmbeddingModel } from "../src/embeddings";
import { TOOL_DEFS, type CoreContext } from "../src/tool-defs";

let dbPath: string;
let dbDir: string;
let db: ThatchDB;
let model: MockEmbeddingModel;
let ctx: CoreContext;
const defaultStore = "test-owner/test-repo";

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-mcp-test-"));
  dbPath = join(dbDir, "test.db");
  db = new ThatchDB(dbPath);
  model = new MockEmbeddingModel();
  ctx = { db, model, defaultStore };
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("TOOL_DEFS", () => {
  test("exports all 9 tools", () => {
    expect(TOOL_DEFS.length).toBe(9);
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names).toEqual([
      "memory_remember",
      "memory_recall",
      "memory_list",
      "memory_show",
      "memory_forget",
      "store_list",
      "find_duplicates",
      "dedup_mark_checked",
      "extraction_done",
    ]);
  });

  test("each tool has name, description, args, and execute", () => {
    for (const def of TOOL_DEFS) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(10);
      expect(typeof def.args).toBe("object");
      expect(typeof def.execute).toBe("function");
    }
  });

  test("zod schemas convert to valid JSON Schema via z.toJSONSchema()", () => {
    for (const def of TOOL_DEFS) {
      const schema = z.object(def.args);
      const json = z.toJSONSchema(schema) as any;
      expect(json.type).toBe("object");
      expect(json.properties).toBeDefined();
    }
  });
});

describe("tool-defs execute functions", () => {
  test("memory_remember saves and returns confirmation", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute({ label: "Test", content: "Content" }, ctx);
    expect(result).toContain("[saved]");
    expect(result).toContain("Test");
  });

  test("memory_recall returns matches", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const recall = TOOL_DEFS.find((t) => t.name === "memory_recall")!;
    await remember.execute({ label: "Alpha", content: "Alpha content" }, ctx);
    const result = await recall.execute({ query: "Alpha" }, ctx);
    expect(result).not.toBe("No matching memories found.");
  });

  test("store_list includes global", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "store_list")!;
    const result = await def.execute({}, ctx);
    expect(result).toContain("global");
  });

  test("find_duplicates returns no candidates for clean store", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "find_duplicates")!;
    const result = await def.execute({ threshold: 0.9 }, ctx);
    expect(result).toContain("No duplicate candidates");
  });

  test("memory_remember returns error updating archived entry without archived param", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    await remember.execute({ label: "ArchTest", content: "Orig", archived: true }, ctx);
    const result = await remember.execute({
      label: "ArchTest", content: "Updated", overwrite: true,
    }, ctx);
    expect(result).toContain("archived");
  });

  test("memory_remember retains archived status when updating", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    await remember.execute({ label: "ArchTest", content: "Orig", archived: true }, ctx);
    await remember.execute({
      label: "ArchTest", content: "Updated", overwrite: true, archived: true,
    }, ctx);
    const show = TOOL_DEFS.find((t) => t.name === "memory_show")!;
    const entry = await show.execute({ label: "ArchTest" }, ctx);
    expect(entry).toContain("archived:true");
  });

  test("memory_recall excludes archived by default", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const recall = TOOL_DEFS.find((t) => t.name === "memory_recall")!;
    await remember.execute({ label: "Active", content: "Active content" }, ctx);
    await remember.execute({ label: "Archived", content: "Archived content", archived: true }, ctx);
    const result = await recall.execute({ query: "content" }, ctx);
    expect(result).toContain("Active");
    expect(result).not.toContain("Archived");
  });

  test("memory_recall includeArchived surfaces archived", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const recall = TOOL_DEFS.find((t) => t.name === "memory_recall")!;
    await remember.execute({ label: "Active", content: "Active content" }, ctx);
    await remember.execute({ label: "Archived", content: "Archived content", archived: true }, ctx);
    const result = await recall.execute({ query: "content", includeArchived: true }, ctx);
    expect(result).toContain("Archived");
  });

  test("memory_list shows archived status", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const list = TOOL_DEFS.find((t) => t.name === "memory_list")!;
    await remember.execute({ label: "Normal", content: "Content" }, ctx);
    await remember.execute({ label: "Old", content: "Old", archived: true }, ctx);
    const result = await list.execute({}, ctx);
    expect(result).not.toContain("Normal (archived)");
    expect(result).toContain("Old (archived)");
  });
});

describe("tool-defs validation", () => {
  test("memory_remember requires label", () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const schema = z.object(def.args);
    expect(() => schema.parse({ content: "test" })).toThrow();
  });

  test("memory_remember requires content", () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const schema = z.object(def.args);
    expect(() => schema.parse({ label: "test" })).toThrow();
  });

  test("confidence must be 1-10", () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const schema = z.object(def.args);
    expect(() => schema.parse({ label: "t", content: "c", confidence: 0 })).toThrow();
    expect(() => schema.parse({ label: "t", content: "c", confidence: 11 })).toThrow();
    expect(() => schema.parse({ label: "t", content: "c", confidence: 5 })).not.toThrow();
  });

  test("store_list accepts empty args", () => {
    const def = TOOL_DEFS.find((t) => t.name === "store_list")!;
    const schema = z.object(def.args);
    expect(() => schema.parse({})).not.toThrow();
  });
});
