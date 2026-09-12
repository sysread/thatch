import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ThatchDB } from "../src/db";
import { ChatPoller, isStale, nowIso, CHAT_STALE_MINUTES, isoSecondsAgo as cutoffAgo } from "../src/chat";
import { CHAT_NAME_POOL } from "../src/chat-names";
import { chatEchoText } from "../src/prompts";

let dbDir: string;
let dbPath: string;
let db: ThatchDB;
// A second, raw connection for fixture surgery: aging timestamps and other
// row-level manipulation the public API deliberately does not expose.
let raw: Database;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-chat-test-"));
  dbPath = join(dbDir, "test.db");
  db = new ThatchDB(dbPath);
  raw = new Database(dbPath);
});

afterEach(() => {
  db.close();
  raw.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe("ChatStore via ThatchDB", () => {
  test("register creates a directory row; timestamps match the strftime format", () => {
    const result = db.registerChatSession("ses_a", "alice", "acme/widgets");
    expect(result.ok).toBe(true);
    const rows = db.listChatSessions();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("alice");
    expect(rows[0].session_id).toBe("ses_a");
    expect(rows[0].project).toBe("acme/widgets");
    expect(rows[0].registered_at).toMatch(ISO_SECOND);
    expect(rows[0].last_seen).toMatch(ISO_SECOND);
    expect(nowIso()).toMatch(ISO_SECOND);
  });

  test("register rejects empty and over-long names", () => {
    expect(db.registerChatSession("ses_a", "   ", "p").ok).toBe(false);
    expect(db.registerChatSession("ses_a", "x".repeat(41), "p").ok).toBe(false);
  });

  test("a name can only be claimed by one session", () => {
    expect(db.registerChatSession("ses_a", "alice", "p").ok).toBe(true);
    const clash = db.registerChatSession("ses_b", "alice", "p");
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error).toContain("taken");
  });

  test("name uniqueness is case-insensitive", () => {
    expect(db.registerChatSession("ses_a", "Landru", "p").ok).toBe(true);
    expect(db.registerChatSession("ses_b", "landru", "p").ok).toBe(false);
    // Lookups and message addressing follow the same rule.
    expect(db.findChatSession("LANDRU")?.session_id).toBe("ses_a");
    db.registerChatSession("ses_b", "bob", "p");
    expect(db.sendChatMessage("ses_b", "LANDRU", "hi").ok).toBe(true);
  });

  test("a session can recase its own name", () => {
    expect(db.registerChatSession("ses_a", "Landru", "p").ok).toBe(true);
    const recase = db.registerChatSession("ses_a", "landru", "p");
    expect(recase.ok).toBe(true);
    expect(db.findChatSession("LANDRU")?.name).toBe("landru");
  });

  test("names outside the shared charset are rejected", () => {
    // Parens would truncate the transcript echo's name parse; newlines and
    // tabs would break chat_list's one-line roster.
    expect(db.registerChatSession("ses_a", "Deb (Debugger) Malloy", "p").ok).toBe(false);
    expect(db.registerChatSession("ses_a", "Bad\nName", "p").ok).toBe(false);
    expect(db.registerChatSession("ses_a", "Tab\tName", "p").ok).toBe(false);
    // Pool-style punctuation stays valid.
    expect(db.registerChatSession("ses_a", "K'Vir the Unmerged", "p").ok).toBe(true);
  });

  test("re-registering renames; re-registering the same name is idempotent", () => {
    db.registerChatSession("ses_a", "alice", "p");
    expect(db.registerChatSession("ses_a", "alice", "p").ok).toBe(true);
    expect(db.registerChatSession("ses_a", "ally", "p").ok).toBe(true);
    expect(db.findChatSession("ally")?.session_id).toBe("ses_a");
    expect(db.findChatSession("alice")).toBeNull();
    // The old name is free again for a different session.
    expect(db.registerChatSession("ses_b", "alice", "p").ok).toBe(true);
  });

  test("find resolves by name or session id; misses return null", () => {
    db.registerChatSession("ses_a", "alice", "p");
    expect(db.findChatSession("alice")?.session_id).toBe("ses_a");
    expect(db.findChatSession("ses_a")?.name).toBe("alice");
    expect(db.findChatSession("nobody")).toBeNull();
  });

  test("unregister removes the row but keeps message history", () => {
    db.registerChatSession("ses_a", "alice", "p");
    db.registerChatSession("ses_b", "bob", "p");
    db.sendChatMessage("ses_a", "bob", "hello");
    expect(db.unregisterChatSession("ses_a")).toBe(true);
    expect(db.unregisterChatSession("ses_a")).toBe(false);
    expect(db.findChatSession("alice")).toBeNull();
    // The message survives as history; the sender degrades to unknown.
    const inbox = db.readChatMessages("ses_b");
    expect(inbox.length).toBe(1);
    expect(inbox[0].from_name).toBeNull();
    expect(inbox[0].body).toBe("hello");
  });

  test("send validates endpoints", () => {
    db.registerChatSession("ses_a", "alice", "p");
    db.registerChatSession("ses_b", "bob", "p");
    expect(db.sendChatMessage("ses_a", "ghost", "hi").ok).toBe(false);
    expect(db.sendChatMessage("ses_unregistered", "bob", "hi").ok).toBe(false);
    expect(db.sendChatMessage("ses_a", "ses_a", "note to self").ok).toBe(false);
    expect(db.sendChatMessage("ses_a", "bob", "   ").ok).toBe(false);
    expect(db.sendChatMessage("ses_a", "bob", "x".repeat(10_001)).ok).toBe(false);
    const ok = db.sendChatMessage("ses_a", "bob", "hello bob");
    expect(ok.ok).toBe(true);
    // The resolved recipient rides along - callers never re-lookup.
    if (ok.ok) {
      expect(ok.recipient.name).toBe("bob");
      expect(ok.recipient.session_id).toBe("ses_b");
    }
    // Session-id addressing works too.
    expect(db.sendChatMessage("ses_b", "ses_a", "hello alice").ok).toBe(true);
  });

  test("read drains the inbox oldest-first and stamps messages read", () => {
    db.registerChatSession("ses_a", "alice", "p");
    db.registerChatSession("ses_b", "bob", "p");
    db.sendChatMessage("ses_a", "bob", "first");
    db.sendChatMessage("ses_a", "bob", "second");
    expect(db.unreadChatCount("ses_b")).toBe(2);
    const inbox = db.readChatMessages("ses_b");
    expect(inbox.map((m) => m.body)).toEqual(["first", "second"]);
    expect(inbox.every((m) => m.from_name === "alice")).toBe(true);
    expect(db.unreadChatCount("ses_b")).toBe(0);
    expect(db.readChatMessages("ses_b")).toEqual([]);
    expect(db.readChatMessages("ses_a")).toEqual([]);
  });
});

describe("name pool assignment", () => {
  test("assign draws an unused pool name; two sessions never draw the same", () => {
    const first = db.assignChatName("ses_a", "p");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(CHAT_NAME_POOL).toContain(first.name);
    const second = db.assignChatName("ses_b", "p");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.name).not.toBe(first.name);
  });

  test("assign is idempotent for an already-registered session", () => {
    db.registerChatSession("ses_a", "custom-name", "p");
    const again = db.assignChatName("ses_a", "p");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.name).toBe("custom-name");
  });

  test("a custom claim removes that pool name from future draws", () => {
    const claimed = CHAT_NAME_POOL[0];
    expect(db.registerChatSession("ses_a", claimed, "p").ok).toBe(true);
    // Draw until the pool is nearly exhausted; the claimed name never reappears.
    for (let i = 0; i < CHAT_NAME_POOL.length - 2; i++) {
      const draw = db.assignChatName(`ses_${i}`, "p");
      expect(draw.ok).toBe(true);
      if (draw.ok) expect(draw.name).not.toBe(claimed);
    }
  });

  test("the pool can be exhausted, with a clear error", () => {
    for (let i = 0; i < CHAT_NAME_POOL.length; i++) {
      const draw = db.assignChatName(`ses_${i}`, "p");
      expect(draw.ok).toBe(true);
    }
    const exhausted = db.assignChatName("ses_overflow", "p");
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.error).toContain("exhausted");
  });
});

describe("chat name-collation migration", () => {
  test("a case-sensitive legacy table is rebuilt with NOCASE uniqueness", () => {
    db.close();
    raw.close();
    rmSync(dbDir, { recursive: true, force: true });
    dbDir = mkdtempSync(join(tmpdir(), "thatch-chat-mig-"));
    dbPath = join(dbDir, "test.db");
    // Build the v1 schema by hand: plain case-sensitive UNIQUE, with the
    // colliding rows the old constraint allowed.
    const legacy = new Database(dbPath);
    legacy.run(`
      CREATE TABLE chat_sessions (
        session_id    TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        project       TEXT,
        registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        last_seen     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);
    legacy.run("INSERT INTO chat_sessions (session_id, name) VALUES ('ses_a', 'Landru')");
    legacy.run("INSERT INTO chat_sessions (session_id, name) VALUES ('ses_b', 'landru')");
    legacy.run("INSERT INTO chat_sessions (session_id, name) VALUES ('ses_c', 'Bob')");
    legacy.close();

    // Opening with ThatchDB runs the migration at schema init.
    db = new ThatchDB(dbPath);
    raw = new Database(dbPath);
    const rows = db.listChatSessions();
    expect(rows.length).toBe(2);
    const names = new Set(rows.map((r) => r.name.toLowerCase()));
    expect(names.has("landru")).toBe(true);
    expect(names.has("bob")).toBe(true);
    // The new constraint is live: the surviving Landru cannot be re-claimed
    // in any casing by another session.
    const survivor = rows.find((r) => r.name.toLowerCase() === "landru")!;
    const clash = db.registerChatSession("ses_new", survivor.name === "Landru" ? "landru" : "Landru", "p");
    expect(clash.ok).toBe(false);
    // And re-opening is a no-op (the stored CREATE statement now says NOCASE).
    db.close();
    db = new ThatchDB(dbPath);
    expect(db.listChatSessions().length).toBe(2);
  });
});

describe("chat delivery selection", () => {
  beforeEach(() => {
    db.registerChatSession("ses_a", "alice", "p");
    db.registerChatSession("ses_b", "bob", "p");
  });

  test("undelivered unread messages are pending; delivered ones are not", () => {
    db.sendChatMessage("ses_a", "bob", "hello");
    let pending = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
    expect(pending.length).toBe(1);
    expect(pending[0].from_name).toBe("alice");

    db.markChatDelivered(pending.map((m) => m.id));
    // Fresh delivery inside the re-nudge window: nothing pending.
    pending = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
    expect(pending.length).toBe(0);
  });

  test("read messages are never pending", () => {
    db.sendChatMessage("ses_a", "bob", "hello");
    db.readChatMessages("ses_b");
    expect(db.pendingChatNotifications(["ses_b"], cutoffAgo(15)).length).toBe(0);
  });

  test("delivered-but-unread messages re-queue once the re-nudge window passes", () => {
    db.sendChatMessage("ses_a", "bob", "hello");
    const pending = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
    db.markChatDelivered(pending.map((m) => m.id));
    // Age the delivery stamp past any plausible re-nudge window.
    raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z'");
    const requeued = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
    expect(requeued.length).toBe(1);
    expect(requeued[0].id).toBe(pending[0].id);
  });

  test("pending selection only covers the given sessions", () => {
    db.registerChatSession("ses_c", "carol", "p");
    db.sendChatMessage("ses_a", "bob", "for bob");
    db.sendChatMessage("ses_a", "carol", "for carol");
    const pending = db.pendingChatNotifications(["ses_b"], nowIso());
    expect(pending.length).toBe(1);
    expect(pending[0].to_session).toBe("ses_b");
  });

  test("unregistering stops wake selection for kept-but-unread mail", () => {
    db.sendChatMessage("ses_a", "bob", "unread after exit");
    // Degenerate zero-minute window: everything unread is selectable.
    expect(db.pendingChatNotifications(["ses_b"], nowIso()).length).toBe(1);
    db.unregisterChatSession("ses_b");
    // The mail is kept (still unread, chat_read can still drain it), but
    // no wake prompt may target a session that left the directory.
    expect(db.unreadChatCount("ses_b")).toBe(1);
    expect(db.pendingChatNotifications(["ses_b"], nowIso()).length).toBe(0);
  });
});

describe("staleness", () => {
  test("isStale flips on heartbeat age", () => {
    db.registerChatSession("ses_a", "alice", "p");
    const fresh = db.listChatSessions()[0];
    expect(isStale(fresh, CHAT_STALE_MINUTES)).toBe(false);
    raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z'");
    const stale = db.listChatSessions()[0];
    expect(isStale(stale, CHAT_STALE_MINUTES)).toBe(true);
  });

  test("heartbeat refreshes last_seen for hosted sessions only", () => {
    db.registerChatSession("ses_hosted", "alice", "p");
    db.registerChatSession("ses_other", "bob", "p");
    raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z'");
    db.heartbeatChatSessions(["ses_hosted"]);
    const rows = new Map(db.listChatSessions().map((r) => [r.session_id, r]));
    expect(isStale(rows.get("ses_hosted")!, CHAT_STALE_MINUTES)).toBe(false);
    expect(isStale(rows.get("ses_other")!, CHAT_STALE_MINUTES)).toBe(true);
  });
});

describe("chat transcript echo text", () => {
  test("register echoes the claimed name; failures stay silent", () => {
    expect(chatEchoText("thatch_chat_register", {}, "[registered] Kurn the Typechecker\nsession_id: ses_x"))
      .toBe("[chat] Kurn the Typechecker joined the session directory");
    expect(chatEchoText("thatch_chat_register", {}, "Registration failed: name taken")).toBeNull();
  });

  test("send echoes the resolved recipient name with a clipped body", () => {
    const out = "[sent] to Landru (ses_f6c9e9a0)\n\nThe recipient is nudged when idle.";
    expect(chatEchoText("thatch_chat_send", { to: "landru", body: "hello" }, out))
      .toBe("[chat] to Landru: hello");
    // Output shape unparseable: fall back to the addressed name.
    expect(chatEchoText("thatch_chat_send", { to: "bob", body: "hi" }, "[sent] to bob"))
      .toBe("[chat] to bob: hi");
    expect(chatEchoText("thatch_chat_send", { to: "Landru", body: "x".repeat(300) }, out))
      .toBe("[chat] to Landru: " + "x".repeat(200) + "...");
    expect(chatEchoText("thatch_chat_send", { to: "ghost", body: "hi" }, "Not sent: no registered session.")).toBeNull();
  });

  test("read echoes the inbox; empty inbox stays silent", () => {
    expect(chatEchoText("thatch_chat_read", {}, "Inbox empty.")).toBeNull();
    expect(chatEchoText("thatch_chat_read", {}, "[from Landru] hi\n(1 message, marked read)"))
      .toBe("[chat] inbox\n[from Landru] hi\n(1 message, marked read)");
    const echo = chatEchoText("thatch_chat_read", {}, "y".repeat(2000));
    expect(echo).toBe("[chat] inbox\n" + "y".repeat(1500) + "...");
  });

  test("list and unregister never echo", () => {
    expect(chatEchoText("thatch_chat_list", {}, "[chat] 2 sessions registered")).toBeNull();
    expect(chatEchoText("thatch_chat_unregister", {}, "[unregistered] this session left.")).toBeNull();
  });
});

describe("ChatPoller", () => {
  let deliveries: Array<{ sessionID: string; senders: string[]; count: number }>;
  let gateOpen: boolean;
  let hosted: string[];
  let poller: ChatPoller;

  beforeEach(() => {
    deliveries = [];
    gateOpen = false;
    hosted = ["ses_b"];
    db.registerChatSession("ses_a", "alice", "p");
    db.registerChatSession("ses_b", "bob", "p");
    poller = new ChatPoller({
      store: db,
      hostedSessions: () => [...hosted],
      deliver: async (sessionID, senders, count) => {
        deliveries.push({ sessionID, senders, count });
      },
      canDeliver: (sessionID) => gateOpen && hosted.includes(sessionID),
      pollIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    poller.dispose();
  });

  test("poll heartbeats hosted sessions", async () => {
    raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z'");
    await poller.poll();
    const row = db.listChatSessions().find((r) => r.session_id === "ses_b")!;
    expect(isStale(row, CHAT_STALE_MINUTES)).toBe(false);
  });

  test("messages wait while the gate is closed, then deliver when idle", async () => {
    db.sendChatMessage("ses_a", "bob", "hello");
    db.sendChatMessage("ses_a", "bob", "again");
    await poller.poll();
    expect(deliveries.length).toBe(0);

    gateOpen = true;
    await poller.deliverPending();
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].sessionID).toBe("ses_b");
    expect(deliveries[0].senders).toEqual(["alice"]);
    expect(deliveries[0].count).toBe(2);
    // Delivered: nothing pending until the re-nudge window passes.
    expect(db.pendingChatNotifications(["ses_b"], cutoffAgo(15)).length).toBe(0);
  });

  test("delivery failure leaves messages pending", async () => {
    const failing = new ChatPoller({
      store: db,
      hostedSessions: () => hosted,
      deliver: async () => {
        throw new Error("boom");
      },
      canDeliver: () => true,
      pollIntervalMs: 60_000,
    });
    db.sendChatMessage("ses_a", "bob", "hello");
    await failing.deliverPending();
    expect(db.pendingChatNotifications(["ses_b"], cutoffAgo(15)).length).toBe(1);
    failing.dispose();
  });

  test("unhosted sessions are never delivered to", async () => {
    db.sendChatMessage("ses_b", "alice", "for the other process");
    gateOpen = true;
    await poller.deliverPending();
    // alice is not hosted by this poller; her host process owns delivery.
    expect(deliveries.length).toBe(0);
    expect(db.pendingChatNotifications(["ses_a"], cutoffAgo(15)).length).toBe(1);
  });

  test("the nudge rate cap stops repeated wake prompts", async () => {
    const capped = new ChatPoller({
      store: db,
      hostedSessions: () => hosted,
      deliver: async (sessionID, senders, count) => {
        deliveries.push({ sessionID, senders, count });
      },
      canDeliver: () => true,
      pollIntervalMs: 60_000,
      maxNudgesPerHour: 1,
    });
    db.sendChatMessage("ses_a", "bob", "first batch");
    await capped.deliverPending();
    expect(deliveries.length).toBe(1);
    // Age the delivery stamp so the re-nudge window re-opens, then poll
    // again: the hard cap holds despite the pending message.
    raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z'");
    await capped.deliverPending();
    expect(deliveries.length).toBe(1);
    capped.dispose();
  });

  test("re-nudges fire after the renudge window passes", async () => {
    db.sendChatMessage("ses_a", "bob", "hello");
    gateOpen = true;
    await poller.deliverPending();
    expect(deliveries.length).toBe(1);
    raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z'");
    await poller.deliverPending();
    expect(deliveries.length).toBe(2);
  });

  test("senders deduplicate across a batch", async () => {
    db.registerChatSession("ses_c", "carol", "p");
    db.sendChatMessage("ses_a", "bob", "one");
    db.sendChatMessage("ses_c", "bob", "two");
    db.sendChatMessage("ses_a", "bob", "three");
    gateOpen = true;
    await poller.deliverPending();
    expect(deliveries[0].senders.sort()).toEqual(["alice", "carol"]);
    expect(deliveries[0].count).toBe(3);
  });

  test("start/stop/dispose manage the timer", () => {
    expect(poller.running).toBe(false);
    poller.start();
    expect(poller.running).toBe(true);
    poller.start(); // idempotent
    poller.stop();
    expect(poller.running).toBe(false);
    poller.dispose();
    expect(poller.running).toBe(false);
  });
});
