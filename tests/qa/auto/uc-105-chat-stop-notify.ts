import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { registerUseCase, type UseCase } from "../runner";
import { ThatchDB } from "../../../src/db";
import { mcpSessionID } from "../../../src/chat";

/**
 * UC-105: Cursor stop-hook chat wake (chat-notify).
 *
 * The Cursor `stop` hook is the post-turn chat delivery channel for MCP
 * hosts: when the agent loop ends and the conversation has unread chat
 * mail, `thatch chat-notify` emits { followup_message }, which Cursor
 * auto-submits as the next user message - the MCP analog of opencode's
 * poller wake. This use case drives the real binary over a seeded DB and
 * pins the contract: {} when unregistered or nothing pending, the
 * pointer-only follow-up (sender names + count + system-notification
 * framing, never bodies) when mail is unread, delivered-stamp suppression
 * on the second run within the re-nudge window, and no continuation for
 * aborted turns.
 *
 * Automatable: yes - the hook is a subprocess over a seeded SQLite file.
 */

const useCase: UseCase = {
  name: "UC-105-chat-stop-notify",
  preconditions: [
    "- No prerequisites beyond the source tree; the hook runs the real CLI binary against a seeded DB.",
  ].join("\n"),
  steps: [
    "1. Run `thatch chat-notify` with a Cursor stop payload (conversation_id, status completed) for an unregistered conversation.",
    "2. Register the conversation's anchor identity and a peer, then have the peer send mail.",
    "3. Run chat-notify again; verify the followup_message names the sender and carries the system-notification framing.",
    "4. Run chat-notify once more; verify {} (the delivered stamp suppresses re-notification inside the re-nudge window).",
    "5. Run chat-notify with status aborted; verify {}.",
    "6. Run chat-notify with no stdin payload; verify {} and a clean exit.",
  ].join("\n"),
  expected: [
    "- Unregistered or empty-mailbox runs print exactly `{}` and exit 0 - no follow-up is ever auto-submitted without unread mail.",
    "- The unread-mail run prints `{ followup_message: ... }` naming the sender, with the pointer-only rule (no message bodies) and the system-notification framing.",
    "- The delivered stamp suppresses the second notification within the re-nudge window.",
    "- An aborted turn never auto-continues.",
  ].join("\n"),

  async run(ctx) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env };
    const dbPath = ctx.env.THATCH_DB_PATH;
    const dir = mkdtempSync(join(tmpdir(), "thatch-uc105-"));
    try {
      // No remote: the anchor registration and any peer rows must agree on
      // the project (detectRepo's basename fallback), independent of the
      // host's git url-rewrite config.
      await $`git init`.cwd(dir).quiet();

      const notify = async (payload?: object) => {
        const proc = Bun.spawn([bin, "chat-notify"], {
          env,
          cwd: dir,
          stdin: payload ? "pipe" : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        if (payload && proc.stdin) {
          proc.stdin.write(JSON.stringify(payload));
          proc.stdin.end();
        }
        await proc.exited;
        return { out: await new Response(proc.stdout).text(), code: proc.exitCode };
      };

      // Step 1: unregistered conversation -> {}.
      const unregistered = await notify({ conversation_id: "notify-uc-conv", status: "completed", loop_count: 0 });
      if (unregistered.code !== 0 || unregistered.out.trim() !== "{}") {
        console.log(`  FAIL: unregistered run expected '{{}}', got: ${unregistered.out}`);
        return "FAIL";
      }

      // Step 2: register the anchor + peer, peer sends mail.
      const db = new ThatchDB(dbPath);
      const anchor = mcpSessionID("notify-uc-conv");
      const reg = db.registerChatSession(anchor, dir.split("/").pop()!, null, "mcp");
      if (!reg.ok || !reg.name) {
        console.log(`  FAIL: anchor registration failed: ${JSON.stringify(reg)}`);
        return "FAIL";
      }
      const peer = db.registerChatSession("ses_notify_peer", dir.split("/").pop()!, null, "opencode");
      if (!peer.ok || !peer.name) {
        console.log(`  FAIL: peer registration failed: ${JSON.stringify(peer)}`);
        return "FAIL";
      }
      const sent = db.sendChatMessage("ses_notify_peer", reg.name, "hello stop hook");
      if (!sent.ok) {
        console.log(`  FAIL: peer send failed: ${JSON.stringify(sent)}`);
        return "FAIL";
      }
      db.close();

      // Step 3: unread mail -> followup_message, pointer-only + framing.
      // The notification names the sender by its assigned chat name.
      const notified = await notify({ conversation_id: "notify-uc-conv", status: "completed", loop_count: 0 });
      if (notified.code !== 0) {
        console.log(`  FAIL: chat-notify exited ${notified.code}`);
        return "FAIL";
      }
      let followup: string | undefined;
      try {
        followup = (JSON.parse(notified.out) as { followup_message?: string }).followup_message;
      } catch {
        // left undefined; the check below reports it
      }
      if (!followup?.includes(peer.name) || !followup.includes("system notification")) {
        console.log(`  FAIL: followup missing sender or framing. Output: ${notified.out.slice(-400)}`);
        return "FAIL";
      }
      if (followup.includes("hello stop hook")) {
        console.log("  FAIL: followup leaked the message body - notifications must be pointer-only");
        return "FAIL";
      }

      // Step 4: delivered stamp suppresses the immediate re-notification.
      const restamp = await notify({ conversation_id: "notify-uc-conv", status: "completed", loop_count: 1 });
      if (restamp.out.trim() !== "{}") {
        console.log(`  FAIL: second run should be suppressed, got: ${restamp.out}`);
        return "FAIL";
      }

      // Step 5: an aborted turn never auto-continues.
      const db2 = new ThatchDB(dbPath);
      db2.sendChatMessage("ses_notify_peer", reg.name, "second message while suppressed");
      db2.close();
      const aborted = await notify({ conversation_id: "notify-uc-conv", status: "aborted", loop_count: 0 });
      if (aborted.out.trim() !== "{}") {
        console.log(`  FAIL: aborted turn must not continue, got: ${aborted.out}`);
        return "FAIL";
      }

      // Step 6: no stdin payload (manual run / bare spawn) -> {} exit 0.
      const bare = await notify();
      if (bare.code !== 0 || bare.out.trim() !== "{}") {
        console.log(`  FAIL: bare run expected '{{}}' exit 0, got exit ${bare.code}: ${bare.out}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
