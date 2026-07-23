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
  test("exports all 13 tools", () => {
    expect(TOOL_DEFS.length).toBe(13);
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
      "prediction_query",
      "prediction_update",
      "prediction_list",
      "prediction_delete",
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

// ---------------------------------------------------------------------------
// Prediction tool execute functions
// ---------------------------------------------------------------------------

describe("prediction tool execute functions", () => {
  const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

  test("prediction_update create seeds at p0 with 0 evidence", async () => {
    const result = await findTool("prediction_update").execute({
      matcher: "reviewing a PR with tech debt",
      prediction: "flag tech debt before reviewing the diff",
      signal: "create",
      rationale: "user asked to surface debt early",
    }, ctx);
    expect(result).toContain("[created]");
    expect(result).toContain("reviewing a PR with tech debt");

    // prediction_list should show it at p0 with 0 evidence
    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("[0.50 conf, 0 tests]");
  });

  test("prediction_update confirm applies signal immediately on new prediction", async () => {
    const result = await findTool("prediction_update").execute({
      matcher: "writing error handling",
      prediction: "handle errors before happy paths",
      signal: "confirm",
      rationale: "user confirmed this preference",
    }, ctx);
    expect(result).toContain("[created + confirm]");
    // confidence = (1 + 5*0.5) / (1 + 0 + 5) = 0.583
    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("[0.58 conf, 1 tests]");
  });

  test("prediction_update disconfirm on existing prediction lowers confidence", async () => {
    // Create + confirm first
    const created = await findTool("prediction_update").execute({
      matcher: "writing tests",
      prediction: "always write tests first",
      signal: "confirm",
      rationale: "user likes TDD",
    }, ctx);
    expect(created).toContain("(1/0)"); // 1 confirm, 0 disconfirm

    // Now disconfirm with same matcher text (dedup finds it)
    const result = await findTool("prediction_update").execute({
      matcher: "writing tests",
      prediction: "always write tests first",
      signal: "disconfirm",
      rationale: "user said not always",
    }, ctx);
    expect(result).toContain("[disconfirm]");
    expect(result).toContain("(1/1)"); // 1 confirm, 1 disconfirm
  });

  test("prediction_update create on existing prediction links without disconfirming", async () => {
    // Create a prediction with confirm
    const confirmed = await findTool("prediction_update").execute({
      matcher: "choosing variable names",
      prediction: "prefer descriptive names over short ones",
      signal: "confirm",
      rationale: "user prefers clarity",
    }, ctx);
    expect(confirmed).toContain("(1/0)"); // 1 confirm, 0 disconfirm

    // Call with signal=create and a DIFFERENT matcher that links to the same prediction
    const result = await findTool("prediction_update").execute({
      matcher: "choosing variable names in a function",
      prediction: "prefer descriptive names over short ones",
      signal: "create",
      rationale: "observed again in a new context",
    }, ctx);
    // Should link the new matcher, not disconfirm
    expect(result).toContain("[linked]");
    // Confidence should NOT have changed: still 1 confirm, 0 disconfirm
    expect(result).toContain("(1/0)");

    // prediction_list should show two matchers linked to the same prediction
    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("choosing variable names");
    expect(list).toContain("choosing variable names in a function");
    // Provenance should have confirm + create, NOT disconfirm
    expect(list).toContain("confirm:");
    expect(list).toContain("create:");
    expect(list).not.toContain("disconfirm:");
  });

  test("prediction_query returns matching predictions with 0-evidence verb", async () => {
    await findTool("prediction_update").execute({
      matcher: "deciding on test coverage",
      prediction: "aim for 90 percent coverage",
      signal: "create",
      rationale: "user stated preference",
    }, ctx);

    // Query with the same matcher text (MockEmbeddingModel: identical text → cosine 1.0)
    const result = await findTool("prediction_query").execute({
      context: "deciding on test coverage",
    }, ctx);
    expect(result).toContain("you may prefer"); // 0-evidence verb
    expect(result).toContain("aim for 90 percent coverage");
  });

  test("prediction_query returns no predictions for unrelated context", async () => {
    await findTool("prediction_update").execute({
      matcher: "database indexing strategy",
      prediction: "use composite indexes",
      signal: "create",
      rationale: "user said",
    }, ctx);

    const result = await findTool("prediction_query").execute({
      context: "designing a UI layout",
    }, ctx);
    expect(result).toContain("No matching predictions");
  });

  test("prediction_delete removes a prediction", async () => {
    await findTool("prediction_update").execute({
      matcher: "choosing a framework",
      prediction: "prefer minimal dependencies",
      signal: "create",
      rationale: "user said",
    }, ctx);

    const result = await findTool("prediction_delete").execute({
      statement: "prefer minimal dependencies",
    }, ctx);
    expect(result).toContain("[deleted]");

    // prediction_list should be empty now
    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("No predictions");
  });

  test("prediction_delete returns not-found for unknown statement", async () => {
    const result = await findTool("prediction_delete").execute({
      statement: "this prediction does not exist at all",
    }, ctx);
    expect(result).toContain("No prediction matching");
  });

  test("prediction_list includes provenance entries", async () => {
    await findTool("prediction_update").execute({
      matcher: "reviewing code",
      prediction: "check for null references",
      signal: "confirm",
      rationale: "user emphasized null safety",
    }, ctx);

    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("provenance:");
    expect(list).toContain("confirm:");
    expect(list).toContain("null safety");
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
