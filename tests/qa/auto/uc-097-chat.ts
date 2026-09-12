import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { registerUseCase, type UseCase } from "../runner";
import { TOOL_DEFS } from "../../../src/tool-defs";
import { ThatchDB } from "../../../src/db";
import { ChatPoller, nowIso, isoMinutesAgo as cutoffAgo } from "../../../src/chat";
import { CHAT_NAME_POOL } from "../../../src/chat-names";

/**
 * UC-097: Cross-session chat round-trip.
 *
 * Automatable: yes - the store is real SQLite in a tempdir and the poller
 * takes injected deliver/canDeliver functions, so the full lifecycle
 * (register, send, gate, deliver, read, re-nudge, rate cap, unregister)
 * runs with no network and no opencode session. The live cross-session path
 * (two real sessions exchanging a message) is UC-098.
 */

const useCase: UseCase = {
  name: "UC-097-chat",
  preconditions: [
    "- No prerequisites beyond the source tree; the poller's delivery callback is a mock.",
  ].join("\n"),
  steps: [
    "1. Verify the chat tools are opencode-only in TOOL_DEFS.",
    "2. Register two sessions; confirm name collisions are rejected, including case variants.",
    "3. Assign names from the built-in pool; confirm draws are unused, distinct, and sensitive to custom claims.",
    "4. Send a message and confirm send validation (ghost recipient, unregistered sender, self-send).",
    "5. Poll with the delivery gate closed; confirm messages stay pending.",
    "6. Open the gate; confirm one grouped wake prompt with sender names, and messages marked delivered.",
    "7. Read the inbox; confirm it drains and stamps read.",
    "8. Confirm the re-nudge path re-queues delivered-but-unread mail, and the rate cap blocks repeats.",
    "9. Unregister; confirm message history survives and wake prompts stop for the unregistered recipient.",
  ].join("\n"),
  expected: [
    "- chat_register, chat_list, chat_send, chat_read, chat_unregister, and chat_broadcast are marked opencodeOnly.",
    "- A name can only be claimed by one session, case-insensitively; lookups and message addressing follow the same rule.",
    "- Pool assignment (register without a name) draws an unused pool name, never repeats a draw, and skips names claimed by custom registrations.",
    "- Send requires both endpoints registered and distinct, and returns the resolved recipient.",
    "- The poller delivers only when canDeliver passes; undelivered mail stays pending.",
    "- Delivery groups a recipient's messages into one prompt (senders + count) and stamps delivered_at.",
    "- read drains the inbox oldest-first and stamps read_at on exactly the returned rows; read mail is never re-nudged.",
    "- The per-recipient nudge cap stops repeated wake prompts within the hour window.",
    "- Unregister keeps messages as history (departed senders degrade to unknown names) and stops wake selection for the unregistered recipient's unread mail.",
  ].join("\n"),

  async run() {
    // Step 1: chat tools are opencode-only with bare names.
    const chatTools = TOOL_DEFS.filter((t) => t.name.startsWith("chat_"));
    if (chatTools.length !== 6) {
      console.log(`  FAIL: expected 6 chat tools, got ${chatTools.length}`);
      return "FAIL";
    }
    if (!chatTools.every((t) => t.opencodeOnly)) {
      console.log("  FAIL: chat tools must be opencodeOnly (identity comes from the host session)");
      return "FAIL";
    }

    const dbDir = mkdtempSync(join(tmpdir(), "thatch-uc097-"));
    const db = new ThatchDB(join(dbDir, "chat.db"));
    // Raw connection for aging timestamps past the re-nudge window.
    const raw = new Database(join(dbDir, "chat.db"));
    // The mock's closure appends to `deliveries`; reading the count
    // through a helper keeps the assertions readable and the length reads
    // fresh at every call site.
    const deliveries: Array<{ sessionID: string; senders: string[]; count: number }> = [];
    const delivered = (): number => deliveries.length;

    try {
      // Step 2: registration and name collisions.
      if (!db.registerChatSession("ses_alpha", "alpha", "acme/widgets", null).ok) {
        console.log("  FAIL: alpha registration failed");
        return "FAIL";
      }
      if (!db.registerChatSession("ses_beta", "beta", "acme/widgets", null).ok) {
        console.log("  FAIL: beta registration failed");
        return "FAIL";
      }
      if (db.registerChatSession("ses_gamma", "alpha", "p", null).ok) {
        console.log("  FAIL: name collision was accepted");
        return "FAIL";
      }
      // Case variants collide too: uniqueness is case-insensitive.
      if (db.registerChatSession("ses_gamma", "ALPHA", "p", null).ok) {
        console.log("  FAIL: case-variant name collision was accepted");
        return "FAIL";
      }
      // Lookups and addressing follow the same rule.
      if (db.findChatSession("AlPhA")?.session_id !== "ses_alpha") {
        console.log("  FAIL: case-insensitive lookup failed");
        return "FAIL";
      }
      if (!db.sendChatMessage("ses_beta", "ALPHA", "cased ping").ok) {
        console.log("  FAIL: case-insensitive addressing failed");
        return "FAIL";
      }

      // Step 3: pool assignment. Draws come from the pool, are unused, and differ.
      const drawA = db.assignChatName("ses_pool_a", "p", null);
      if (!drawA.ok || !CHAT_NAME_POOL.includes(drawA.name)) {
        console.log(`  FAIL: pool draw invalid: ${JSON.stringify(drawA)}`);
        return "FAIL";
      }
      const drawB = db.assignChatName("ses_pool_b", "p", null);
      if (!drawB.ok || drawB.name === drawA.name) {
        console.log("  FAIL: two pool draws collided or the second failed");
        return "FAIL";
      }
      // A custom claim removes that name from future draws. Drain the pool
      // to exhaustion; the claimed name must never be drawn. Two draws
      // above (drawA, drawB) plus the custom claim account for the three
      // names removed from circulation, so the drain count cross-checks.
      // Claim a name neither draw picked, or the claim legitimately
      // collides and the use case would flake (~2% of runs).
      const claimed = CHAT_NAME_POOL.find((n) => n !== drawA.name && n !== drawB.name)!;
      if (!db.registerChatSession("ses_pool_c", claimed, "p", null).ok) {
        console.log("  FAIL: custom claim of a free pool name was rejected");
        return "FAIL";
      }
      let draws = 0;
      for (;;) {
        const draw = db.assignChatName(`ses_drain_${draws}`, "p", null);
        if (!draw.ok) break;
        draws++;
        if (draw.name === claimed) {
          console.log("  FAIL: a custom-claimed pool name was drawn again");
          return "FAIL";
        }
      }
      if (draws !== CHAT_NAME_POOL.length - 3) {
        console.log(`  FAIL: expected ${CHAT_NAME_POOL.length - 3} free pool names, drew ${draws}`);
        return "FAIL";
      }

      // Step 4: send validation.
      if (db.sendChatMessage("ses_alpha", "ghost", "hi").ok) {
        console.log("  FAIL: send to unregistered recipient accepted");
        return "FAIL";
      }
      if (db.sendChatMessage("ses_nobody", "beta", "hi").ok) {
        console.log("  FAIL: send from unregistered sender accepted");
        return "FAIL";
      }
      if (db.sendChatMessage("ses_alpha", "alpha", "note to self").ok) {
        console.log("  FAIL: self-send accepted");
        return "FAIL";
      }
      if (!db.sendChatMessage("ses_alpha", "beta", "ping from alpha").ok) {
        console.log("  FAIL: valid send rejected");
        return "FAIL";
      }

      // Steps 5-6: gated delivery with a mocked poller. The poller is never
      // started - deliverPending is driven directly, so no timer exists.
      let gateOpen = false;
      const poller = new ChatPoller({
        store: db,
        hostedSessions: () => ["ses_beta"],
        deliver: async (sessionID, senders, count) => {
          deliveries.push({ sessionID, senders, count });
        },
        canDeliver: () => gateOpen,
        pollIntervalMs: 60_000,
      });
      await poller.deliverPending();
      if (delivered() !== 0) {
        console.log("  FAIL: delivered while the gate was closed");
        return "FAIL";
      }
      gateOpen = true;
      await poller.deliverPending();
      if (delivered() !== 1 || deliveries[0].sessionID !== "ses_beta" || deliveries[0].senders[0] !== "alpha") {
        console.log(`  FAIL: unexpected delivery: ${JSON.stringify(deliveries)}`);
        return "FAIL";
      }
      if (db.pendingChatNotifications(["ses_beta"], cutoffAgo(15)).length !== 0) {
        console.log("  FAIL: delivered message still pending");
        return "FAIL";
      }

      // Step 7: read drains and stamps.
      const inbox = db.readChatMessages("ses_beta");
      if (inbox.length !== 1 || inbox[0].body !== "ping from alpha" || inbox[0].from_name !== "alpha") {
        console.log(`  FAIL: unexpected inbox: ${JSON.stringify(inbox)}`);
        return "FAIL";
      }
      if (db.readChatMessages("ses_beta").length !== 0) {
        console.log("  FAIL: inbox did not drain");
        return "FAIL";
      }

      // Step 8: re-nudge and the rate cap.
      if (!db.sendChatMessage("ses_alpha", "beta", "second ping").ok) {
        console.log("  FAIL: second send rejected");
        return "FAIL";
      }
      await poller.deliverPending();
      if (delivered() !== 2) {
        console.log("  FAIL: second message was not delivered");
        return "FAIL";
      }
      raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z' WHERE read_at IS NULL");
      await poller.deliverPending();
      if (delivered() !== 3) {
        console.log("  FAIL: re-nudge did not fire after the window passed");
        return "FAIL";
      }
      // A fresh poller capped at one nudge per hour: its first delivery
      // passes, the second (aged again) is blocked by the cap.
      const capped = new ChatPoller({
        store: db,
        hostedSessions: () => ["ses_beta"],
        deliver: async (sessionID, senders, count) => {
          deliveries.push({ sessionID, senders, count });
        },
        canDeliver: () => true,
        pollIntervalMs: 60_000,
        maxNudgesPerHour: 1,
      });
      raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z' WHERE read_at IS NULL");
      const before = delivered();
      await capped.deliverPending();
      if (delivered() !== before + 1) {
        console.log("  FAIL: capped poller did not deliver its single allowed nudge");
        return "FAIL";
      }
      raw.run("UPDATE chat_messages SET delivered_at = '2020-01-01T00:00:00Z' WHERE read_at IS NULL");
      await capped.deliverPending();
      if (delivered() !== before + 1) {
        console.log("  FAIL: rate cap did not block the second nudge within the hour");
        return "FAIL";
      }

      // Step 9: unregister keeps history - and unregistering the recipient
      // stops wake selection for kept-but-unread mail.
      db.unregisterChatSession("ses_alpha");
      if (db.findChatSession("alpha")) {
        console.log("  FAIL: unregister left the directory row behind");
        return "FAIL";
      }
      if (db.unreadChatCount("ses_beta") !== 1) {
        console.log("  FAIL: message history lost after sender unregistered");
        return "FAIL";
      }
      const history = db.pendingChatNotifications(["ses_beta"], nowIso());
      if (history.length !== 1 || history[0].from_name !== null) {
        console.log("  FAIL: departed sender did not degrade to unknown name");
        return "FAIL";
      }
      // The recipient leaving the directory stops wake prompts for its
      // kept-but-unread mail - the chat_unregister tool's promise.
      db.unregisterChatSession("ses_beta");
      if (db.unreadChatCount("ses_beta") !== 1) {
        console.log("  FAIL: unregistering the recipient lost its mail");
        return "FAIL";
      }
      if (db.pendingChatNotifications(["ses_beta"], nowIso()).length !== 0) {
        console.log("  FAIL: unregistered recipient still selectable for wake prompts");
        return "FAIL";
      }
      return "PASS";
    } finally {
      db.close();
      raw.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
