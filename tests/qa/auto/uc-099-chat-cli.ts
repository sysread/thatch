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
 * then verifies the roster and the tail's card rendering, including
 * the broadcast marker and the departed-sender fallback. A second seed
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
    "2. Run `thatch chat list` and verify the roster renders two sections - Active and Stale (with a not-reported-in explainer) - each an aligned header row plus name, human age, status, project, and topic columns.",
    "3. Run `thatch chat tail --once` and verify the cards render From/To/When headers, with broadcast rows marked.",
    "4. Verify a departed sender renders as unknown in the tail.",
    "5. Seed 25 numbered filler messages, then run filtered tails: verify --limit card counts and the stderr elision note, ANDed --match, --from name matching, and the --since/--until window.",
  ].join("\n"),
  expected: [
    "- The roster shows every registered session with a human-readable age, its project, and its topic when set, grouped into Active and Stale sections by liveness.",
    "- Tail cards render From/To/When headers with full bodies; via_broadcast rows render 'broadcast' as the recipient.",
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
      "# Active Sessions", "# Stale Sessions", "harnesses may no longer be running",
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
    // Direct-send card: styled header block (chip + value, flush left with
    // a one-space chip pad), topic annotations after names (alpha is
    // seeded with "watching CI"; beta registered without one), local-
    // timezone When line, full body.
    const plainCard = tailText.replace(/\x1b\[[0-9;]*m/g, "");
    if (!/^ From {3}alpha-00001 <watching CI>\n To {5}beta-00001\n When {3}\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+\n\ndirect ping/m.test(plainCard)) {
      console.log(`  FAIL: tail missing the direct-send card:\n${plainCard}`);
      return "FAIL";
    }
    // Broadcast cards are marked, one per recipient (beta only: the stale
    // ghost is skipped and never receives one).
    const broadcastLines = plainCard.split("\n").filter((l) => /^ To {5}broadcast$/.test(l));
    if (broadcastLines.length !== 1) {
      console.log(`  FAIL: expected 1 broadcast line (beta; ghost skipped), got ${broadcastLines.length}:\n${tailText}`);
      return "FAIL";
    }
    // The departed sender renders through the unknown fallback.
    if (!tailText.includes("unknown (")) {
      console.log(`  FAIL: departed sender did not degrade to unknown:\n${tailText}`);
      return "FAIL";
    }

    // --limit/--match/--from/--since/--until: seed enough rows that the
    // default limit would elide, then check each flag's effect. All runs
    // are one-shot (--once); a card is counted by its When line.
    const cardCount = (r: { stdout: Buffer }) =>
      r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => l.startsWith(" When")).length;

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
    if (cardCount(limited) !== 3) {
      console.log("  FAIL: --limit 3 did not render exactly 3 cards");
      return "FAIL";
    }

    // The shipped default: a flagless --once shows exactly the default
    // limit with the same elision note.
    const defaulted = await run(["chat", "tail", "--once"]);
    if (defaulted.exitCode !== 0 || cardCount(defaulted) !== 20) {
      console.log(`  FAIL: flagless --once should show 20 of 28 cards, got ${cardCount(defaulted)}`);
      return "FAIL";
    }
    if (!defaulted.stderr.toString().includes("showing last 20 of 28 messages")) {
      console.log(`  FAIL: default elision note missing:\n${defaulted.stderr.toString()}`);
      return "FAIL";
    }

    // Repeatable --match ANDs: both patterns together isolate filler 12.
    const anded = await run(["chat", "tail", "--once", "--match", "filler", "--match", "12$"]);
    if (anded.exitCode !== 0 || cardCount(anded) !== 1) {
      console.log(`  FAIL: ANDed --match should show exactly filler 12:\n${anded.stdout.toString()}`);
      return "FAIL";
    }

    // --from matches rendered names case-insensitively; the departed
    // sender only matches through its unknown-departed rendering.
    const departed = await run(["chat", "tail", "--once", "--from", "unknown"]);
    if (departed.exitCode !== 0 || cardCount(departed) !== 1) {
      console.log("  FAIL: --from unknown should show exactly the departed sender's message");
      return "FAIL";
    }

    // The time window is half-open and bounds the backlog: an --until in
    // the past shows nothing, and --since + --until can slice the window.
    const empty = await run(["chat", "tail", "--once", "--until", "2000-01-01"]);
    if (empty.exitCode !== 0 || cardCount(empty) !== 0) {
      console.log("  FAIL: --until in the past should render no cards");
      return "FAIL";
    }
    const today = await run(["chat", "tail", "--once", "--since", "1970-01-01", "--until", "2999-01-01", "--limit", "all"]);
    if (today.exitCode !== 0 || cardCount(today) !== 28) {
      console.log("  FAIL: a window covering the seed should render all 28 cards");
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
