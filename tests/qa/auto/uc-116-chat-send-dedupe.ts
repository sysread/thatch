import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../tests/mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/**
 * UC-116: chat_send dedupes a retried send.
 *
 * Automatable: yes - the chat tools execute against a temp-dir SQLite
 * database with no host process. A harness that times out a chat_send that
 * actually committed retries the call; without dedupe the identical body
 * landed twice (observed 2026-10-07 as two chat_messages rows 8s apart,
 * stamped delivered in one pass). The retry now succeeds without a second
 * row, and its output says so.
 */

const useCase: UseCase = {
  name: "UC-116-chat-send-dedupe",
  preconditions: [
    "- No prerequisites beyond the source tree; the chat store runs on a temp-dir database.",
  ].join("\n"),
  steps: [
    "1. Register two sessions through the chat_register tool.",
    "2. Send a message from one to the other twice with the same body.",
    "3. Confirm the first send reports normal delivery, the retry reports success with the duplicate-suppression note, and exactly one row exists.",
    "4. Read the recipient's inbox, resend the identical body, and confirm it delivers (no suppression note).",
  ].join("\n"),
  expected: [
    "- The retried send returns success (a retrying harness must not error) with a DUPLICATE SUPPRESSED note.",
    "- After the recipient reads, an identical repeat delivers: suppression is a read-state condition, not just a timer.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
    const host = { sessionID: "ses_uc116", agent: "build" };

    const dbDir = mkdtempSync(join(tmpdir(), "thatch-uc116-"));
    const db = new ThatchDB(join(dbDir, "uc116.db"));
    try {
      const toolCtx: CoreContext = {
        db,
        model: new MockEmbeddingModel(),
        defaultStore: "test-owner/test-repo",
      };

      await findTool("chat_register").execute({}, toolCtx, host);
      const otherHost = { sessionID: "ses_uc116_other", agent: "build" };
      const other = await findTool("chat_register").execute({}, toolCtx, otherHost);
      const otherName = (String(other).match(/\[registered\] (.+)/) ?? [])[1];
      if (!otherName) {
        console.log(`  FAIL: could not read the registered name from: ${other}`);
        return "FAIL";
      }

      const first = await findTool("chat_send").execute({ to: otherName, body: "uc116 ping" }, toolCtx, host);
      if (typeof first !== "string" || !first.includes("[sent]") || first.includes("DUPLICATE SUPPRESSED")) {
        console.log(`  FAIL: first send should be a normal [sent]: ${first}`);
        return "FAIL";
      }
      const retry = await findTool("chat_send").execute({ to: otherName, body: "uc116 ping" }, toolCtx, host);
      if (typeof retry !== "string" || !retry.includes("[sent]") || !retry.includes("DUPLICATE SUPPRESSED")) {
        console.log(`  FAIL: retried send should succeed with the suppression note: ${retry}`);
        return "FAIL";
      }
      // Read-state condition: once the recipient READ the first copy, an
      // identical repeat delivers - it is presumptively an intentional
      // resend, not a retried harness call.
      const drained = await findTool("chat_read").execute({}, toolCtx, otherHost);
      if (typeof drained !== "string" || !drained.includes("uc116 ping")) {
        console.log(`  FAIL: the recipient's drain should show the message: ${drained}`);
        return "FAIL";
      }
      const afterRead = await findTool("chat_send").execute({ to: otherName, body: "uc116 ping" }, toolCtx, host);
      if (typeof afterRead !== "string" || !afterRead.includes("[sent]") || afterRead.includes("DUPLICATE SUPPRESSED")) {
        console.log(`  FAIL: an identical repeat after the first was read should deliver: ${afterRead}`);
        return "FAIL";
      }

      // The recipient's mailbox shows the original plus the post-read
      // repeat - two rows, not three (the mid-window retry added nothing).
      const status = db.chatMessageStatus("ses_uc116_other");
      if (!status.registered || status.total !== 2) {
        console.log(`  FAIL: expected exactly 2 messages in the recipient's mailbox, got registered=${status.registered} total=${status.registered ? status.total : "n/a"}`);
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
