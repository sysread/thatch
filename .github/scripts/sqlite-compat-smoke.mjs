// The node floor leg's compat smoke (node-sqlite plan, D11): the ONLY
// runtime import of src/sqlite-compat.ts outside the suite - which imports
// nothing but node builtins, so this script needs no dependency install
// beyond typescript for the typecheck step. Runs the module through the
// behaviors the seven store files rely on: open, WAL, array params,
// transaction rollback, savepoint nesting, BEGIN EXCLUSIVE contention
// against a second connection, and get() null-on-missing-row. Run:
//   node --experimental-strip-types .github/scripts/sqlite-compat-smoke.mjs
// Temp dbs only. node:sqlite prints an ExperimentalWarning on the floor -
// noise, not a failure.
import { Database } from "../../src/sqlite-compat.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const dir = mkdtempSync(join(tmpdir(), "thatch-sqlite-smoke-"));
const dbPath = join(dir, "smoke.db");

// Open + WAL + params (the run-with-array shape) + get() null.
const db = new Database(dbPath);
db.exec("CREATE TABLE t (x TEXT UNIQUE)");
db.run("PRAGMA journal_mode = WAL");
db.run("INSERT INTO t VALUES (?)", ["smoke"]);
assert.equal(db.query("PRAGMA journal_mode").get().journal_mode, "wal");
assert.equal(db.query("SELECT x FROM t").get().x, "smoke");
assert.equal(db.query("SELECT 1 AS y WHERE 1 = 0").get(), null, "missing row must be null, not undefined");

// Transaction rollback: a throwing fn rolls its writes back and rethrows.
try {
  db.transaction(() => {
    db.run("INSERT INTO t VALUES (?)", ["rolled-back"]);
    throw new Error("inner boom");
  })();
  assert.fail("the transaction wrapper must rethrow");
} catch (err) {
  assert.equal(err.message, "inner boom");
}
assert.equal(db.query("SELECT count(*) AS n FROM t").get().n, 1);

// Savepoint nesting: an inner failure preserves the outer transaction.
db.transaction(() => {
  db.run("INSERT INTO t VALUES (?)", ["outer"]);
  try {
    db.transaction(() => {
      db.run("INSERT INTO t VALUES (?)", ["inner"]);
      throw new Error("inner2");
    })();
  } catch {
    /* the outer transaction survives */
  }
})();
assert.deepEqual(
  db.query("SELECT x FROM t ORDER BY rowid").all().map((r) => r.x),
  ["smoke", "outer"],
);

// BEGIN EXCLUSIVE contention against a second connection on the same file,
// with busy_timeout pinned to 0 so the refusal is immediate.
db.exec("PRAGMA busy_timeout = 0");
const second = new Database(dbPath);
second.exec("PRAGMA busy_timeout = 0");
db.exec("BEGIN EXCLUSIVE");
try {
  second.exec("BEGIN EXCLUSIVE");
  assert.fail("the second connection's BEGIN EXCLUSIVE must fail");
} catch (err) {
  // The module normalizes the busy code to bun's shape (D9).
  assert.equal(err.code, "SQLITE_BUSY");
}
db.exec("ROLLBACK");

second.close();
db.close();
rmSync(dir, { recursive: true, force: true });
console.log("sqlite-compat smoke: all assertions passed");
