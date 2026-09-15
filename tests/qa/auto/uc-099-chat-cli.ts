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
 * then verifies the roster and the tail's JSONL events, including the
 * broadcast flag and the departed-sender fallback. A second seed
 * batch (numbered fillers) exercises the tail's --limit elision note,
 * ANDed --match body filters, --from name matching, and the --since/
 * --until window. The follow mode (no --once) is a live loop and is
 * covered by the user doc workflow.
 */

const useCase: UseCase = {
  name: "UC-099-chat-cli",
  preconditions: [
    "- Bun on PATH (the test runs the repo binary directly)",
    "- A DB with registered sessions and seeded messages",
  ].join("\n"),
  steps: [
    "1. Seed a DB: three registered sessions (alpha with a topic, beta, ghost aged stale), a direct message, a broadcast, and a message from a sender that then unregisters.",
    "2. Run `thatch chat list` and verify the roster renders two sections - Active and Stale (with a missed-heartbeat explainer) - each an aligned header row plus name, human age, status, project, and topic columns.",
    "3. Run `thatch chat tail --once` and verify every stdout line is one JSON object with event/at/id/from/to/body fields, and broadcast copies carry broadcast: true with their real recipient.",
    "4. Verify a departed sender renders as unknown in the tail.",
    "5. Seed 25 numbered filler messages, then run filtered tails: verify --limit line counts and the stderr elision note, ANDed --match, --from name matching, and the --since/--until window.",
  ].join("\n"),
  expected: [
    "- The roster shows every registered session with a human-readable age, its project, and its topic when set, grouped into Active and Stale sections by liveness.",
    "- The tail is JSONL: one sent event per line with the body verbatim and each participant's topic; via_broadcast rows are one sent event per recipient with broadcast: true.",
    "- A sender whose directory row is gone renders as 'unknown (id, departed)'.",
    "- --limit caps the backlog with an elision note on stderr; --match ANDs; --from/--to match names; --since/--until bound the window.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(ctx.env).cwd(ctx.dir).quiet().nothrow();

    // Seed on the fixture's THATCH_DB_PATH (the CLI opens the same file
    // through its own env).
    const seeded = new ThatchDB(ctx.env.THATCH_DB_PATH);
    try {
      const a = seeded.registerChatSession("ses_alpha", "acme/widgets", "watching CI", "opencode", "alpha");
      const b = seeded.registerChatSession("ses_beta", "acme/widgets", null, "opencode", "beta");
      const g = seeded.registerChatSession("ses_ghost", "acme/widgets", null, "opencode", "ghost");
      if (!a.ok || !b.ok || !g.ok) {
        console.log("  FAIL: seeding failed");
        return "FAIL";
      }
      // Ghost's host process is long gone.
      const raw = new Database(ctx.env.THATCH_DB_PATH);
      raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_ghost'");
      raw.close();
      // Traffic: a direct send, a broadcast (skips the stale ghost), a
      // message from a sender that then leaves the directory, and a read
      // (beta drains its inbox) so the tail shows a read line too.
      seeded.sendChatMessage("ses_alpha", "ses_beta", "direct ping");
      seeded.broadcastChatMessage("ses_alpha", "the machine age begins");
      seeded.registerChatSession("ses_mortal", "acme/widgets", null, "opencode", "mortal");
      seeded.sendChatMessage("ses_mortal", "ses_beta", "my last words");
      seeded.unregisterChatSession("ses_mortal");
      seeded.readChatMessages("ses_beta");
    } finally {
      seeded.close();
    }

    const list = await run(["chat", "list"]);
    if (list.exitCode !== 0) {
      console.log(`  FAIL: chat list exited ${list.exitCode}`);
      return "FAIL";
    }
    const listText = list.stdout.toString();
    // The roster renders two sections - Active and Stale - each an aligned
    // header row plus session rows with name, age, status, project, and
    // topic. Piped output carries no ANSI.
    for (const needle of [
      "# Active Sessions", "# Stale Sessions", "missed their heartbeat",
      "NAME", "AGE", "STATUS", "PROJECT", "TOPIC",
      "alpha-00001", "beta-00001", "watching CI", "acme/widgets", "ago",
    ]) {
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
    // Every stdout line is one JSON object: pure JSONL, no ANSI, no rules.
    const parseLines = (text: string): any[] => text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    let events: any[];
    try {
      events = parseLines(tailText);
    } catch (err) {
      console.log(`  FAIL: tail stdout is not JSONL (${err}):\n${tailText}`);
      return "FAIL";
    }
    if (tailText.includes("\x1b[")) {
      console.log(`  FAIL: tail output contains ANSI escapes:\n${tailText}`);
      return "FAIL";
    }
    // The direct send: sender topic rides along (alpha seeded with
    // "watching CI"; beta registered without one), body verbatim, ISO
    // timestamp as stored.
    const direct = events.find((e) => e.body === "direct ping");
    if (!direct || direct.event !== "sent" || direct.from !== "alpha-00001" || direct.from_topic !== "watching CI" || direct.to !== "beta-00001" || direct.to_topic !== null || direct.broadcast !== false || typeof direct.id !== "number" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(direct.at)) {
      console.log(`  FAIL: direct-send event malformed:\n${JSON.stringify(direct)}`);
      return "FAIL";
    }
    // Broadcast fan-out: one sent event per recipient flagged broadcast,
    // naming its real recipient (beta only: the stale ghost is skipped).
    const fanout = events.filter((e) => e.broadcast === true);
    if (fanout.length !== 1 || fanout[0].to !== "beta-00001" || fanout[0].body !== "the machine age begins") {
      console.log(`  FAIL: expected 1 broadcast event to beta, got:\n${JSON.stringify(fanout)}`);
      return "FAIL";
    }
    // The departed sender renders through the unknown fallback.
    if (!events.some((e) => typeof e.from === "string" && e.from.startsWith("unknown ("))) {
      console.log(`  FAIL: departed sender did not degrade to unknown:\n${tailText}`);
      return "FAIL";
    }

    // --limit/--match/--from/--since/--until: seed enough rows that the
    // default limit would elide, then check each flag's effect. All runs
    // are one-shot (--once); one line is one event.
    const eventCount = (r: { stdout: Buffer }) => parseLines(r.stdout.toString()).length;

    // Traffic for the filter checks: 25 numbered filler rows (28 total).
    const more = new ThatchDB(ctx.env.THATCH_DB_PATH);
    try {
      for (let i = 1; i <= 25; i++) more.sendChatMessage("ses_alpha", "ses_beta", `uc099 filler ${i}`);
    } finally {
      more.close();
    }

    const limited = await run(["chat", "tail", "--once", "--limit", "3"]);
    if (limited.exitCode !== 0) {
      console.log(`  FAIL: --limit tail exited ${limited.exitCode}`);
      return "FAIL";
    }
    if (limited.stderr.toString().includes("showing last 3 of 28 messages") === false) {
      console.log(`  FAIL: missing elision note on stderr:\n${limited.stderr.toString()}`);
      return "FAIL";
    }
    if (eventCount(limited) !== 3) {
      console.log("  FAIL: --limit 3 did not print exactly 3 events");
      return "FAIL";
    }

    // The shipped default: a flagless --once shows exactly the default
    // limit with the same elision note.
    const defaulted = await run(["chat", "tail", "--once"]);
    if (defaulted.exitCode !== 0 || eventCount(defaulted) !== 20) {
      console.log(`  FAIL: flagless --once should show 20 of 28 events, got ${eventCount(defaulted)}`);
      return "FAIL";
    }
    if (!defaulted.stderr.toString().includes("showing last 20 of 28 messages")) {
      console.log(`  FAIL: default elision note missing:\n${defaulted.stderr.toString()}`);
      return "FAIL";
    }

    // Repeatable --match ANDs: both patterns together isolate filler 12.
    const anded = await run(["chat", "tail", "--once", "--match", "filler", "--match", "12$"]);
    if (anded.exitCode !== 0 || eventCount(anded) !== 1) {
      console.log(`  FAIL: ANDed --match should show exactly filler 12:\n${anded.stdout.toString()}`);
      return "FAIL";
    }

    // --from matches rendered names case-insensitively; the departed
    // sender only matches through its unknown-departed rendering.
    const departed = await run(["chat", "tail", "--once", "--from", "unknown"]);
    if (departed.exitCode !== 0 || eventCount(departed) !== 1) {
      console.log("  FAIL: --from unknown should show exactly the departed sender's message");
      return "FAIL";
    }

    // The time window is half-open and bounds the backlog: an --until in
    // the past shows nothing, and --since + --until can slice the window.
    const empty = await run(["chat", "tail", "--once", "--until", "2000-01-01"]);
    if (empty.exitCode !== 0 || eventCount(empty) !== 0) {
      console.log("  FAIL: --until in the past should print no events");
      return "FAIL";
    }
    const today = await run(["chat", "tail", "--once", "--since", "1970-01-01", "--until", "2999-01-01", "--limit", "all"]);
    if (today.exitCode !== 0 || eventCount(today) !== 28) {
      console.log("  FAIL: a window covering the seed should print all 28 events");
      return "FAIL";
    }
    // Nothing elided means no note: --limit all must keep stderr quiet.
    if (today.stderr.toString().includes("showing last")) {
      console.log(`  FAIL: --limit all should not print an elision note:\n${today.stderr.toString()}`);
      return "FAIL";
    }
    // Read events never appear in a --once snapshot by design (they fire
    // only in follow mode, when a read happens after the tail started);
    // the diff logic is unit-tested in tests/chat.test.ts (chatTailDiff).
    return "PASS";
  },
};

registerUseCase(useCase);
