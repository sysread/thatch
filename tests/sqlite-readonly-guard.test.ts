// The readonly guard (node-sqlite M1 pre-check): the option spelling
// session-db.ts passes must open the database READ-ONLY on whatever sqlite
// layer backs it - a thatch bug must never be able to corrupt the host's
// session history. The trap this polices: node:sqlite spells the option
// `readOnly` and SILENTLY IGNORES bun's lowercase `readonly`, so an un-
// translated open succeeds read-write. The import tracks the specifier
// session-db.ts itself uses: bun:sqlite before the node:sqlite re-point,
// the compat module after.
//
// Both arms of the guard run here: a write attempt against the opened
// connection must throw, and a full SessionDB read pass must leave the
// fixture bytes byte-identical (no journal or shm residue either).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SessionDB } from "../src/session-db";

function makeFixtureDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, title text, directory text, agent text, model text, time_created integer, time_updated integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer, data text);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer, data text);
  `);
  db.exec(`INSERT INTO session VALUES ('ses_test', 'Test session', '/tmp/proj', 'build', 'test-model', 1000, 9000)`);
  db.query("INSERT INTO message VALUES (?, 'ses_test', ?, ?)").run("msg_u1", 1100, JSON.stringify({ role: "user", time: { created: 1100 } }));
  db.query("INSERT INTO part VALUES (?, ?, 'ses_test', ?, ?)").run("prt_u1_text", "msg_u1", 1101, JSON.stringify({ type: "text", text: "hello blarg world" }));
  db.close();
}

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-readonly-guard-"));
  dbPath = join(dbDir, "opencode.db");
  makeFixtureDb(dbPath);
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

function fixtureBytes(): { hash: string; files: string[] } {
  const files = readdirSync(dbDir).sort();
  return { hash: createHash("sha256").update(readFileSync(dbPath)).digest("hex"), files };
}

describe("the readonly option spelling session-db passes", () => {
  test("a write attempt against the opened connection throws", () => {
    const before = fixtureBytes();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(() => db.run("INSERT INTO session VALUES ('ses_evil', 'x', 'x', NULL, NULL, 1, 2)")).toThrow();
      expect(() => db.run("DELETE FROM session")).toThrow();
      expect(() => db.exec("CREATE TABLE written (x)")).toThrow();
    } finally {
      db.close();
    }
    expect(fixtureBytes()).toEqual(before);
  });

  test("a full SessionDB read pass leaves the fixture bytes unchanged", () => {
    const before = fixtureBytes();
    const db = new SessionDB(dbPath);
    try {
      expect(db.getSession("ses_test")?.title).toBe("Test session");
      expect(db.listParts("ses_test").length).toBe(1);
      expect(db.getMessage("msg_u1")?.parts.length).toBe(1);
      expect(db.listMessages("ses_test").length).toBe(1);
      expect(db.search("blarg").length).toBe(1);
    } finally {
      db.close();
    }
    expect(fixtureBytes()).toEqual(before);
  });
});
