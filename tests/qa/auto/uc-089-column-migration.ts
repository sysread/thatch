import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase } from "../runner";
import { ThatchDB } from "../../../src/db";

/**
 * UC-089: Column migration.
 *
 * Automatable: creates a DB with the pre-migration entries schema (no
 * recall_count, last_recalled_at, or archived columns), inserts a row,
 * then opens it with ThatchDB to trigger the migration. Verifies the
 * new columns exist with correct defaults and pre-existing data survives.
 */

const useCase: UseCase = {
  name: "UC-089-column-migration",
  preconditions: [
    "- A SQLite database file with the original entries schema (no recall_count, last_recalled_at, or archived columns)",
    "- The ThatchDB constructor available",
  ].join("\n"),
  steps: [
    "1. Create a temp directory and a SQLite file with the pre-migration entries schema.",
    "2. Insert at least one row into the old schema.",
    "3. Open the database via ThatchDB (triggers migration).",
    "4. Query PRAGMA table_info(entries) and verify all three new columns exist.",
    "5. Verify the pre-existing row is intact with default values.",
    "6. Close and re-open the same database.",
    "7. Verify PRAGMA table_info(entries) still shows the columns (no duplicate ALTER TABLE).",
  ].join("\n"),
  expected: [
    "- recall_count column exists after opening, with NOT NULL DEFAULT 0.",
    "- last_recalled_at column exists after opening, nullable.",
    "- archived column exists after opening, with NOT NULL DEFAULT 0.",
    "- Pre-existing rows are preserved with default values (recall_count = 0, last_recalled_at = NULL, archived = 0).",
    "- Re-opening does not re-run the migration (idempotent).",
  ].join("\n"),

  async run() {
    const tmpDir = mkdtempSync(join(tmpdir(), "thatch-uc-089-"));
    const dbPath = join(tmpDir, "thatch.db");

    // Step 1: create pre-migration schema
    const raw = new Database(dbPath, { create: true });
    raw.run("CREATE TABLE stores (name TEXT PRIMARY KEY)");
    raw.run("INSERT INTO stores (name) VALUES ('global')");
    raw.run(`
      CREATE TABLE entries (
        slug      TEXT NOT NULL,
        store     TEXT NOT NULL REFERENCES stores(name),
        label     TEXT NOT NULL,
        content   TEXT NOT NULL,
        embedding BLOB,
        model     TEXT,
        branch    TEXT,
        confidence INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (slug, store)
      )
    `);

    // Step 2: insert a row into the old schema
    const oldEmb = new Uint8Array(384 * 4);
    raw.run(
      "INSERT INTO entries (slug, store, label, content, embedding, model, branch, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["test-slug", "global", "test-label", "test content", oldEmb, "mock", null, null, "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"],
    );

    // Verify the old schema does NOT have the new columns
    const oldCols = (raw.query("PRAGMA table_info(entries)").all() as any[]).map((r) => r.name);
    if (oldCols.includes("recall_count")) {
      console.log("  FAIL: recall_count should not exist in pre-migration schema");
      return "FAIL";
    }
    if (oldCols.includes("archived")) {
      console.log("  FAIL: archived should not exist in pre-migration schema");
      return "FAIL";
    }
    raw.close();

    // Step 3: open with ThatchDB — triggers migration
    const db = new ThatchDB(dbPath);
    const raw2 = new Database(dbPath, { readonly: true });

    try {
      // Step 4: verify new columns exist
      const cols = (raw2.query("PRAGMA table_info(entries)").all() as any[]);
      const colMap = new Map(cols.map((c) => [c.name, c]));

      const recallCount = colMap.get("recall_count");
      if (!recallCount) {
        console.log("  FAIL: recall_count column not found after migration");
        return "FAIL";
      }
      if (!recallCount.notnull) {
        console.log("  FAIL: recall_count should be NOT NULL");
        return "FAIL";
      }
      if (recallCount.dflt_value !== "0") {
        console.log(`  FAIL: recall_count default should be 0, got ${recallCount.dflt_value}`);
        return "FAIL";
      }

      const lastRecalled = colMap.get("last_recalled_at");
      if (!lastRecalled) {
        console.log("  FAIL: last_recalled_at column not found after migration");
        return "FAIL";
      }
      if (lastRecalled.notnull) {
        console.log("  FAIL: last_recalled_at should be nullable");
        return "FAIL";
      }

      const archived = colMap.get("archived");
      if (!archived) {
        console.log("  FAIL: archived column not found after migration");
        return "FAIL";
      }
      if (!archived.notnull) {
        console.log("  FAIL: archived should be NOT NULL");
        return "FAIL";
      }
      if (archived.dflt_value !== "0") {
        console.log(`  FAIL: archived default should be 0, got ${archived.dflt_value}`);
        return "FAIL";
      }

      // Step 5: verify pre-existing row is intact with defaults
      const row = raw2.query("SELECT label, content, recall_count, last_recalled_at, archived FROM entries WHERE slug = ?").get("test-slug") as any;
      if (!row) {
        console.log("  FAIL: pre-existing row not found after migration");
        return "FAIL";
      }
      if (row.label !== "test-label") {
        console.log(`  FAIL: pre-existing row label changed: ${row.label}`);
        return "FAIL";
      }
      if (row.recall_count !== 0) {
        console.log(`  FAIL: pre-existing row recall_count should be 0, got ${row.recall_count}`);
        return "FAIL";
      }
      if (row.last_recalled_at !== null) {
        console.log(`  FAIL: pre-existing row last_recalled_at should be NULL, got ${row.last_recalled_at}`);
        return "FAIL";
      }
      if (row.archived !== 0) {
        console.log(`  FAIL: pre-existing row archived should be 0, got ${row.archived}`);
        return "FAIL";
      }

      db.close();
      raw2.close();

      // Step 6-7: re-open — idempotent
      const db3 = new ThatchDB(dbPath);
      const raw3 = new Database(dbPath, { readonly: true });
      const cols3 = (raw3.query("PRAGMA table_info(entries)").all() as any[]).map((r) => r.name);
      if (!cols3.includes("recall_count") || !cols3.includes("last_recalled_at") || !cols3.includes("archived")) {
        console.log("  FAIL: columns missing after re-open");
        return "FAIL";
      }
      // Verify no duplicate columns (ALTER TABLE would fail on re-run, but
      // the PRAGMA check prevents it — just verify column count is correct)
      const expectedColCount = oldCols.length + 3;
      if (cols3.length !== expectedColCount) {
        console.log(`  FAIL: expected ${expectedColCount} columns after re-open, got ${cols3.length}`);
        return "FAIL";
      }
      db3.close();
      raw3.close();
    } finally {
      try { db.close(); } catch {}
      try { raw2.close(); } catch {}
    }

    return "PASS";
  },
};

registerUseCase(useCase);
