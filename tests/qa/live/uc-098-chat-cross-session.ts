import { Database } from "bun:sqlite";
import { registerUseCase, opencodeRunArgs, type UseCase, type QaContext, type UseCaseResult } from "../runner";

/**
 * UC-098: Cross-session chat between two real opencode sessions.
 *
 * Live: two sequential `opencode run` sessions share one fixture (and one
 * thatch.db). Names are assigned by thatch (pool name plus counter), never
 * chosen, so the test learns session one's name from the shared database
 * after it registers, then tells session two to message that name. The
 * assertion reads the database directly: both directory rows exist with
 * distinct session ids and the message landed in session one's inbox
 * unread. The wake-up half of the flow (idle delivery via promptAsync)
 * cannot run here - session one's host process exits when its run completes, and
 * by design only the recipient's host delivers - so it is covered by the
 * user doc workflow and UC-097's mocked poller.
 */

const useCase: UseCase = {
  name: "UC-098-chat-cross-session",
  // Custom run that spawns `opencode run` itself - declared hosts put it in
  // the QA matrix (one leg per discovered install).
  hosts: ["v1", "v2"],
  preconditions: [
    "- `opencode` on PATH and VENICE_API_KEY set (live opencode sessions)",
    "- Two sequential sessions share the fixture's THATCH_DB_PATH",
  ].join("\n"),
  steps: [
    "1. Session A registers in the chat directory and reports its assigned name.",
    "2. Read A's assigned name from the shared thatch.db.",
    "3. Session B registers and sends A a message addressed to that name.",
    "4. Read the shared thatch.db: assert both directory rows and the message row.",
  ].join("\n"),
  expected: [
    "- chat_sessions contains two rows with assigned <pool-slug>-<counter> names and distinct session ids.",
    "- chat_messages contains one row from B's session to A's session, read_at NULL.",
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
      const { args, cwd } = opencodeRunArgs(ctx, prompt);
      const proc = Bun.spawn(args, {
        cwd,
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

    const assignedName = /^[\p{L}\p{N}-]+-\d{5}$/u;
    const rows = () =>
      new Database(ctx.env.THATCH_DB_PATH, { readonly: true })
        .query("SELECT session_id, name FROM chat_sessions ORDER BY registered_at")
        .all() as Array<{ session_id: string; name: string }>;

    // Session A: register with no arguments; thatch assigns the name.
    const outA = await spawnSession(
      "Call thatch_chat_register with no arguments. Report the tool's exact output, then stop.",
    );
    if (!outA.includes("[registered] ")) {
      console.log(`  FAIL: session A did not register: ${outA.slice(0, 400)}`);
      return "FAIL";
    }
    // `opencode run` sessions may also auto-register on idle; the row we
    // want is whichever the explicit call produced, so take the directory
    // as it stands and require exactly one A-side row.
    const afterA = rows();
    if (afterA.length !== 1 || !assignedName.test(afterA[0].name)) {
      console.log(`  FAIL: expected one assigned-name row after session A, got ${JSON.stringify(afterA)}`);
      return "FAIL";
    }
    const alpha = afterA[0];

    // Session B: register, then message A by its assigned name.
    const outB = await spawnSession(
      "Call thatch_chat_register with no arguments. Then call thatch_chat_send " +
      `with to="${alpha.name}" and body="ping from beta". Report both tools' exact outputs, then stop.`,
    );
    if (!outB.includes("[registered] ")) {
      console.log(`  FAIL: session B did not register: ${outB.slice(0, 400)}`);
      return "FAIL";
    }
    if (!outB.includes(`[sent] to ${alpha.name}`)) {
      console.log(`  FAIL: session B did not send: ${outB.slice(0, 400)}`);
      return "FAIL";
    }

    // Assert against the shared database the plugin wrote through.
    const db = new Database(ctx.env.THATCH_DB_PATH, { readonly: true });
    try {
      const sessions = rows();
      const beta = sessions.find((s) => s.session_id !== alpha.session_id);
      if (sessions.length !== 2 || !beta || !assignedName.test(beta.name)) {
        console.log(`  FAIL: expected two assigned-name rows, got ${JSON.stringify(sessions)}`);
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
        console.log("  FAIL: message was read - session A's host process is gone, nothing should have drained it");
        return "FAIL";
      }
      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
