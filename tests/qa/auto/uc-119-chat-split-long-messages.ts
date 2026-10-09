import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../tests/mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-119: chat_send auto-splits an oversized body into marker-decorated
 * parts.
 *
 * Automatable: yes - the chat tools execute against a temp-dir SQLite
 * database with no host process. A body over 10k characters used to be
 * refused with no deterministic way to split it; it now travels as several
 * messages whose markers tell the reader to assemble the whole before
 * acting, the tool output reports the split so a caller cannot mistake it
 * for a single delivery, and the parts arrive as one grouped notification.
 */

const OVERSIZED_BODY = `${"A".repeat(1_900)}\n\n${"B".repeat(1_900)}`;

const useCase: UseCase = {
  name: "UC-119-chat-split-long-messages",
  preconditions: [
    "- No prerequisites beyond the source tree; the chat store runs on a temp-dir database.",
  ].join("\n"),
  steps: [
    "1. Register two sessions through the chat_register tool.",
    "2. Send a two-part body (~17.8k characters) from one to the other with chat_send.",
    "3. Read the recipient's inbox and check the markers, row count, and tool output.",
  ].join("\n"),
  expected: [
    "- The send succeeds and reports SENT AS 2 PARTS.",
    "- The recipient's mailbox holds exactly 2 rows: part 1 prefixed \"(message 1 of 2)\" and suffixed \"(continued in next message)\", part 2 plain.",
    "- The recipient would be woken once for the whole batch (pending notification count 2, grouped by the poller).",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
    const host = { sessionID: "ses_uc119", agent: "build" };

    const dbDir = mkdtempSync(join(tmpdir(), "thatch-uc119-"));
    const db = new ThatchDB(join(dbDir, "uc119.db"));
    try {
      const toolCtx: CoreContext = {
        db,
        model: new MockEmbeddingModel(),
        defaultStore: "test-owner/test-repo",
      };

      await findTool("chat_register").execute({}, toolCtx, host);
      const otherHost = { sessionID: "ses_uc119_other", agent: "build" };
      const other = await findTool("chat_register").execute({}, toolCtx, otherHost);
      const otherName = (String(other).match(/\[registered\] (.+)/) ?? [])[1];
      if (!otherName) {
        console.log(`  FAIL: could not read the registered name from: ${other}`);
        return "FAIL";
      }

      const sent = await findTool("chat_send").execute({ to: otherName, body: OVERSIZED_BODY }, toolCtx, host);
      if (typeof sent !== "string" || !sent.includes("[sent]") || !sent.includes("SENT AS 2 PARTS")) {
        console.log(`  FAIL: the split send should report SENT AS 2 PARTS: ${sent}`);
        return "FAIL";
      }

      // The mailbox holds both parts and nothing else.
      const status = db.chatMessageStatus("ses_uc119_other");
      if (!status.registered || status.total !== 2) {
        console.log(`  FAIL: expected 2 messages in the recipient's mailbox, got registered=${status.registered} total=${status.registered ? status.total : "n/a"}`);
        return "FAIL";
      }

      // The wake machinery sees the batch as ordinary mail: 2 pending rows
      // for one recipient, which the poller groups into ONE nudge. Checked
      // BEFORE chat_read - reading stamps rows read and they stop being
      // pending.
      const pending = db.pendingChatNotifications(["ses_uc119_other"], new Date(Date.now() + 60_000).toISOString());
      if (pending.length !== 2) {
        console.log(`  FAIL: expected 2 pending notification rows for the recipient, got ${pending.length}`);
        return "FAIL";
      }
      const toSessions = new Set(pending.map((p) => p.to_session));
      if (toSessions.size !== 1) {
        console.log(`  FAIL: all parts should share one recipient (the poller's grouping key), got ${toSessions.size}`);
        return "FAIL";
      }

      const inbox = db.readChatMessages("ses_uc119_other");
      const first = inbox[0]?.body ?? "";
      const second = inbox[1]?.body ?? "";
      if (!first.startsWith("(message 1 of 2)\n\n") || !first.endsWith("\n\n(continued in next message)")) {
        console.log(`  FAIL: part 1 should carry the of-N prefix and the continuation suffix`);
        return "FAIL";
      }
      if (second !== "B".repeat(1_900)) {
        console.log(`  FAIL: part 2 should be the plain remainder of the body`);
        return "FAIL";
      }
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }

    return "PASS";
  },
};

registerUseCase(useCase);
