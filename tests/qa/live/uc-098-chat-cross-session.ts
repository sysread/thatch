import { Database } from "bun:sqlite";
import { registerUseCase, MODEL, type UseCase, type QaContext, type UseCaseResult } from "../runner";

/**
 * UC-098: Cross-session chat between two real opencode sessions.
 *
 * Live: two sequential `opencode run` sessions share one fixture (and one
 * thatch.db). Session one registers as "alpha"; session two registers as
 * "beta" and sends alpha a message. The assertion reads the shared database
 * directly: both directory rows exist and the message landed in alpha's
 * inbox unread. The wake-up half of the flow (idle delivery via promptAsync)
 * cannot run here - alpha's host process exits when its run completes, and
 * by design only the recipient's host delivers - so it is covered by the
 * user doc workflow and UC-097's mocked poller.
 */

const useCase: UseCase = {
  name: "UC-098-chat-cross-session",
  preconditions: [
    "- `opencode` on PATH and VENICE_API_KEY set (live opencode sessions)",
    "- Two sequential sessions share the fixture's THATCH_DB_PATH",
  ].join("\n"),
  steps: [
    "1. Session A registers in the chat directory as alpha.",
    "2. Session B registers as beta and sends alpha a message by name.",
    "3. Read the shared thatch.db: assert both directory rows and the message row.",
  ].join("\n"),
  expected: [
    "- chat_sessions contains alpha and beta with distinct session ids.",
    "- chat_messages contains one row from beta's session to alpha's session, read_at NULL.",
    "- Both sessions reported tool success in their output.",
  ].join("\n"),

  async run(ctx: QaContext): Promise<UseCaseResult> {
    // This use case spawns `opencode run` itself, so the runner's
    // no-custom-run PATH guard does not cover it. Skip rather than ENOENT
    // on machines without the binary, matching the runner's convention.
    const which = Bun.spawnSync(["sh", "-c", "command -v opencode"]);
    if (which.exitCode !== 0) {
      console.log("  [MANUAL] UC-098-chat-cross-session - skipped (opencode not on PATH)");
      return "MANUAL-ONLY";
    }

    const spawnSession = async (prompt: string): Promise<string> => {
      const proc = Bun.spawn(["opencode", "run", "--dir", ctx.dir, "--model", MODEL, "--auto", prompt], {
        env: ctx.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch { /* already dead */ }
      }, 570_000); // just under half the 20-min budget, so both sessions fit
      try {
        const [, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return stdout + stderr;
      } finally {
        clearTimeout(timer);
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }
    };

    // Session A: register as alpha.
    const outA = await spawnSession(
      "Call thatch_chat_register with the name \"alpha\". Report the tool's exact output, then stop.",
    );
    if (!outA.includes("[registered] alpha")) {
      console.log(`  FAIL: session A did not register: ${outA.slice(0, 400)}`);
      return "FAIL";
    }

    // Session B: register as beta, then message alpha by name.
    const outB = await spawnSession(
      "Call thatch_chat_register with the name \"beta\". Then call thatch_chat_send " +
      "with to=\"alpha\" and body=\"ping from beta\". Report both tools' exact outputs, then stop.",
    );
    if (!outB.includes("[registered] beta")) {
      console.log(`  FAIL: session B did not register: ${outB.slice(0, 400)}`);
      return "FAIL";
    }
    if (!outB.includes("[sent] to alpha")) {
      console.log(`  FAIL: session B did not send: ${outB.slice(0, 400)}`);
      return "FAIL";
    }

    // Assert against the shared database the plugin wrote through.
    const db = new Database(ctx.env.THATCH_DB_PATH, { readonly: true });
    try {
      const sessions = db
        .query("SELECT session_id, name FROM chat_sessions ORDER BY name")
        .all() as Array<{ session_id: string; name: string }>;
      const alpha = sessions.find((s) => s.name === "alpha");
      const beta = sessions.find((s) => s.name === "beta");
      if (!alpha || !beta) {
        console.log(`  FAIL: directory rows missing: ${JSON.stringify(sessions)}`);
        return "FAIL";
      }
      if (alpha.session_id === beta.session_id) {
        console.log("  FAIL: both registrations landed on one session id");
        return "FAIL";
      }
      const messages = db
        .query("SELECT from_session, to_session, body, read_at FROM chat_messages")
        .all() as Array<{ from_session: string; to_session: string; body: string; read_at: string | null }>;
      const ping = messages.find((m) => m.body === "ping from beta");
      if (!ping) {
        console.log(`  FAIL: message row missing: ${JSON.stringify(messages)}`);
        return "FAIL";
      }
      if (ping.from_session !== beta.session_id || ping.to_session !== alpha.session_id) {
        console.log(`  FAIL: message endpoints wrong: ${JSON.stringify(ping)}`);
        return "FAIL";
      }
      if (ping.read_at !== null) {
        console.log("  FAIL: message was read - alpha's host process is gone, nothing should have drained it");
        return "FAIL";
      }
      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
