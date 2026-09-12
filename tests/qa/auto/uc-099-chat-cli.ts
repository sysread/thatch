import { $ } from "bun";
import { Database } from "bun:sqlite";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";

/**
 * UC-099: Chat CLI.
 *
 * Automatable: `thatch chat list` and `thatch chat tail --once` are pure
 * CLI reads over a controlled DB. Seeds registered sessions with topics
 * (fresh and stale), a direct message, a broadcast, and a departed sender,
 * then verifies the roster and the tail's sent-line rendering, including
 * the broadcast marker and the departed-sender fallback. The follow mode
 * (no --once) is a live loop and is covered by the user doc workflow.
 */

const useCase: UseCase = {
  name: "UC-099-chat-cli",
  preconditions: [
    "- Bun on PATH; thatch installed",
    "- A DB with registered sessions and seeded messages",
  ].join("\n"),
  steps: [
    "1. Seed a DB: three registered sessions (alpha with a topic, beta, ghost aged stale), a direct message, a broadcast, and a message from a sender that then unregisters.",
    "2. Run `thatch chat list` and verify the roster renders name, human age, project, and topic.",
    "3. Run `thatch chat tail --once` and verify sent lines render [timestamp] from -> to, with broadcast rows marked.",
    "4. Verify a departed sender renders as unknown in the tail.",
  ].join("\n"),
  expected: [
    "- The roster shows every registered session with a human-readable age, its project, and its topic when set.",
    "- Tail lines have the shape [timestamp] from -> to: body; via_broadcast rows render 'broadcast' as the recipient.",
    "- A sender whose directory row is gone renders as 'unknown (id, departed)'.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(ctx.env).cwd(ctx.dir).quiet().nothrow();

    // Seed on the fixture's THATCH_DB_PATH (the CLI opens the same file
    // through its own env).
    const seeded = new ThatchDB(ctx.env.THATCH_DB_PATH);
    try {
      const a = seeded.registerChatSession("ses_alpha", "alpha", "acme/widgets", "watching CI");
      const b = seeded.registerChatSession("ses_beta", "beta", "acme/widgets", null);
      const g = seeded.registerChatSession("ses_ghost", "ghost", "acme/widgets", null);
      if (!a.ok || !b.ok || !g.ok) {
        console.log("  FAIL: seeding failed");
        return "FAIL";
      }
      // Ghost's host process is long gone.
      const raw = new Database(ctx.env.THATCH_DB_PATH);
      raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_ghost'");
      raw.close();
      // Traffic: a direct send, a broadcast (skips the stale ghost), and a
      // message from a sender that then leaves the directory.
      seeded.sendChatMessage("ses_alpha", "ses_beta", "direct ping");
      seeded.broadcastChatMessage("ses_alpha", "the machine age begins");
      seeded.registerChatSession("ses_mortal", "mortal", "acme/widgets", null);
      seeded.sendChatMessage("ses_mortal", "ses_beta", "my last words");
      seeded.unregisterChatSession("ses_mortal");
    } finally {
      seeded.close();
    }

    const list = await run(["chat", "list"]);
    if (list.exitCode !== 0) {
      console.log(`  FAIL: chat list exited ${list.exitCode}`);
      return "FAIL";
    }
    const listText = list.stdout.toString();
    for (const needle of ["alpha", "beta", "watching CI", "project:acme/widgets", "ago"]) {
      if (!listText.includes(needle)) {
        console.log(`  FAIL: chat list output missing "${needle}":\n${listText}`);
        return "FAIL";
      }
    }

    const tail = await run(["chat", "tail", "--once"]);
    if (tail.exitCode !== 0) {
      console.log(`  FAIL: chat tail exited ${tail.exitCode}`);
      return "FAIL";
    }
    const tailText = tail.stdout.toString();
    // Direct send line with the resolved recipient name.
    if (!/\[\d{4}-\d{2}-\d{2}T[\d:]+Z\] alpha -> beta: direct ping/.test(tailText)) {
      console.log(`  FAIL: tail missing the direct-send line:\n${tailText}`);
      return "FAIL";
    }
    // Broadcast rows are marked, one per recipient (beta only: the stale
    // ghost is skipped and never receives one).
    const broadcastLines = tailText.split("\n").filter((l) => l.includes("-> broadcast:"));
    if (broadcastLines.length !== 1) {
      console.log(`  FAIL: expected 1 broadcast line (beta; ghost skipped), got ${broadcastLines.length}:\n${tailText}`);
      return "FAIL";
    }
    // The departed sender renders through the unknown fallback.
    if (!tailText.includes("unknown (")) {
      console.log(`  FAIL: departed sender did not degrade to unknown:\n${tailText}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
