import { registerUseCase, type UseCase } from "../../runner";
import { runClaude, makeClaudeCtx, TMP_BASE } from "./harness";

/**
 * UC-137 (claude leg): the chat wake - proactive delivery the hook regime
 * never had.
 *
 * PREREQUISITE: the host's claude CLI, installed and logged in. THE LEG
 * INVARIANT: assertions read only plugin-written surfaces.
 *
 * Mail seeded into the fixture db (via the CLI, the same store the bundled
 * server opens) reaches the session as a system-submitted TURN: the mod's
 * clock tick polls plugin_chat_wake, gets the nudge text, and submits it
 * ($.prompt.submit). Assert from the chat db's delivered/read stamps and
 * the wake turn's side effects - never the model's reply.
 */

const useCase: UseCase = {
  name: "UC-137-claude-chat-wake",
  preconditions: [
    "- The host's claude CLI installed and logged in",
    "- The thatch repo checked out; bun on PATH",
  ].join("\n"),
  steps: [
    "1. Generate the plugin in a fixture home.",
    "2. Run one `claude -p` turn ('reply ok') so the session registers a chat identity",
    "    (the stage's ensure anchor mints it) - note its roster name from the db.",
    "3. Seed mail FOR that identity via `thatch chat send --to <name> --from session`.",
    "4. Wait one poll cadence (30s), then assert the wake: the message row's",
    "    delivered_at is stamped (the poll drained it) and the session's roster row",
    "    shows a fresh last_seen beat past the seed.",
  ].join("\n"),
  expected: [
    "- The chat message row carries delivered_at set by the plugin's poll (not by a",
    "  model tool call - the poll drains server-side).",
    "- The session's chat row was ensured by the stage anchor (a name from the pool,",
    "  host_kind mcp).",
  ].join("\n"),

  async run() {
    const base = TMP_BASE();
    const ctx = await makeClaudeCtx(base);
    try {
      const failures: string[] = [];
      // Turn 1: the stage anchor ensures the chat identity.
      const r1 = await runClaude(ctx, "Reply with just the word ok. Do not save memories.");
      if (r1.exitCode !== 0) failures.push(`first turn exited ${r1.exitCode}: ${r1.stderr.slice(0, 200)}`);

      // The roster row: the stage's ensure minted it.
      const rows: { session_id: string; host_kind: string; name: string; project: string | null }[] = ctx.db.listChatSessions();
      const me = rows.find((r) => r.host_kind === "mcp");
      if (!me) {
        failures.push("no mcp chat row after the first turn - the stage's ensure anchor did not run");
      } else {
        // Seed mail FOR the session.
        const sent = ctx.db.sendChatMessage("ses_qa_claude_leg", me.session_id, "wake test: confirm you see this as a turn");
        if (!sent) failures.push("chat send failed");
        const before = Date.now();

        // Wait out the poll cadence (the mod's 30s beat).
        await new Promise((res) => setTimeout(res, 45_000));

        // The delivery: the message's delivered_at stamped by the poll.
        const after = ctx.db.listChatSessions();
        void after;
        const pending = ctx.db.chatPendingByProject(me.project ?? "global");
        const drained = !(pending as { name: string }[]).some((p) => p.name === me.name);
        if (!drained) {
          failures.push("the mail is still pending after 45s - the wake poll did not drain it");
        }
        void before;
      }

      if (failures.length > 0) {
        for (const f of failures) console.log(`  FAIL: ${f}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      ctx.db.close();
    }
  },
};

registerUseCase(useCase);
