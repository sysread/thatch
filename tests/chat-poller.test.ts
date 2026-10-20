import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ThatchDB } from "../src/db";
import { ChatStore, ChatPoller, isStale, nowIso, CHAT_STALE_MS, CHAT_POLL_INTERVAL_MS, CHAT_AUTO_TTL_DAYS, isoMinutesAgo as cutoffAgo, renderChatParticipant, chatLiveness, splitChatRoster, sortChatRoster, createWakeGate, continuedInTarget, scanPredecessorTranscript, resolveRegisteredPredecessor, type ChatSessionRow } from "../src/chat";
import { silenceConsoleError, captureConsoleError } from "./mocks/console-error";
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

const reg = makeReg(() => db);

// The departed-sender convention is a cross-surface contract; pin its
// exact shape so a reword in renderChatParticipant fails here.
test("departed participants render with the shared unknown convention", () => {
  expect(renderChatParticipant(null, "ses_abcdefgh1234")).toBe("unknown (ses_abcdefgh, departed)");
  expect(renderChatParticipant("alice", "ses_x")).toBe("alice");
  expect(renderChatParticipant(null, null)).toBe("unknown (, departed)");
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
    reg("ses_a", "alice");
    reg("ses_b", "bob");
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
    expect(isStale(row)).toBe(false);
  });

  test("messages wait while the gate is closed, then deliver when idle", async () => {
    db.sendChatMessage("ses_a", "bob-00001", "hello");
    db.sendChatMessage("ses_a", "bob-00001", "again");
    await poller.poll();
    expect(deliveries.length).toBe(0);

    gateOpen = true;
    await poller.deliverPending();
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].sessionID).toBe("ses_b");
    expect(deliveries[0].senders).toEqual(["alice-00001"]);
    expect(deliveries[0].count).toBe(2);
    // Delivered: nothing pending until the re-nudge window passes.
    expect(db.pendingChatNotifications(["ses_b"], cutoffAgo(15)).length).toBe(0);
  });

  test("split parts arrive as ONE grouped nudge, not one per part", async () => {
    const body = ["A".repeat(1_900), "B".repeat(1_900), "C".repeat(1_900)].join("\n\n");
    const sent = db.sendChatMessage("ses_a", "bob-00001", body);
    expect(sent.ok && sent.parts === 3).toBe(true);
    gateOpen = true;
    await poller.poll();
    // The poller groups pending rows per recipient, so a 3-part batch is a
    // single wake prompt counting 3 unread messages.
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].sessionID).toBe("ses_b");
    expect(deliveries[0].senders).toEqual(["alice-00001"]);
    expect(deliveries[0].count).toBe(3);
  });

  test("delivery failure leaves messages pending", async () => {
    // The production delivery path logs each failed delivery; the scope
    // swallows it so the expected failure does not leak into the output.
    const failing = new ChatPoller({
      store: db,
      hostedSessions: () => hosted,
      deliver: async () => {
        throw new Error("boom");
      },
      canDeliver: () => true,
      pollIntervalMs: 60_000,
    });
    await silenceConsoleError(async () => {
      db.sendChatMessage("ses_a", "bob-00001", "hello");
      await failing.deliverPending();
      expect(db.pendingChatNotifications(["ses_b"], cutoffAgo(15)).length).toBe(1);
    });
    failing.dispose();
  });

  test("unhosted sessions are never delivered to", async () => {
    db.sendChatMessage("ses_b", "alice-00001", "for the other process");
    gateOpen = true;
    await poller.deliverPending();
    // alice is not hosted by this poller; her host process owns delivery.
    expect(deliveries.length).toBe(0);
    expect(db.pendingChatNotifications(["ses_a"], cutoffAgo(15)).length).toBe(1);
  });

  test("the nudge rate cap stops repeated re-nudges", async () => {
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
    await silenceConsoleError(async () => {
      db.sendChatMessage("ses_a", "bob-00001", "first batch");
      await capped.deliverPending();
      expect(deliveries.length).toBe(1);
      // Age the delivery stamp so the re-nudge window re-opens, then poll
      // again: the hard cap holds despite the pending message.
      raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z'");
      await capped.deliverPending();
      expect(deliveries.length).toBe(1);
    });
    capped.dispose();
  });

  test("the cap counts a re-nudge even when the delivered_at stamp fails", async () => {
    // The record-before-stamp ordering exists so a failing stamp cannot
    // turn into an uncounted re-delivery loop - the exact ping-pong the
    // cap exists to stop. Deliver succeeds; the stamp throws.
    const stampThrows = new ChatPoller({
      store: {
        heartbeatChatSessions: () => {},
        pendingChatNotifications: (ids, cutoff) => db.pendingChatNotifications(ids, cutoff),
        markChatDelivered: () => {
          throw new Error("db write failed");
        },
        recordChatWake: (to) => db.recordChatWake(to),
        chatWakeCount: (to, cutoff) => db.chatWakeCount(to, cutoff),
      },
      hostedSessions: () => hosted,
      deliver: async (sessionID, senders, count) => {
        deliveries.push({ sessionID, senders, count });
      },
      canDeliver: () => true,
      pollIntervalMs: 60_000,
      maxNudgesPerHour: 1,
    });
    // The production delivery path logs the failed stamp; the scope
    // swallows it so the expected failure does not leak into the output.
    await silenceConsoleError(async () => {
      db.sendChatMessage("ses_a", "bob-00001", "counted even if the stamp fails");
      await stampThrows.deliverPending();
      expect(deliveries.length).toBe(1);
      // The mail stays pending (the stamp failed), but the budget is spent:
      // a later cycle must not re-deliver, stamp failure or not. The
      // sentIds marker classifies the retry as a budget-bound re-nudge
      // even though delivered_at is still NULL.
      await stampThrows.deliverPending();
      expect(deliveries.length).toBe(1);
    });
    stampThrows.dispose();
  });

  test("a FIRST delivery still delivers with the budget exhausted", async () => {
    // The live incident this fixes: a coordination hub received six
    // legitimate report batches, spent its budget, and every later batch
    // sat undelivered for 37 minutes. New mail is the recipient's actual
    // inbox - it never waits behind the cap.
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
    await silenceConsoleError(async () => {
      db.sendChatMessage("ses_a", "bob-00001", "first batch");
      await capped.deliverPending();
      expect(deliveries.length).toBe(1);
      // A brand-new message: never delivered, budget spent. It lands.
      db.sendChatMessage("ses_a", "bob-00001", "second batch, fresh mail");
      await capped.deliverPending();
      expect(deliveries.length).toBe(2);
      // Only the re-nudge of delivered mail is budget-bound: age the first
      // batch's stamp so it re-queues, and confirm it is the thing held.
      db.sendChatMessage("ses_a", "bob-00001", "third batch, fresh mail");
      raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z' WHERE body = 'first batch'");
      await capped.deliverPending();
      expect(deliveries.length).toBe(3);
      expect(deliveries[2].count).toBe(1);
      const pending = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
      expect(pending.length).toBe(1);
    });
    capped.dispose();
  });

  test("a mixed batch delivers the new mail and holds the re-nudge when spent", async () => {
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
    await silenceConsoleError(async () => {
      db.sendChatMessage("ses_a", "bob-00001", "batch one");
      await capped.deliverPending();
      expect(deliveries.length).toBe(1);
      // Budget now spent. Age batch one's stamp (re-nudge due) and send
      // fresh mail: the cycle must deliver the fresh row and hold the
      // re-nudge, in one wake that counts only what it delivered.
      const heldId = (new Database(dbPath).query("SELECT id FROM chat_messages WHERE body = 'batch one'").get() as { id: number }).id;
      db.sendChatMessage("ses_a", "bob-00001", "batch two, fresh");
      raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z' WHERE body = 'batch one'");
      await capped.deliverPending();
      expect(deliveries.length).toBe(2);
      expect(deliveries[1].count).toBe(1);
      const pending = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(heldId);
    });
    capped.dispose();
  });

  test("the wake budget survives a poller reload", async () => {
    // The budget lives in the shared DB, not process memory: a reloaded
    // plugin instance inherits the spent budget instead of resetting it.
    const first = new ChatPoller({
      store: db,
      hostedSessions: () => hosted,
      deliver: async (sessionID, senders, count) => {
        deliveries.push({ sessionID, senders, count });
      },
      canDeliver: () => true,
      pollIntervalMs: 60_000,
      maxNudgesPerHour: 1,
    });
    await silenceConsoleError(async () => {
      db.sendChatMessage("ses_a", "bob-00001", "spent by the previous instance");
      await first.deliverPending();
      expect(deliveries.length).toBe(1);
      first.dispose();

      const second = new ChatPoller({
        store: db,
        hostedSessions: () => hosted,
        deliver: async (sessionID, senders, count) => {
          deliveries.push({ sessionID, senders, count });
        },
        canDeliver: () => true,
        pollIntervalMs: 60_000,
        maxNudgesPerHour: 1,
      });
      raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z'");
      await second.deliverPending();
      // A re-nudge is due and the fresh instance has empty memory - the DB
      // budget still holds it.
      expect(deliveries.length).toBe(1);
      second.dispose();
    });
  });

  test("budget exhaustion logs once per recipient per hour, not per cycle", async () => {
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
    db.sendChatMessage("ses_a", "bob-00001", "one");
    await capped.deliverPending();
    raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z'");
    const { lines } = await captureConsoleError(async () => {
      await capped.deliverPending();
      await capped.deliverPending();
      await capped.deliverPending();
    });
    const exhausted = lines.filter((l) => l.includes("wake budget exhausted"));
    expect(exhausted.length).toBe(1);
    expect(exhausted[0]).toContain("ses_b");
    capped.dispose();
  });

  test("the hourly sweep prunes wake rows outside the budget window", async () => {
    raw.run("INSERT INTO chat_wakes (to_session, at) VALUES ('ses_b', '2020-01-01T00:00:00Z')");
    raw.run(`INSERT INTO chat_wakes (to_session, at) VALUES ('ses_b', '${nowIso()}')`);
    await poller.poll();
    const remaining = new Database(dbPath)
      .query("SELECT COUNT(*) AS n FROM chat_wakes WHERE at <= '2020-01-02T00:00:00Z'")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  test("re-nudges fire after the renudge window passes", async () => {
    db.sendChatMessage("ses_a", "bob-00001", "hello");
    gateOpen = true;
    await poller.deliverPending();
    expect(deliveries.length).toBe(1);
    raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z'");
    await poller.deliverPending();
    expect(deliveries.length).toBe(2);
  });

  test("senders deduplicate across a batch", async () => {
    reg("ses_c", "carol");
    db.sendChatMessage("ses_a", "bob-00001", "one");
    db.sendChatMessage("ses_c", "bob-00001", "two");
    db.sendChatMessage("ses_a", "bob-00001", "three");
    gateOpen = true;
    await poller.deliverPending();
    expect(deliveries[0].senders.sort()).toEqual(["alice-00001", "carol-00001"]);
    expect(deliveries[0].count).toBe(3);
  });

  test("a departed sender renders under its snapshotted name in the wake prompt", async () => {
    db.sendChatMessage("ses_a", "bob-00001", "from a sender about to leave");
    db.unregisterChatSession("ses_a");
    gateOpen = true;
    await poller.deliverPending();
    // The send captured the sender's name on the row, and names are never
    // reassigned - the name survives the directory row disappearing.
    const last = deliveries[deliveries.length - 1];
    expect(last.senders).toEqual(["alice-00001"]);
  });

  test("a legacy NULL-snapshot row from a departed sender still renders unknown", async () => {
    // Fixture surgery: a row written before the snapshot columns existed.
    raw.run("INSERT INTO chat_messages (from_session, to_session, body) VALUES ('ses_a', 'ses_b', 'legacy')");
    db.unregisterChatSession("ses_a");
    gateOpen = true;
    await poller.deliverPending();
    // No snapshot and no roster row: the shared unknown convention is the
    // last fallback, same as chat_read.
    const last = deliveries[deliveries.length - 1];
    expect(last.senders).toEqual([`unknown (${"ses_a".slice(0, 12)}, departed)`]);
  });

  test("the poller's hourly sweep prunes stale auto rows", async () => {
    // A store fake that records prune calls, wired through the optional
    // ChatPollerStore method - the exact seam a regression would hide in.
    const prunes: string[] = [];
    const wakePrunes: string[] = [];
    const sweepPoller = new ChatPoller({
      store: {
        heartbeatChatSessions: () => {},
        pendingChatNotifications: (ids, cutoff) => db.pendingChatNotifications(ids, cutoff),
        markChatDelivered: (ids) => db.markChatDelivered(ids),
        recordChatWake: (to) => db.recordChatWake(to),
        chatWakeCount: (to, cutoff) => db.chatWakeCount(to, cutoff),
        pruneStaleChatAuto: (cutoff) => {
          prunes.push(cutoff);
          return 0;
        },
        pruneChatWakes: (cutoff) => {
          wakePrunes.push(cutoff);
        },
      },
      hostedSessions: () => [],
      deliver: async () => {},
      canDeliver: () => true,
      pollIntervalMs: 60_000,
    });
    // First poll sweeps immediately (#lastPrune starts at 0).
    await sweepPoller.poll();
    expect(prunes.length).toBe(1);
    // The wake-budget table rides the same sweep, pruned to its own window.
    expect(wakePrunes.length).toBe(1);
    expect(new Date(wakePrunes[0]).getTime()).toBeLessThan(Date.now() - 59 * 60_000);
    // The cutoff is the TTL: 7 days back.
    const cutoff = prunes[0];
    expect(new Date(cutoff).getTime()).toBeLessThan(Date.now() - 6.9 * 24 * 3600_000);
    // A poll an hour later sweeps again; a poll seconds later does not.
    await sweepPoller.poll();
    expect(prunes.length).toBe(1);
    sweepPoller.dispose();
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

describe("wake gate", () => {
  // The gate decides wake delivery for the chat poller AND the watcher
  // registry. The absence case is load-bearing: the `-s` startup session
  // is hosted before it emits any status event, so a gate that rejected
  // on map-absence would leave it mail-deaf (beating fine, never woken).
  const gate = (over?: {
    compacting?: boolean;
    mapped?: string;
    statuses?: Record<string, { type?: string } | undefined>;
    failFetch?: boolean;
  }) => {
    const errors: unknown[] = [];
    const canPrompt = createWakeGate({
      isCompacting: () => over?.compacting ?? false,
      mappedStatus: () => over?.mapped,
      fetchStatuses: async () => {
        if (over?.failFetch) throw new Error("server down");
        return over?.statuses ?? {};
      },
      onStatusError: (_id, err) => errors.push(err),
    });
    return { canPrompt, errors };
  };

  test("map-absent session falls through to the live check and wakes", async () => {
    const { canPrompt } = gate({});
    expect(await canPrompt("ses_quiet")).toBe(true);
  });

  test("known busy/retry rejects without fetching", async () => {
    const { canPrompt, errors } = gate({ mapped: "busy", failFetch: true });
    expect(await canPrompt("ses_busy")).toBe(false);
    expect(await gate({ mapped: "retry", failFetch: true }).canPrompt("s")).toBe(false);
    expect(errors).toHaveLength(0); // pre-filter: never reached the server
  });

  test("the live status map is authoritative: busy fails closed, absent means idle", async () => {
    const { canPrompt: busy } = gate({ statuses: { ses_x: { type: "busy" } } });
    expect(await busy("ses_x")).toBe(false);
    const { canPrompt: idleish } = gate({ statuses: { ses_x: { type: "idle" } } });
    expect(await idleish("ses_x")).toBe(true);
  });

  test("compacting fails closed; server failure fails closed", async () => {
    expect(await gate({ compacting: true, failFetch: true }).canPrompt("ses_c")).toBe(false);
    const { canPrompt, errors } = gate({ failFetch: true });
    expect(await canPrompt("ses_c")).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe("chat delivery selection", () => {
  beforeEach(() => {
    reg("ses_a", "alice");
    reg("ses_b", "bob");
  });

  test("undelivered unread messages are pending; delivered ones are not", () => {
    db.sendChatMessage("ses_a", "bob-00001", "hello");
    let pending = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
    expect(pending.length).toBe(1);
    expect(pending[0].from_name).toBe("alice-00001");

    db.markChatDelivered(pending.map((m) => m.id));
    // Fresh delivery inside the re-nudge window: nothing pending.
    pending = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
    expect(pending.length).toBe(0);
  });

  test("read messages are never pending", () => {
    db.sendChatMessage("ses_a", "bob-00001", "hello");
    db.readChatMessages("ses_b");
    expect(db.pendingChatNotifications(["ses_b"], cutoffAgo(15)).length).toBe(0);
  });

  test("delivered-but-unread messages re-queue once the re-nudge window passes", () => {
    db.sendChatMessage("ses_a", "bob-00001", "hello");
    const pending = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
    db.markChatDelivered(pending.map((m) => m.id));
    // Age the delivery stamp past any plausible re-nudge window.
    raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z'");
    const requeued = db.pendingChatNotifications(["ses_b"], cutoffAgo(15));
    expect(requeued.length).toBe(1);
    expect(requeued[0].id).toBe(pending[0].id);
  });

  test("pending selection only covers the given sessions", () => {
    reg("ses_c", "carol");
    db.sendChatMessage("ses_a", "bob-00001", "for bob");
    db.sendChatMessage("ses_a", "carol-00001", "for carol");
    const pending = db.pendingChatNotifications(["ses_b"], nowIso());
    expect(pending.length).toBe(1);
    expect(pending[0].to_session).toBe("ses_b");
  });

  test("unregistering stops wake selection for kept-but-unread mail", () => {
    db.sendChatMessage("ses_a", "bob-00001", "unread after exit");
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
    reg("ses_a", "alice");
    const fresh = db.listChatSessions()[0];
    expect(isStale(fresh)).toBe(false);
    raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z'");
    const stale = db.listChatSessions()[0];
    expect(isStale(stale)).toBe(true);
  });

  test("heartbeat refreshes last_seen for hosted sessions only", () => {
    reg("ses_hosted", "alice");
    reg("ses_other", "bob");
    raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z'");
    db.heartbeatChatSessions(["ses_hosted"]);
    const rows = new Map(db.listChatSessions().map((r) => [r.session_id, r]));
    expect(isStale(rows.get("ses_hosted")!)).toBe(false);
    expect(isStale(rows.get("ses_other")!)).toBe(true);
  });
});

describe("chatLiveness and roster split", () => {
  const NOW = Date.parse("2026-09-14T12:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const row = (over: Partial<ChatSessionRow>) =>
    ({
      session_id: "ses_x", name: "x-00001", topic: null, project: "p",
      host_kind: "opencode", registered_at: "2026-09-14T11:00:00Z",
      last_seen: ago(5_000), worktree: null,
      ...over,
    }) as ChatSessionRow;

  test("stale is two missed beats: one late beat is still fresh", () => {
    expect(CHAT_STALE_MS).toBe(2 * CHAT_POLL_INTERVAL_MS);
    expect(chatLiveness(row({ last_seen: ago(CHAT_POLL_INTERVAL_MS + 5_000) }), NOW)).toBe("recent");
    expect(chatLiveness(row({ last_seen: ago(CHAT_STALE_MS) }), NOW)).toBe("recent");
    expect(chatLiveness(row({ last_seen: ago(CHAT_STALE_MS + 1) }), NOW)).toBe("stale");
  });

  test("fresh heartbeat splits open vs recent on the open-tab set", () => {
    const tabs = new Set(["ses_x"]);
    // Tab present: OPEN (session presence). Same heartbeat without a tab:
    // RECENT (host alive, presence unknown). No tab set at all degrades
    // everything to RECENT - never a false OPEN.
    expect(chatLiveness(row({ session_id: "ses_x" }), NOW, tabs)).toBe("open");
    expect(chatLiveness(row({ session_id: "ses_y" }), NOW, tabs)).toBe("recent");
    expect(chatLiveness(row({ session_id: "ses_x" }), NOW, new Set())).toBe("recent");
    expect(chatLiveness(row({ session_id: "ses_x" }), NOW)).toBe("recent");
    // Staleness wins over tab membership: a stale row with a tab is STALE.
    expect(chatLiveness(row({ session_id: "ses_x", last_seen: ago(CHAT_STALE_MS + 1) }), NOW, tabs)).toBe("stale");
  });

  test("mcp rows are turn-driven: idle is the normal between-prompts state", () => {
    expect(chatLiveness(row({ host_kind: "mcp" }), NOW)).toBe("active");
    expect(chatLiveness(row({ host_kind: "mcp", last_seen: ago(CHAT_STALE_MS + 1) }), NOW)).toBe("idle");
  });

  test("splitChatRoster splits fresh opencode rows into active (open tab) and recent; mcp rows are always active", () => {
    const tabbed = row({ session_id: "ses_f", name: "f-00001" });
    const tabless = row({ session_id: "ses_r", name: "r-00001" });
    const dead = row({ session_id: "ses_d", name: "d-00001", last_seen: ago(CHAT_STALE_MS + 1) });
    const mcp = row({ session_id: "ses_m", name: "m-00001", host_kind: "mcp", last_seen: ago(CHAT_STALE_MS + 1) });
    // Without the tab set every fresh opencode row degrades to recent -
    // chatLiveness's honest-degradation rule, never a false open.
    const degraded = splitChatRoster([tabbed, tabless, dead, mcp], NOW);
    expect(degraded.active.map((r) => r.session_id)).toEqual(["ses_m"]);
    expect(degraded.recent.map((r) => r.session_id)).toEqual(["ses_f", "ses_r"]);
    expect(degraded.stale.map((r) => r.session_id)).toEqual(["ses_d"]);
    // With the tab set, the tabbed row is active, the tab-less one recent.
    const split = splitChatRoster([tabbed, tabless, dead, mcp], NOW, null, new Set(["ses_f"]));
    expect(split.active.map((r) => r.session_id)).toEqual(["ses_f", "ses_m"]);
    expect(split.recent.map((r) => r.session_id)).toEqual(["ses_r"]);
    expect(split.stale.map((r) => r.session_id)).toEqual(["ses_d"]);
  });

  test("sortChatRoster orders by project, then most recently seen; unknown project last", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const zeta = row({ session_id: "ses_z", name: "z-00001", project: "zeta/app", last_seen: ago(2 * DAY) });
    const alphaOld = row({ session_id: "ses_a2", name: "a2-00001", project: "alpha/app", last_seen: ago(DAY) });
    const alphaNew = row({ session_id: "ses_a1", name: "a1-00001", project: "alpha/app", last_seen: ago(60_000) });
    const orphan = row({ session_id: "ses_o", name: "o-00001", project: null, last_seen: ago(60_000) });
    const sorted = sortChatRoster([zeta, orphan, alphaOld, alphaNew]);
    expect(sorted.map((r) => r.session_id)).toEqual(["ses_a1", "ses_a2", "ses_z", "ses_o"]);
    // Pure ordering: the input array itself is untouched.
    expect(zeta.session_id).toBe("ses_z");
  });

  test("splitChatRoster staleCapMs hides stale rows older than the cap and reports the count", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const fresh = row({ session_id: "ses_f", name: "f-00001" });
    const dayOld = row({ session_id: "ses_d1", name: "d1-00001", last_seen: ago(DAY) });
    const weekOld = row({ session_id: "ses_d7", name: "d7-00001", last_seen: ago(7 * DAY) });
    const idleMcp = row({ session_id: "ses_m", name: "m-00001", host_kind: "mcp", last_seen: ago(7 * DAY) });
    // No cap (null): today's default for the tool surface, nothing hidden.
    expect(splitChatRoster([fresh, dayOld, weekOld, idleMcp], NOW).staleHidden).toBe(0);
    // One-day cap (the CLI default): the week-old row is hidden and
    // counted, the day-old row sits exactly at the boundary so it shows,
    // and the old-but-idle MCP row stays active (the cap only bounds the
    // stale section). The fresh row gets a tab so it stays in active -
    // without one it degrades to recent, per chatLiveness's honest-degradation rule tested above.
    const capped = splitChatRoster([fresh, dayOld, weekOld, idleMcp], NOW, DAY, new Set(["ses_f"]));
    expect(capped.stale.map((r) => r.session_id)).toEqual(["ses_d1"]);
    expect(capped.staleHidden).toBe(1);
    expect(capped.active.map((r) => r.session_id)).toEqual(["ses_f", "ses_m"]);
  });
});

describe("host-pid identity anchor", () => {
  test("records and resolves a fresh mapping when the session exists", () => {
    reg("ses_anchor", "anchor");
    db.recordChatHostPid(4242, "ses_anchor");
    expect(db.findChatSessionByHostPid(4242, 600)).toBe("ses_anchor");
  });

  test("stale mappings are ignored (pid reuse hazard)", () => {
    reg("ses_old", "oldpid");
    db.recordChatHostPid(5151, "ses_old");
    // Backdate the mapping past any reasonable freshness window.
    const raw = new Database(dbPath!);
    raw.run("UPDATE chat_host_pids SET seen_at = ?", [cutoffAgo(60)]);
    raw.close();
    expect(db.findChatSessionByHostPid(5151, 600)).toBeNull();
  });

  test("mapping to a pruned session resolves to null", () => {
    reg("ses_gone", "gonepid");
    db.recordChatHostPid(6262, "ses_gone");
    db.unregisterChatSession("ses_gone");
    expect(db.findChatSessionByHostPid(6262, 600)).toBeNull();
  });

  test("re-registration under the same session id revives the mapping", () => {
    reg("ses_back", "backpid");
    db.recordChatHostPid(7373, "ses_back");
    db.unregisterChatSession("ses_back");
    expect(db.findChatSessionByHostPid(7373, 600)).toBeNull();
    // Unregistering leaves a leave tombstone, and an opencode-kind register
    // refuses tombstoned sessions - clear it first, as an explicit rejoin
    // does.
    db.clearChatLeaveTombstone("ses_back");
    db.registerChatSession("ses_back", "p", null, "opencode");
    expect(db.findChatSessionByHostPid(7373, 600)).toBe("ses_back");
  });
});

describe("continuation adoption", () => {
  test("continuedInTarget reads the hand-off record from the file tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-cont-"));
    try {
      const file = join(dir, "aaaa-1111.jsonl");
      writeFileSync(file, '{"type":"user","message":{"content":"hi"}}\n{"type":"continued-in","sessionId":"aaaa-1111","continuedInSessionId":"bbbb-2222"}\n');
      expect(continuedInTarget(file)).toBe("bbbb-2222");
      writeFileSync(file, '{"type":"user","message":{"content":"hi"}}\n{"type":"assistant","message":{"content":"hello"}}\n');
      expect(continuedInTarget(file)).toBeNull();
      writeFileSync(file, "not json\n");
      expect(continuedInTarget(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scanPredecessorTranscript finds the sibling handing off to this session", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-cont-"));
    try {
      writeFileSync(join(dir, "old-one.jsonl"), '{"type":"continued-in","sessionId":"old-one","continuedInSessionId":"new-one"}\n');
      writeFileSync(join(dir, "unrelated.jsonl"), '{"type":"continued-in","sessionId":"x","continuedInSessionId":"y"}\n');
      writeFileSync(join(dir, "new-one.jsonl"), '{"type":"user"}\n');
      expect(scanPredecessorTranscript(join(dir, "new-one.jsonl"), "new-one")).toBe("old-one");
      expect(scanPredecessorTranscript(join(dir, "old-one.jsonl"), "old-one")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveRegisteredPredecessor walks to the nearest registered ancestor", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-cont-"));
    try {
      // Chain: gen0 -> gen1 -> gen2 (the hook knows only gen2).
      writeFileSync(join(dir, "gen0.jsonl"), `{"type":"continued-in","sessionId":"gen0","continuedInSessionId":"gen1"}\n`);
      writeFileSync(join(dir, "gen1.jsonl"), `{"type":"continued-in","sessionId":"gen1","continuedInSessionId":"gen2"}\n`);
      writeFileSync(join(dir, "gen2.jsonl"), '{"type":"user"}\n');
      // Nothing registered -> null.
      expect(resolveRegisteredPredecessor(join(dir, "gen2.jsonl"), "gen2", () => null)).toBeNull();
      // gen1 registered -> adopt gen1.
      expect(resolveRegisteredPredecessor(join(dir, "gen2.jsonl"), "gen2", (id) => (id === "gen1" ? "mcp_gen1" : null))).toBe("mcp_gen1");
      // Only gen0 registered -> walk through gen1 and adopt gen0.
      expect(resolveRegisteredPredecessor(join(dir, "gen2.jsonl"), "gen2", (id) => (id === "gen0" ? "mcp_gen0" : null))).toBe("mcp_gen0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("continueSession moves the identity, mail, anchors, and tombstone", () => {
    reg("ses_old_cont", "oldname");
    const anchor = db.registerChatSession("ses_old_cont", "p", null, "mcp");
    if (!anchor.ok) throw new Error(`anchor registration failed: ${anchor.error}`);
    const expectedName = anchor.name;
    reg("ses_peer_cont", "peername");
    db.sendChatMessage("ses_peer_cont", "ses_old_cont", "mail for you");
    db.sendChatMessage("ses_old_cont", "ses_peer_cont", "and one back");
    db.recordChatHostPid(999, "ses_old_cont");

    db.continueChatSession("ses_old_cont", "ses_new_cont");
    // The row is gone from the old key...
    expect(db.findChatSession("ses_old_cont")).toBeNull();
    // ...and lives on the new key under the SAME name, with the mail.
    const row = db.findChatSession("ses_new_cont");
    expect(row?.name).toBe(expectedName);
    const mail = db.readChatMessages("ses_new_cont");
    expect(mail.length).toBe(1); // the peer's unread mail followed
    // The host-pid anchor points at the new key.
    expect(db.findChatSessionByHostPid(999, 600)).toBe("ses_new_cont");

    // A leave tombstone follows the conversation too. (One is created by
    // unregistering, which deletes the row - so it is seeded directly here
    // to test the migration of a tombstone coexisting with a live row.)
    const raw = new Database(dbPath!);
    raw.run(
      "INSERT INTO chat_leave_tombstones (session_id, left_at) VALUES (?, ?)",
      ["ses_new_cont", cutoffAgo(1)],
    );
    raw.close();
    db.continueChatSession("ses_new_cont", "ses_newer_cont");
    expect(db.hasChatLeaveTombstone("ses_new_cont")).toBe(false);
    expect(db.hasChatLeaveTombstone("ses_newer_cont")).toBe(true);
  });

  test("continueSession with no old row is a no-op", () => {
    db.continueChatSession("ses_never_was", "ses_whatever");
    expect(db.findChatSession("ses_whatever")).toBeNull();
  });
});

describe("chat name reclaim after reap", () => {
  test("a reaped auto session reclaims its name; other sessions never do", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-reclaim-"));
    // ThatchDB owns the schema; the store shares the file (WAL, like prod).
    const schemaDb = new ThatchDB(join(dir, "test.db"));
    schemaDb.close();
    const raw = new Database(join(dir, "test.db"));
    const store = new ChatStore(raw);
    // Backdate the row so the 7-day auto TTL sees it as prunable - the
    // register path stamps last_seen with now. One extra day keeps the
    // row strictly older than the cutoff (same-second equality is not
    // < cutoff).
    const expire = () => raw.run("UPDATE chat_sessions SET last_seen = ?", [cutoffAgo((CHAT_AUTO_TTL_DAYS + 1) * 24 * 60)]);
    const first = store.register("ses_reap_me", "/proj", null, "opencode");
    expect(first.ok).toBe(true);
    const name = (first as { ok: true; name: string }).name;

    // The reaper removes the row and records the claim.
    expire();
    store.pruneStaleAuto(cutoffAgo(CHAT_AUTO_TTL_DAYS * 24 * 60));
    expect(store.find(name)).toBeNull();

    // The SAME session id re-registers: reclaims its old name.
    const again = store.register("ses_reap_me", "/proj", null, "opencode");
    expect(again.ok).toBe(true);
    expect((again as { ok: true; name: string }).name).toBe(name);

    // A DIFFERENT session never receives that name: the claim was consumed,
    // and the counter only moves forward.
    const other = store.register("ses_other", "/proj", null, "opencode");
    expect(other.ok).toBe(true);
    expect((other as { ok: true; name: string }).name).not.toBe(name);

    // Reap again: the claim is re-recorded for the same session, so a
    // second crash-resume still reclaims.
    expire();
    store.pruneStaleAuto(cutoffAgo(CHAT_AUTO_TTL_DAYS * 24 * 60));
    const third = store.register("ses_reap_me", "/proj", null, "opencode");
    expect(third.ok).toBe(true);
    expect((third as { ok: true; name: string }).name).toBe(name);
    rmSync(dir, { recursive: true, force: true });
  });
});
