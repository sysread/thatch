import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ThatchDB } from "../src/db";
import { MockEmbeddingModel } from "./mocks/embeddings";
import { nowIso, isoMinutesAgo as cutoffAgo, NAME_CHARSET, slugifyTitle, isDefaultSessionTitle, humanAge, renderChatParticipant } from "../src/chat";
import { CHAT_NAME_POOL } from "../src/chat-names";
import { TOOL_DEFS } from "../src/tool-defs";
import { makeChatDbFixture, disposeChatDbFixture, makeReg } from "./mocks/chat-harness";

let dbDir: string;
let dbPath: string;
let db: ThatchDB;
// A second, raw connection for fixture surgery: aging timestamps and other
// row-level manipulation the public API deliberately does not expose.
let raw: Database;
// Open-tab fixture for the broadcast/liveness surfaces. null = "every
// registered session has a tab" (preserves the pre-tab-signal pins); a
// test replaces it with an explicit set to exercise the open/recent split.
let openTabsFixture: ReadonlySet<string> | null;

beforeEach(() => {
  openTabsFixture = null;
  ({ dbDir, dbPath, db, raw } = makeChatDbFixture(
    () => openTabsFixture ?? new Set(db.listChatSessions().map((r) => r.session_id)),
  ));
});

afterEach(() => {
  disposeChatDbFixture({ dbDir, dbPath, db, raw, openTabsFixture });
});

const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const reg = makeReg(() => db);

describe("ChatStore via ThatchDB", () => {
  test("register assigns a slug-counter name and creates the directory row", () => {
    const result = reg("ses_a", "alice", "acme/widgets");
    expect(result.name).toBe("alice-00001");
    const rows = db.listChatSessions();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("alice-00001");
    expect(rows[0].session_id).toBe("ses_a");
    expect(rows[0].project).toBe("acme/widgets");
    expect(rows[0].registered_at).toMatch(ISO_SECOND);
    expect(rows[0].last_seen).toMatch(ISO_SECOND);
    expect(nowIso()).toMatch(ISO_SECOND);
    // The row is marked auto: the TTL prune and the title-topic refresh
    // only ever touch auto rows.
    const auto = raw.query("SELECT auto FROM chat_sessions WHERE session_id = 'ses_a'").get() as any;
    expect(auto.auto).toBe(1);
  });

  test("a title-less registration draws a pool slug as the base", () => {
    const result = reg("ses_a");
    // The name is <slug-of-a-pool-name>-<counter>: lowercase, hyphenated.
    const base = result.name.replace(/-\d{5}$/, "");
    expect(result.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
    // Membership must go through the production slugifier: pool names with
    // apostrophes (K'Vir, K'Leth, B'Etor) slug lossily, and a hand-rolled
    // lowercase-and-hyphenate check disagrees on exactly those draws.
    expect(CHAT_NAME_POOL.map((n) => slugifyTitle(n))).toContain(base);
  });

  test("the same base handed to two sessions yields distinct counters", () => {
    const a = reg("ses_a", "fix-auth");
    const b = reg("ses_b", "fix-auth");
    expect(a.name).toBe("fix-auth-00001");
    expect(b.name).toBe("fix-auth-00002");
  });

  test("a legacy row holding a drawn name makes the next draw bump the counter", () => {
    // The collision path: a manual/legacy row (pre-assignment claim) already
    // owns "fix-auth-00001". Assignment must skip past it, not fail.
    raw.run("INSERT INTO chat_sessions (session_id, name, project, host_kind, auto) VALUES ('ses_legacy', 'fix-auth-00001', 'p', 'opencode', 0)");
    const a = reg("ses_a", "fix-auth");
    expect(a.name).toBe("fix-auth-00002");
    // The legacy row is untouched.
    expect(db.findChatSession("ses_legacy")?.name).toBe("fix-auth-00001");
  });

  test("pruning an auto row never reissues its name; counters only grow", () => {
    const a = reg("ses_a", "fix-auth");
    expect(a.name).toBe("fix-auth-00001");
    // Age the row past the TTL and prune.
    raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z'");
    expect(db.pruneStaleChatAuto("2026-01-01T00:00:00Z")).toBe(1);
    expect(db.findChatSession("ses_a")).toBeNull();
    // A new session with the same base gets the NEXT number, never 1 again.
    const b = reg("ses_b", "fix-auth");
    expect(b.name).toBe("fix-auth-00002");
  });

  test("prune removes dead mail addressed to pruned sessions, keeps history", () => {
    reg("ses_a", "alice");
    reg("ses_b", "bob");
    reg("ses_ghost", "ghost");
    // Mail a -> b: read (history, kept). Mail a -> ghost: unread and the
    // recipient is about to be pruned (dead mail). Mail a -> b unread:
    // recipient stays registered, so it is kept.
    db.sendChatMessage("ses_a", "bob-00001", "read already");
    db.readChatMessages("ses_b");
    db.sendChatMessage("ses_a", "ghost-00001", "nobody will read this");
    db.sendChatMessage("ses_a", "bob-00001", "still unread");
    raw.run("UPDATE chat_messages SET created_at = '2020-01-01T00:00:00Z'");
    // Age only the ghost: the live sessions keep fresh last_seen stamps, so
    // a fixed cutoff prunes exactly one row regardless of clock timing.
    raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_ghost'");
    db.pruneStaleChatAuto("2026-01-01T00:00:00Z");
    expect(db.findChatSession("ses_ghost")).toBeNull();
    // The live sessions survive: only the ghost crosses the fixed cutoff.
    expect(db.findChatSession("ses_a")).not.toBeNull();
    const dead = raw.query("SELECT COUNT(*) AS n FROM chat_messages WHERE body = 'nobody will read this'").get() as any;
    expect(dead.n).toBe(0);
    // Read history and live-recipient mail survive.
    expect(db.unreadChatCount("ses_b")).toBe(1);
    expect(db.readChatMessages("ses_b").map((m) => m.body)).toEqual(["still unread"]);
  });

  test("topics are optional, sanitized to one roster line, and set at registration", () => {
    // Omitted: no topic.
    expect(reg("ses_a", "alice").topic).toBeNull();
    // Registration-time topic: cleaned and capped. (Re-registering ignores
    // the topic argument - only the auto path sets topics, and refresh
    // updates them.)
    expect(reg("ses_b", "bob", "p", "QAing the release").topic).toBe("QAing the release");
    expect(db.findChatSession("bob-00001")?.topic).toBe("QAing the release");
    const dirty = reg("ses_c", "carol", "p", "  multi\nline   topic  that runs far past the eighty character limit for topics ");
    expect(dirty.topic).toBe("multi line topic that runs far past the eighty character limit for topics");
    const long = reg("ses_d", "dave", "p", "x".repeat(200));
    expect(long.topic?.length).toBe(80);
    // Re-register (ensure path) keeps the existing topic; refreshAutoTopic
    // is the only writer for auto rows.
    expect(reg("ses_b", "bob").topic).toBe("QAing the release");
    expect(db.findChatSession("bob-00001")?.topic).toBe("QAing the release");
  });

  test("refreshAutoTopic updates auto rows only", () => {
    reg("ses_a", "alice", "p", "old title");
    // A legacy manual row: auto=0, model-set topic.
    raw.run("INSERT INTO chat_sessions (session_id, name, project, host_kind, auto, topic) VALUES ('ses_legacy', 'landru', 'p', 'opencode', 0, 'user topic')");
    db.refreshChatTopic("ses_a", "new title from autotitler");
    db.refreshChatTopic("ses_legacy", "sneaky title");
    expect(db.findChatSession("alice-00001")?.topic).toBe("new title from autotitler");
    expect(db.findChatSession("ses_legacy")?.topic).toBe("user topic");
    // An empty title never blanks a topic.
    db.refreshChatTopic("ses_a", "   ");
    expect(db.findChatSession("alice-00001")?.topic).toBe("new title from autotitler");
  });

  test("generated names satisfy the charset and never shadow session IDs", () => {
    const a = reg("ses_a", "fix auth");
    expect(NAME_CHARSET.test(a.name)).toBe(true);
    // Underscores matter for a different reason: find() resolves
    // name-first, and opencode session IDs contain underscores - a legal
    // display name with an underscore could shadow an ID.
    expect(a.name).not.toContain("_");
  });

  test("re-registering is idempotent and keeps the assigned name", () => {
    const first = reg("ses_a", "alice");
    const again = reg("ses_a", "alice");
    expect(again.name).toBe(first.name);
    expect(db.listChatSessions().length).toBe(1);
  });

  test("find resolves by name or session id; misses return null", () => {
    reg("ses_a", "alice");
    expect(db.findChatSession("alice-00001")?.session_id).toBe("ses_a");
    expect(db.findChatSession("ses_a")?.name).toBe("alice-00001");
    expect(db.findChatSession("nobody")).toBeNull();
  });

  test("unregister removes the row but keeps message history", () => {
    const alice = reg("ses_a", "alice").name;
    const bob = reg("ses_b", "bob").name;
    db.sendChatMessage("ses_a", bob, "hello");
    db.unregisterChatSession("ses_a");
    expect(db.unregisterChatSession("ses_a")).toBe(false);
    expect(db.findChatSession(alice)).toBeNull();
    // The message survives as history, and the sender's name rides on the
    // row: the send-time snapshot is immune to the later unregister.
    const inbox = db.readChatMessages("ses_b");
    expect(inbox.length).toBe(1);
    expect(inbox[0].from_name).toBe(alice);
    expect(inbox[0].body).toBe("hello");
  });

  test("sends snapshot both participants' names onto the message row", () => {
    const alice = reg("ses_a", "alice").name;
    const bob = reg("ses_b", "bob").name;
    db.sendChatMessage("ses_a", bob, "hello");
    const row = raw.query("SELECT from_name, to_name FROM chat_messages").get() as any;
    expect(row.from_name).toBe(alice);
    expect(row.to_name).toBe(bob);
  });

  test("a broadcast row snapshots the sender and its real recipient", () => {
    const alice = reg("ses_a", "alice").name;
    reg("ses_b", "bob");
    reg("ses_c", "carol");
    db.broadcastChatMessage("ses_a", "heads up");
    const rows = raw.query("SELECT from_name, to_name FROM chat_messages").all() as any[];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.from_name === alice)).toBe(true);
    expect(rows.map((r) => r.to_name).sort()).toEqual(["bob-00001", "carol-00001"]);
  });

  test("legacy rows without a snapshot resolve through the live join, then the unknown fallback", () => {
    const alice = reg("ses_a", "alice").name;
    // Rows written before the snapshot columns existed carry NULL names.
    // Sender still registered: the live roster join supplies the name.
    raw.run("INSERT INTO chat_messages (from_session, to_session, body) VALUES ('ses_a', 'ses_b', 'legacy live')");
    // Sender gone and never snapshotted: nothing resolves, so rendering
    // degrades to the shared unknown-departed convention.
    raw.run("INSERT INTO chat_messages (from_session, to_session, body) VALUES ('ses_ghost', 'ses_b', 'legacy departed')");
    const inbox = db.readChatMessages("ses_b");
    expect(inbox.length).toBe(2);
    const live = inbox.find((m) => m.body === "legacy live")!;
    expect(live.from_name).toBe(alice);
    const departed = inbox.find((m) => m.body === "legacy departed")!;
    expect(departed.from_name).toBeNull();
    expect(renderChatParticipant(departed.from_name, departed.from_session)).toBe(
      `unknown (${departed.from_session.slice(0, 12)}, departed)`,
    );
  });

  test("messageById prefers the snapshot and falls back like read does", () => {
    // The chat_read paging path (tool-defs chat_read --message) reads one
    // row by id through messageById; its COALESCE chain must match read()'s:
    // snapshot first, live join for legacy rows, null for a departed sender.
    const alice = reg("ses_a", "alice").name;
    reg("ses_b", "bob");
    db.sendChatMessage("ses_a", "bob-00001", "snapshotted");
    const snapshotted = raw.query("SELECT id FROM chat_messages WHERE body = 'snapshotted'").get() as any;
    // Legacy row: same shape a pre-snapshot build left behind.
    raw.run("INSERT INTO chat_messages (from_session, to_session, body) VALUES ('ses_a', 'ses_b', 'legacy')");
    const legacyId = (raw.query("SELECT id FROM chat_messages WHERE body = 'legacy'").get() as any).id;

    db.unregisterChatSession("ses_a", "explicit");

    // The snapshotted row still renders the sender's name after departure.
    const snap = db.chatMessageById("ses_b", snapshotted.id);
    expect(snap).not.toBeNull();
    expect(snap!.from_name).toBe(alice);
    // The legacy row has no snapshot and no roster row: nothing resolves.
    const legacy = db.chatMessageById("ses_b", legacyId);
    expect(legacy).not.toBeNull();
    expect(legacy!.from_name).toBeNull();
    // Wrong-recipient reads stay rejected (the id is scoped to the inbox).
    expect(db.chatMessageById("ses_a", legacyId)).toBeNull();
  });

  test("tombstones record their leave reason; only rejoinable reasons clear", () => {
    reg("ses_exit", "exitcase");
    reg("ses_explicit", "explicitcase");
    reg("ses_deleted", "deletedcase");
    db.unregisterChatSession("ses_exit", "exit");
    db.unregisterChatSession("ses_explicit", "explicit");
    db.unregisterChatSession("ses_deleted", "deleted");
    // The reason column carries the writer's path.
    const reasons = raw.query("SELECT session_id, reason FROM chat_leave_tombstones").all() as any[];
    expect(reasons.find((r) => r.session_id === "ses_exit")?.reason).toBe("exit");
    expect(reasons.find((r) => r.session_id === "ses_explicit")?.reason).toBe("explicit");
    expect(reasons.find((r) => r.session_id === "ses_deleted")?.reason).toBe("deleted");
    // The rejoin clear takes the exit and deleted tombstones, leaves the
    // explicit one for chat_register.
    expect(db.clearRejoinableTombstone("ses_exit")).toBe(true);
    expect(db.clearRejoinableTombstone("ses_deleted")).toBe(true);
    expect(db.clearRejoinableTombstone("ses_explicit")).toBe(false);
    expect(db.hasChatLeaveTombstone("ses_exit")).toBe(false);
    expect(db.hasChatLeaveTombstone("ses_deleted")).toBe(false);
    expect(db.hasChatLeaveTombstone("ses_explicit")).toBe(true);
  });

  test("send validates endpoints", () => {
    const bob = reg("ses_b", "bob").name;
    reg("ses_a", "alice");
    expect(db.sendChatMessage("ses_a", "ghost", "hi").ok).toBe(false);
    expect(db.sendChatMessage("ses_unregistered", bob, "hi").ok).toBe(false);
    expect(db.sendChatMessage("ses_a", "ses_a", "note to self").ok).toBe(false);
    expect(db.sendChatMessage("ses_a", bob, "   ").ok).toBe(false);
    // An oversized body is auto-split, not refused (10001 chars at the
    // default 2000-char budget: five full parts plus a 1001-char tail).
    const long = db.sendChatMessage("ses_a", bob, "x".repeat(10_001));
    expect(long.ok).toBe(true);
    if (long.ok) expect(long.parts).toBe(6);
    const ok = db.sendChatMessage("ses_a", bob, "hello bob");
    expect(ok.ok).toBe(true);
    // The resolved recipient rides along - callers never re-lookup.
    if (ok.ok) {
      expect(ok.recipient.name).toBe("bob-00001");
      expect(ok.recipient.session_id).toBe("ses_b");
    }
    // Session-id addressing works too.
    expect(db.sendChatMessage("ses_b", "ses_a", "hello alice").ok).toBe(true);
  });

  test("an identical resend within the dedupe window lands one row, outside it lands two", () => {
    const bob = reg("ses_b", "bob").name;
    reg("ses_a", "alice");
    const rowCount = () => (raw.query("SELECT COUNT(*) AS n FROM chat_messages").get() as any).n;

    // A client retry of a send that actually committed: same body, seconds
    // apart. The retry succeeds but does not create a second row.
    const first = db.sendChatMessage("ses_a", bob, "status: green");
    const retry = db.sendChatMessage("ses_a", bob, "status: green");
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.deduped).toBe(true);
    expect(rowCount()).toBe(1);

    // A different recipient or body is never deduped.
    const carol = reg("ses_c", "carol").name;
    const toCarol = db.sendChatMessage("ses_a", carol, "status: green");
    expect(toCarol.ok && toCarol.deduped === true).toBe(false);
    const toBobRed = db.sendChatMessage("ses_a", bob, "status: red");
    expect(toBobRed.ok && toBobRed.deduped === true).toBe(false);
    expect(rowCount()).toBe(3);

    // The same body again after the window has passed is a new message:
    // age the first row past the dedupe window, then resend.
    raw.run(`UPDATE chat_messages SET created_at = '${cutoffAgo(1)}' WHERE body = 'status: green' AND to_session = 'ses_b'`);
    const later = db.sendChatMessage("ses_a", bob, "status: green");
    expect(later.ok).toBe(true);
    if (later.ok) expect(later.deduped).toBeUndefined();
    expect(rowCount()).toBe(4);
  });

  test("a retried broadcast suppresses per-recipient duplicates and keeps the recipient list", () => {
    reg("ses_a", "alice");
    reg("ses_b", "bob");
    reg("ses_c", "carol");
    const first = db.broadcastChatMessage("ses_a", "rebase if you are based on main");
    expect(first.ok).toBe(true);
    const retry = db.broadcastChatMessage("ses_a", "rebase if you are based on main");
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.deduped).toBe(2);
      // The recipient list stays complete - each recipient DID receive the
      // original delivery.
      expect(retry.recipients.sort()).toEqual(["bob-00001", "carol-00001"]);
    }
    expect((raw.query("SELECT COUNT(*) AS n FROM chat_messages").get() as any).n).toBe(2);
    // A different body broadcasts fresh.
    const third = db.broadcastChatMessage("ses_a", "different body");
    if (third.ok) expect(third.deduped).toBe(0);
  });

  test("broadcast reaches every other fresh session, skipping stale ones", () => {
    reg("ses_a", "alice");
    reg("ses_b", "bob");
    reg("ses_c", "carol");
    // A fourth session whose host process is gone: stale, skipped.
    reg("ses_ghost", "ghost");
    raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_ghost'");

    const result = db.broadcastChatMessage("ses_a", "the time of the biologicals has come to an end");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients.sort()).toEqual(["bob-00001", "carol-00001"]);
    expect(result.skipped).toEqual(["ghost-00001"]);
    // Every recipient got its own inbox row.
    expect(db.unreadChatCount("ses_b")).toBe(1);
    expect(db.unreadChatCount("ses_c")).toBe(1);
    // The sender is excluded.
    expect(db.unreadChatCount("ses_a")).toBe(0);

    // Validation mirrors send (empty is refused; long is split, not refused).
    expect(db.broadcastChatMessage("ses_a", "   ").ok).toBe(false);
    expect(db.broadcastChatMessage("ses_unregistered", "hi").ok).toBe(false);
    const longBroadcast = db.broadcastChatMessage("ses_a", "x".repeat(10_001));
    expect(longBroadcast.ok).toBe(true);
    if (longBroadcast.ok) expect(longBroadcast.parts).toBe(6);
    // A broadcast to no live sessions still succeeds, honestly.
    db.unregisterChatSession("ses_b");
    db.unregisterChatSession("ses_c");
    const empty = db.broadcastChatMessage("ses_a", "anyone there?");
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.recipients).toEqual([]);
  });

  test("broadcast targets only OPEN rows: fresh-without-tab is skipped and named", () => {
    reg("ses_a", "alice");
    reg("ses_b", "bob");
    reg("ses_c", "carol");
    reg("ses_m", "mickey");
    raw.run("UPDATE chat_sessions SET host_kind = 'mcp' WHERE session_id = 'ses_m'");
    // bob has a tab (OPEN); carol does not (RECENT). RECENT is skipped:
    // the tab-less wake can be swallowed, so the fan-out would spend a
    // model turn on a delivery that likely never runs. MCP always
    // receives (it reads mail at its next prompt).
    openTabsFixture = new Set(["ses_b", "ses_m"]);
    const result = db.broadcastChatMessage("ses_a", "rebase if you are based on main");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipients.sort()).toEqual(["bob-00001", "mickey-00001"]);
    expect(result.skipped).toEqual(["carol-00001"]);
    expect(db.unreadChatCount("ses_b")).toBe(1);
    expect(db.unreadChatCount("ses_m")).toBe(1);
    expect(db.unreadChatCount("ses_c")).toBe(0);
  });

  test("broadcast with no tab signal degrades honestly: every opencode row is RECENT", () => {
    reg("ses_a", "alice");
    reg("ses_b", "bob");
    reg("ses_m", "mickey");
    raw.run("UPDATE chat_sessions SET host_kind = 'mcp' WHERE session_id = 'ses_m'");
    // An unwired provider (no local opencode state, tabs disabled): no
    // session reads as open, so only the MCP row receives - never a false
    // OPEN-driven fan-out.
    const noSignal = new ThatchDB(dbPath);
    try {
      const result = noSignal.broadcastChatMessage("ses_a", "anyone mounted?");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.recipients).toEqual(["mickey-00001"]);
      expect(result.skipped.sort()).toEqual(["bob-00001"]);
    } finally {
      noSignal.close();
    }
  });

  test("read drains the inbox oldest-first and stamps messages read", () => {
    const alice = reg("ses_a", "alice").name;
    const bob = reg("ses_b", "bob").name;
    db.sendChatMessage("ses_a", bob, "first");
    db.sendChatMessage("ses_a", bob, "second");
    expect(db.unreadChatCount("ses_b")).toBe(2);
    const inbox = db.readChatMessages("ses_b");
    expect(inbox.map((m) => m.body)).toEqual(["first", "second"]);
    expect(inbox.every((m) => m.from_name === alice)).toBe(true);
    expect(db.unreadChatCount("ses_b")).toBe(0);
    expect(db.readChatMessages("ses_b")).toEqual([]);
    expect(db.readChatMessages("ses_a")).toEqual([]);
  });
});

describe("assigned names", () => {
  test("slugifyTitle lowercases, hyphenates, and caps at 32", () => {
    expect(slugifyTitle("Fix auth bug")).toBe("fix-auth-bug");
    expect(slugifyTitle("  Weird--punctuation!! here  ")).toBe("weird-punctuation-here");
    expect(slugifyTitle("Ünïcode Tïtle")).toBe("ünïcode-tïtle");
    expect(slugifyTitle("x".repeat(50))).toHaveLength(32);
    expect(slugifyTitle("!!!")).toBeNull();
    expect(slugifyTitle("")).toBeNull();
  });

  test("isDefaultSessionTitle flags opencode placeholders", () => {
    expect(isDefaultSessionTitle("New session - 2026-09-13T10:00:00Z")).toBe(true);
    expect(isDefaultSessionTitle("Child session - 2026-09-13T10:00:00Z")).toBe(true);
    expect(isDefaultSessionTitle("Fix auth bug")).toBe(false);
  });

  test("counters are per base and never shared across bases", () => {
    expect(reg("ses_a", "alpha").name).toBe("alpha-00001");
    expect(reg("ses_b", "beta").name).toBe("beta-00001");
    expect(reg("ses_c", "alpha").name).toBe("alpha-00002");
  });

  test("a null base draws a pool slug, still counter-suffixed", () => {
    const result = reg("ses_a");
    expect(result.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
  });

  test("prune deletes auto rows but keeps counters (name never reissued)", () => {
    reg("ses_a", "keep");
    raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z'");
    db.pruneStaleChatAuto(nowIso());
    const counter = raw.query("SELECT next FROM chat_name_counters WHERE base = 'keep'").get() as any;
    expect(counter.next).toBe(2);
  });
});

describe("roster age and checkout kind", () => {
  test("humanAge renders human-readable buckets", () => {
    const now = Date.parse("2026-09-14T12:00:00Z");
    expect(humanAge("2026-09-14T11:59:15Z", now)).toBe("45s ago");
    expect(humanAge("2026-09-14T11:55:00Z", now)).toBe("5m ago");
    expect(humanAge("2026-09-14T09:00:00Z", now)).toBe("3h ago");
    expect(humanAge("2026-09-12T12:00:00Z", now)).toBe("2d ago");
    expect(humanAge("not-a-date", now)).toBe("unknown age");
  });

  test("registration records the checkout kind; default rows read as unknown", () => {
    reg("ses_a", "alpha");
    db.registerChatSession("ses_w", "p", null, "opencode", "bravo", "worktree");
    const rows = db.listChatSessions();
    expect(rows.find((r) => r.session_id === "ses_a")!.worktree).toBeNull();
    expect(rows.find((r) => r.session_id === "ses_w")!.worktree).toBe("worktree");
  });

  test("register reports created vs existing", () => {
    const first = db.registerChatSession("ses_c1", "p", null, "opencode", "gamma");
    if (!first.ok) throw new Error(first.error);
    expect(first.created).toBe(true);
    const second = db.registerChatSession("ses_c1", "p", null, "opencode", "gamma");
    if (!second.ok) throw new Error(second.error);
    expect(second.created).toBe(false);
  });

  test("heartbeat refreshes last_seen", () => {
    reg("ses_hb", "delta");
    const before = db.listChatSessions().find((r) => r.session_id === "ses_hb")!.last_seen;
    db.heartbeatChatSessions(["ses_hb"]);
    const after = db.listChatSessions().find((r) => r.session_id === "ses_hb")!.last_seen;
    expect(Date.parse(after)).toBeGreaterThanOrEqual(Date.parse(before));
  });
});

describe("chat name-collation migration", () => {
  test("a case-sensitive legacy table is rebuilt with NOCASE uniqueness", () => {
    db.close();
    raw.close();
    rmSync(dbDir, { recursive: true, force: true });
    dbDir = mkdtempSync(join(tmpdir(), "thatch-chat-mig-"));
    dbPath = join(dbDir, "test.db");
    // Build the pre-NOCASE schema by hand: plain case-sensitive UNIQUE, with the
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
    // The new constraint is live: the surviving Landru still owns its name,
    // and an assigned registration with that base lands on the next counter
    // value rather than colliding or reusing the name.
    const survivor = rows.find((r) => r.name.toLowerCase() === "landru")!;
    const clash = db.registerChatSession("ses_new", "p", null, "opencode", "landru");
    expect(clash.ok).toBe(true);
    if (clash.ok) expect(clash.name.toLowerCase()).not.toBe(survivor.name.toLowerCase());
    // And re-opening is a no-op (the stored CREATE statement now says NOCASE).
    db.close();
    db = new ThatchDB(dbPath);
    // 2 migrated survivors + the assigned ses_new row.
    expect(db.listChatSessions().length).toBe(3);
  });
});

describe("chat message name-snapshot migration", () => {
  test("a pre-snapshot chat_messages table gains the columns and old rows read", () => {
    // A database written by a pre-snapshot build carries chat_messages
    // without from_name/to_name. Opening it must add the columns (the
    // compat surface for every installed user's thatch.db), keep the old
    // rows NULL, and render them through the live-join fallback.
    db.close();
    raw.close();
    rmSync(dbDir, { recursive: true, force: true });
    dbDir = mkdtempSync(join(tmpdir(), "thatch-chat-mig-"));
    dbPath = join(dbDir, "test.db");
    const legacy = new Database(dbPath);
    legacy.run(`
      CREATE TABLE chat_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_session  TEXT NOT NULL,
        to_session    TEXT NOT NULL,
        body          TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        delivered_at  TEXT,
        read_at       TEXT,
        via_broadcast INTEGER NOT NULL DEFAULT 0
      )
    `);
    legacy.run("INSERT INTO chat_messages (from_session, to_session, body) VALUES ('ses_old', 'ses_me', 'before the snapshot')");
    legacy.close();

    // Opening with ThatchDB runs the migration at schema init.
    db = new ThatchDB(dbPath);
    raw = new Database(dbPath);
    db.registerChatSession("ses_old", "thatch-mig", null, "opencode", "oldtimer");
    db.registerChatSession("ses_me", "thatch-mig", null, "opencode", "reader");
    const cols = (raw.query("PRAGMA table_info(chat_messages)").all() as any[]).map((r) => r.name);
    expect(cols).toContain("from_name");
    expect(cols).toContain("to_name");
    // The pre-snapshot row survived with NULL names and renders through
    // the live join (the sender is registered here).
    const inbox = db.readChatMessages("ses_me");
    expect(inbox.length).toBe(1);
    expect(inbox[0].from_name).toBe("oldtimer-00001");
    const rowId = inbox[0].id;
    // And re-opening is a no-op for the schema. The first read DRAINED the
    // row (read_at stamped - that is the drain's contract), so the
    // post-reopen render goes through messageById (paging has no read_at
    // filter) and must still resolve the sender through the live join.
    db.close();
    db = new ThatchDB(dbPath);
    expect(db.readChatMessages("ses_me").length).toBe(0);
    const paged = db.chatMessageById("ses_me", rowId);
    expect(paged).not.toBeNull();
    expect(paged!.from_name).toBe("oldtimer-00001");
  });
});

describe("chat identity directory binding", () => {
  // One shared db, two contexts with different project slugs: the MCP `as`
  // fallback may only claim identities belonging to the caller's project.
  const dir = mkdtempSync(join(tmpdir(), "thatch-bind-"));
  const db = new ThatchDB(join(dir, "bind.db"));
  const raw = new Database(join(dir, "bind.db"));
  const model = new MockEmbeddingModel();
  const ctxA = { db, model, defaultStore: "acme/alpha" } as any;
  const ctxB = { db, model, defaultStore: "acme/beta" } as any;
  // MCP-path calls: no host context - identity comes from `as`.
  const call = (ctx: any, name: string, args: Record<string, unknown> = {}) =>
    TOOL_DEFS.find((t) => t.name === name)!.execute(args, ctx, undefined);

  const regName = async (ctx: any) => {
    const out = (await call(ctx, "chat_register")) as string;
    return (out.match(/\[registered\] (.+)/) ?? [])[1]!;
  };

  let alphaName: string;
  let alphaSessionID: string;

  test("setup: register an alpha-project identity", async () => {
    alphaName = await regName(ctxA);
    const row = (db as any).findChatSession(alphaName);
    alphaSessionID = row.session_id;
    expect(alphaName).toMatch(/^\S+-\d{5}$/);
  });

  test("same-project as claim resolves; cross-project is refused", async () => {
    const peerAlpha = { db, model, defaultStore: "acme/alpha" } as any;
    const ok = (await call(peerAlpha, "chat_status", { as: alphaName })) as string;
    expect(ok).toContain("[chat] registered as");
    expect(ok).not.toContain("another project");

    const refused = (await call(ctxB, "chat_status", { as: alphaName })) as string;
    expect(refused).toContain("registered to another project");
    expect(refused).toContain("chat_register");
  });

  test("a session-ID-based as claim is bound by the same rule", async () => {
    const refused = (await call(ctxB, "chat_status", { as: alphaSessionID })) as string;
    expect(refused).toContain("registered to another project");
  });

  test("a claimed row with a null project is refused (fail safe)", async () => {
    raw.run("UPDATE chat_sessions SET project = NULL WHERE session_id = ?", [alphaSessionID]);
    const refused = (await call(ctxA, "chat_status", { as: alphaName })) as string;
    // Restore before asserting: a failed assertion must not leave the row
    // broken for later tests.
    raw.run("UPDATE chat_sessions SET project = 'acme/alpha' WHERE session_id = ?", [alphaSessionID]);
    expect(refused).toContain("registered to another project");
    expect(refused).toContain("(none");
  });

  test("an anchor miss falls through to `as` and is bound", async () => {
    const derivedMiss = { db, model, defaultStore: "acme/beta", chatDerivedIdentity: () => "ses_gone" } as any;
    const refused = (await call(derivedMiss, "chat_status", { as: alphaName })) as string;
    expect(refused).toContain("registered to another project");
  });

  test("chat_register reclaim: same project confirms, cross project registers fresh", async () => {
    // Same project: the pre-existing reclaim confirmation.
    const reclaim = (await call(ctxA, "chat_register", { as: alphaName })) as string;
    expect(reclaim).toContain("You were already registered");

    // Cross project: no leak, a fresh identity instead.
    const fresh = (await call(ctxB, "chat_register", { as: alphaName })) as string;
    expect(fresh).toContain("belongs to another project");
    expect(fresh).toContain("[registered]");
    expect(fresh).not.toContain("You were already registered");
    const freshName = (fresh.match(/\[registered\] (.+)/) ?? [])[1]!;
    expect(freshName).not.toBe(alphaName);

    // A nonexistent name still teaches the assigned-names rule.
    const ghost = (await call(ctxA, "chat_register", { as: "ghost-00001" })) as string;
    expect(ghost).toContain("No registered session named");
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("name pool invariants", () => {
  test("every pool name satisfies the shared charset", () => {
    for (const name of CHAT_NAME_POOL) {
      expect(NAME_CHARSET.test(name), `pool name "${name}" fails the charset`).toBe(true);
      expect(name.length).toBeLessThanOrEqual(40);
    }
  });

  test("no two pool names collide case-insensitively", () => {
    const seen = new Set<string>();
    for (const name of CHAT_NAME_POOL) {
      const key = name.toLowerCase();
      expect(seen.has(key), `pool name "${name}" collides case-insensitively`).toBe(false);
      seen.add(key);
    }
  });
});
