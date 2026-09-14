import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { registerUseCase, type UseCase } from "../runner";
import { TOOL_DEFS } from "../../../src/tool-defs";
import { ThatchDB } from "../../../src/db";
import { ChatPoller, nowIso, isoMinutesAgo as cutoffAgo } from "../../../src/chat";

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
    "2. Register sessions with assigned names; confirm the slug-counter format, per-base counters, and case-insensitive lookups/addressing.",
    "3. Confirm name assignment: distinct sessions with the same base get distinct counters, and a title-less registration draws a pool slug.",
    "4. Send a message and confirm send validation (ghost recipient, unregistered sender, self-send).",
    "5. Poll with the delivery gate closed; confirm messages stay pending.",
    "6. Open the gate; confirm one grouped wake prompt with sender names, and messages marked delivered.",
    "7. Read the inbox; confirm it drains and stamps read.",
    "8. Confirm the re-nudge path re-queues delivered-but-unread mail, and the rate cap blocks repeats.",
    "9. Unregister; confirm message history survives and wake prompts stop for the unregistered recipient.",
  ].join("\n"),
  expected: [
    "- chat_register, chat_list, chat_send, chat_read, chat_unregister, chat_broadcast, and chat_status are shared tools (no opencodeOnly flag): MCP hosts pass the hook-assigned name as `as`, and wake-up delivery is the only opencode-only part.",
    "- Names are assigned by thatch as <slug>-<counter>; the same base on two sessions yields distinct counters, and lookups/message addressing are case-insensitive.",
    "- A title-less registration draws a pool slug as the base, still counter-suffixed.",
    "- Send requires both endpoints registered and distinct, and returns the resolved recipient.",
    "- The poller delivers only when canDeliver passes; undelivered mail stays pending.",
    "- Delivery groups a recipient's messages into one prompt (senders + count) and stamps delivered_at.",
    "- read drains the inbox oldest-first and stamps read_at on exactly the returned rows; read mail is never re-nudged.",
    "- The per-recipient nudge cap stops repeated wake prompts within the hour window.",
    "- Unregister keeps messages as history (departed senders degrade to unknown names) and stops wake selection for the unregistered recipient's unread mail.",
  ].join("\n"),

  async run() {
    // Step 1: chat tools are shared (bare names, no opencodeOnly flag) -
    // MCP hosts register with a self-declared identity. The opencodeOnly
    // set is exactly the session and watch tools.
    const chatTools = TOOL_DEFS.filter((t) => t.name.startsWith("chat_"));
    if (chatTools.length !== 7) {
      console.log(`  FAIL: expected 7 chat tools, got ${chatTools.length}`);
      return "FAIL";
    }
    if (chatTools.some((t) => t.opencodeOnly)) {
      console.log("  FAIL: chat tools must be shared (they work on MCP hosts with an `as` identity)");
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
      // Step 2: registration with assigned names. Names are minted as
      // <slug>-<counter>; the same base on two sessions draws distinct
      // counters, so there is no claim/collision path.
      const alpha = db.registerChatSession("ses_alpha", "acme/widgets", null, "opencode", "alpha");
      if (!alpha.ok || alpha.name !== "alpha-00001") {
        console.log(`  FAIL: alpha registration invalid: ${JSON.stringify(alpha)}`);
        return "FAIL";
      }
      const beta = db.registerChatSession("ses_beta", "acme/widgets", null, "opencode", "beta");
      if (!beta.ok || beta.name !== "beta-00001") {
        console.log(`  FAIL: beta registration invalid: ${JSON.stringify(beta)}`);
        return "FAIL";
      }
      // The same base on a different session gets the next counter value
      // instead of colliding - assignment never fails on a taken base.
      const gamma = db.registerChatSession("ses_gamma", "p", null, "opencode", "alpha");
      if (!gamma.ok || gamma.name !== "alpha-00002") {
        console.log(`  FAIL: same-base assignment invalid: ${JSON.stringify(gamma)}`);
        return "FAIL";
      }
      // Lookups and addressing are case-insensitive.
      if (db.findChatSession("ALPHA-00001")?.session_id !== "ses_alpha") {
        console.log("  FAIL: case-insensitive lookup failed");
        return "FAIL";
      }
      if (!db.sendChatMessage("ses_beta", "ALPHA-00001", "cased ping").ok) {
        console.log("  FAIL: case-insensitive addressing failed");
        return "FAIL";
      }

      // Step 3: a title-less registration draws a pool slug as the base,
      // still counter-suffixed; two draws never share a name.
      const drawA = db.registerChatSession("ses_pool_a", "p", null, "opencode");
      if (!drawA.ok || !/^[\p{L}\p{N}-]+-\d{5}$/u.test(drawA.name)) {
        console.log(`  FAIL: pool-slug draw invalid: ${JSON.stringify(drawA)}`);
        return "FAIL";
      }
      const drawB = db.registerChatSession("ses_pool_b", "p", null, "opencode");
      if (!drawB.ok || drawB.name === drawA.name) {
        console.log("  FAIL: two pool-slug draws collided or the second failed");
        return "FAIL";
      }

      // Step 4: send validation.
      if (db.sendChatMessage("ses_alpha", "ghost", "hi").ok) {
        console.log("  FAIL: send to unregistered recipient accepted");
        return "FAIL";
      }
      if (db.sendChatMessage("ses_nobody", beta.name, "hi").ok) {
        console.log("  FAIL: send from unregistered sender accepted");
        return "FAIL";
      }
      if (db.sendChatMessage("ses_alpha", "ses_alpha", "note to self").ok) {
        console.log("  FAIL: self-send accepted");
        return "FAIL";
      }
      if (!db.sendChatMessage("ses_alpha", beta.name, "ping from alpha").ok) {
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
      if (delivered() !== 1 || deliveries[0].sessionID !== "ses_beta" || deliveries[0].senders[0] !== alpha.name) {
        console.log(`  FAIL: unexpected delivery: ${JSON.stringify(deliveries)}`);
        return "FAIL";
      }
      if (db.pendingChatNotifications(["ses_beta"], cutoffAgo(15)).length !== 0) {
        console.log("  FAIL: delivered message still pending");
        return "FAIL";
      }

      // Step 7: read drains and stamps.
      const inbox = db.readChatMessages("ses_beta");
      if (inbox.length !== 1 || inbox[0].body !== "ping from alpha" || inbox[0].from_name !== alpha.name) {
        console.log(`  FAIL: unexpected inbox: ${JSON.stringify(inbox)}`);
        return "FAIL";
      }
      if (db.readChatMessages("ses_beta").length !== 0) {
        console.log("  FAIL: inbox did not drain");
        return "FAIL";
      }

      // Step 8: re-nudge and the rate cap.
      if (!db.sendChatMessage("ses_alpha", beta.name, "second ping").ok) {
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
      if (db.findChatSession(alpha.name)) {
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
