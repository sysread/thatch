// Shared fixtures for the chat test files (chat-store, chat-poller,
// chat-tail, chat-echo): the per-test temp-dir ThatchDB with a raw surgery
// connection, and the assigned-name registration helper.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ThatchDB } from "../../src/db";

export interface ChatDbFixture {
  dbDir: string;
  dbPath: string;
  db: ThatchDB;
  raw: Database;
  openTabsFixture: ReadonlySet<string> | null;
}

/** Builds one per-test chat DB fixture in a fresh temp dir. `chatOpenTabs`
 *  is stored on the ThatchDB; each part file passes a closure over its own
 *  fixture lets so per-test writes to `openTabsFixture` stay visible to the
 *  provider. */
export function makeChatDbFixture(chatOpenTabs: () => ReadonlySet<string>): ChatDbFixture {
  const dbDir = mkdtempSync(join(tmpdir(), "thatch-chat-test-"));
  const dbPath = join(dbDir, "test.db");
  const db = new ThatchDB(dbPath, { chatOpenTabs });
  const raw = new Database(dbPath);
  return { dbDir, dbPath, db, raw, openTabsFixture: null };
}

export function disposeChatDbFixture(f: ChatDbFixture): void {
  f.db.close();
  f.raw.close();
  rmSync(f.dbDir, { recursive: true, force: true });
}

/** Registers a session with an assigned name. On a fresh DB the per-base
 *  counter starts at 1, so base "alice" deterministically yields
 *  "alice-00001". Throws on failure so tests fail at the setup line. */
export function makeReg(getDb: () => ThatchDB) {
  return (sesID: string, base?: string, project = "p", topic: string | null = null) => {
    const r = getDb().registerChatSession(sesID, project, topic, "opencode", base ?? null);
    if (!r.ok) throw new Error(`reg(${sesID}, ${base}) failed: ${r.error}`);
    return r;
  };
}
