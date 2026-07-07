import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  test("exports all 8 tools", () => {
    expect(TOOL_DEFS.length).toBe(8);
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
