import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../src/db";
import { MockEmbeddingModel } from "./mocks/embeddings";
import { captureConsoleError } from "./mocks/console-error";
import { search } from "../src/cli/commands/memory";

// Pin for the CLI search surface's cap disclosure: `thatch search` prints
// the same "top N of M scored memories" line the memory_recall tool does
// (stderr, so piping the rows stays clean) and stays silent when the
// corpus fits the limit. Same cap discipline as uc-152's tool-path pins.

describe("thatch search cap disclosure", () => {
  let dir: string;
  let dbPath: string;
  let db: ThatchDB;
  let model: MockEmbeddingModel;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "thatch-cli-search-"));
    dbPath = join(dir, "test.db");
    db = new ThatchDB(dbPath);
    model = new MockEmbeddingModel();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx(): Parameters<typeof search.run>[1] {
    return {
      db,
      dbPath,
      defaultStore: async () => "test-store",
    };
  }

  test("discloses a truncated scan on stderr, silent on a complete set", async () => {
    // Scoped to this test and restored: under --concurrent, a leaked
    // THATCH_MODEL=mock would flip the model factory for test files
    // running in parallel (the concurrency-shaped flake villager's
    // worker's gate caught).
    const originalModel = process.env.THATCH_MODEL;
    process.env.THATCH_MODEL = "mock";
    try {
      const query = "pull request review flow";
      const emb = await model.queryEmbed(query);
      for (let i = 0; i < 13; i++) {
        db.remember("test-store", `recall memory ${i}: pull request review flow`, `c${i}`, emb, "mock");
      }

      const { lines } = await captureConsoleError(() =>
        search.run([query], ctx()),
      );
      expect(lines.join("\n")).toContain("Showing the top 10 of 13 scored memories.");

      // A corpus that fits the limit stays silent (nothing was cut).
      const smallDir = mkdtempSync(join(tmpdir(), "thatch-cli-search-small-"));
      try {
        const smallPath = join(smallDir, "small.db");
        const smallDb = new ThatchDB(smallPath);
        smallDb.remember("test-store", "only memory: pull request review flow", "c", emb, "mock");
        const smallCtx = { db: smallDb, dbPath: smallPath, defaultStore: async () => "test-store" };
        const { lines: smallLines } = await captureConsoleError(() =>
          search.run([query], smallCtx as any),
        );
        expect(smallLines.join("\n")).not.toContain("scored memories");
        smallDb.close();
      } finally {
        rmSync(smallDir, { recursive: true, force: true });
      }
    } finally {
      if (originalModel === undefined) delete process.env.THATCH_MODEL;
      else process.env.THATCH_MODEL = originalModel;
    }
  });
});

