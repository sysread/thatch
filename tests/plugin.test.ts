import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../src/index";

let hooks: Awaited<ReturnType<typeof server>>;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-plugin-test-"));
  process.env.THATCH_DB_PATH = join(dbDir, "test.db");
  hooks = await server();
});

afterAll(() => {
  hooks.dispose?.();
  rmSync(dbDir, { recursive: true, force: true });
  delete process.env.THATCH_DB_PATH;
});

describe("plugin entry", () => {
  test("exports a server function", () => {
    expect(typeof server).toBe("function");
  });

  test("returns hooks with all expected tools", () => {
    expect(hooks.tool).toBeDefined();
    const names = Object.keys(hooks.tool);
    expect(names.sort()).toEqual([
      "thatch_memory_forget",
      "thatch_memory_list",
      "thatch_memory_recall",
      "thatch_memory_remember",
      "thatch_memory_show",
      "thatch_store_list",
    ]);
  });

  test("each tool has description and execute", () => {
    for (const [name, t] of Object.entries(hooks.tool)) {
      expect(t.description, `${name} missing description`).toBeTruthy();
      expect(typeof t.description).toBe("string");
      expect(typeof t.execute, `${name} missing execute`).toBe("function");
    }
  });

  test("each tool has args schema", () => {
    for (const [name, t] of Object.entries(hooks.tool)) {
      expect(t.args, `${name} missing args`).toBeDefined();
    }
  });

  test("dispose hook is defined", () => {
    expect(typeof hooks.dispose).toBe("function");
  });
});
