// The cross-library interop check (node-sqlite M1 pre-check, OQ7): a raw
// bun:sqlite connection and the compat module's node:sqlite connection
// share ONE temp db - the suite's post-re-point reality, where fixture
// seeding uses raw bun handles while ThatchDB goes through the module.
// Two different bundled sqlite builds must agree on WAL and locking.
// Every busy_timeout is PINNED here so the contention assertions are
// fail-fast facts, not timing flakes. Needs a node:sqlite-capable runtime
// (bun >= 1.4.2) for the module side.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Database as CompatDatabase } from "../src/sqlite-compat";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-sqlite-interop-"));
  dbPath = join(dbDir, "interop.db");
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

function seedWithBun(): BunDatabase {
  const db = new BunDatabase(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE t (x TEXT UNIQUE)");
  db.query("INSERT INTO t VALUES (?)").run("seeded-by-bun");
  return db;
}

describe("bun:sqlite and the compat module on one database", () => {
  test("WAL writes interop in both directions", () => {
    const bun = seedWithBun();
    const node = new CompatDatabase(dbPath);
    try {
      // WAL mode is a property of the file: node sees it.
      expect(node.query("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      // bun's committed WAL write is visible through the module.
      expect(node.query("SELECT x FROM t").all()).toMatchObject([{ x: "seeded-by-bun" }]);
      // The module's write is visible to bun.
      node.run("INSERT INTO t VALUES (?)", ["written-by-node"]);
      expect(bun.query("SELECT x FROM t ORDER BY rowid").all()).toMatchObject([
        { x: "seeded-by-bun" },
        { x: "written-by-node" },
      ]);
    } finally {
      node.close();
      bun.close();
    }
  });

  test("BEGIN EXCLUSIVE contention holds across the libraries, both directions", () => {
    // busy_timeout pinned to 0: the loser must fail IMMEDIATELY with a busy
    // error - if a timeout were left at an engine default, a slow machine
    // could turn the assertion into a coin flip.
    const bun = seedWithBun();
    const node = new CompatDatabase(dbPath);
    try {
      node.exec("PRAGMA busy_timeout = 0");
      bun.exec("PRAGMA busy_timeout = 0");

      // node holds the lock; bun's BEGIN EXCLUSIVE is refused as busy.
      node.exec("BEGIN EXCLUSIVE");
      expect(() => bun.exec("BEGIN EXCLUSIVE")).toThrow(/locked|busy/i);
      node.exec("ROLLBACK");

      // bun holds the lock; the module's BEGIN EXCLUSIVE is refused.
      bun.exec("BEGIN EXCLUSIVE");
      expect(() => node.exec("BEGIN EXCLUSIVE")).toThrow(/locked|busy/i);
      bun.exec("ROLLBACK");
    } finally {
      node.close();
      bun.close();
    }
  });

  test("the module normalizes a cross-library busy error to SQLITE_BUSY", () => {
    const bun = seedWithBun();
    const node = new CompatDatabase(dbPath);
    try {
      node.exec("PRAGMA busy_timeout = 0");
      bun.exec("PRAGMA busy_timeout = 0");
      bun.exec("BEGIN EXCLUSIVE");
      try {
        node.exec("BEGIN EXCLUSIVE");
        throw new Error("the contention assertion did not fire");
      } catch (err: any) {
        // The shape both busy checkers key on (daemon.ts, db.ts).
        expect(err.code).toBe("SQLITE_BUSY");
        expect(err.message).toMatch(/database is locked/);
      }
    } finally {
      node.close();
      bun.close();
    }
  });

  test("the module normalizes a constraint error to SQLITE_CONSTRAINT (the remember/chat checkers' shape)", () => {
    // bun's UNIQUE violation arrives as code SQLITE_CONSTRAINT_*; node's
    // arrives as ERR_SQLITE_ERROR with the constraint text only in the
    // message. db.ts's duplicate-label catch and chat.ts's
    // #isConstraintError read the code first, so the module rewrites it.
    const bun = seedWithBun();
    const node = new CompatDatabase(dbPath);
    try {
      expect(() => node.run("INSERT INTO t VALUES ('seeded-by-bun')")).toThrow();
      try {
        node.run("INSERT INTO t VALUES ('seeded-by-bun')");
      } catch (err: any) {
        expect(err.code).toBe("SQLITE_CONSTRAINT");
        expect(err.message).toMatch(/constraint failed/i);
      }
    } finally {
      node.close();
      bun.close();
    }
  });

  test("the session-db analog: a module readonly connection reads while bun writes", () => {
    // session-db's post-re-point reality: opencode's writer is a bun:sqlite
    // connection; session-db's is the module's readonly one. The reader
    // must see committed writes and never block them.
    const bun = seedWithBun();
    const node = new CompatDatabase(dbPath, { readonly: true });
    try {
      expect(node.query("SELECT x FROM t").get()).toMatchObject({ x: "seeded-by-bun" });
      bun.query("INSERT INTO t VALUES (?)").run("second-from-bun");
      expect(node.query("SELECT count(*) AS n FROM t").get()).toMatchObject({ n: 2 });
      // The readonly connection must refuse its own writes.
      expect(() => node.run("INSERT INTO t VALUES ('nope')")).toThrow();
    } finally {
      node.close();
      bun.close();
    }
  });
});
