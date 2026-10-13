import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { readOpenTabSessions } from "../../../src/tab-state";

/**
 * UC-099: Chat CLI.
 *
 * Automatable: `thatch chat list` and `thatch chat tail --once` are pure
 * CLI reads over a controlled DB. Seeds registered sessions with topics
 * (fresh and stale), a tabs.json fixture in the sandbox XDG state tree
 * (some sessions with tabs, some without), a direct message, a broadcast,
 * and a departed sender, then verifies the roster (including the
 * open/recent liveness verdicts) and the tail's JSONL events, including
 * the broadcast flag and the departed-sender fallback. The roster's
 * project grouping order is probed with two sibling-project seeds
 * (tab-less, so probed under --recent where they are visible), the
 * open-only default is verified against the long-stale ghost and the
 * tab-less recent rows (hidden behind a note, revealed by --recent),
 * bare --stale adds the
 * stale section under the one-day display cap (hidden-count note), and
 * --stale all is the unbounded escape hatch. A second seed
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
    "1. Seed a DB: three registered sessions (alpha with a topic, beta, ghost aged long stale), two ordering probes in sibling projects, a direct message, a broadcast, and a message from a sender that then unregisters.",
    "2. Run `thatch chat list` and verify the default open-only roster: one Active section (aligned header row plus name, human age, status, project, and topic columns) with no Stale or Recent section, and tab-less rows collapsed into a hidden-count note pointing at `--recent`.",
    "3. Run `thatch chat list --recent` and verify the Recent section renders the tab-less seeds with the recent verdict (the open verdicts render in the Active section), then verify bare `--stale` adds the Stale section but still hides the long-stale ghost behind the default one-day display cap (hidden-count note), and `--stale all` shows it unbounded.",
    "4. Verify the flags compose in either order: `--stale --recent` keeps the one-day cap and shows Recent (the flag token is not eaten as --stale's value), and `--recent --stale all` renders the full three-section page in order (Active, Recent, Stale).",
    "5. Run `thatch chat tail --once` and verify every stdout line is one JSON object with event/at/id/from/to/body fields, broadcast copies carry broadcast: true with their real recipient, and already-read messages have a read event linked by id.",
    "6. Verify a departed sender renders as unknown in the tail.",
    "7. Seed 25 numbered filler messages, then run filtered tails: verify --limit line counts and the stderr elision note, ANDed --match, --from name matching, and the --since/--until window.",
  ].join("\n"),
  expected: [
    "- The default roster is open-only: fresh tabbed sessions with a human-readable age, project, and topic; no Stale or Recent section, and tab-less rows collapse into a hidden-count note.",
    "- `--recent` reveals the Recent section with the tab-less seeds rendering the recent verdict; bare `--stale` adds a Stale section; rows older than the one-day default cap are hidden and counted in a note; `--stale all` displays every stale row.",
    "- The flags compose in either order: `--stale --recent` keeps the cap (no ghost) and renders Recent; `--recent --stale all` renders Active, Recent, and Stale in that page order with the ghost visible.",
    "- The tail is JSONL: one sent event per line with the body verbatim and each participant's topic; via_broadcast rows are one sent event per recipient with broadcast: true.",
    "- A sender whose directory row is gone renders as 'unknown (id, departed)'.",
    "- --limit caps the backlog with an elision note on stderr; --match ANDs; --from/--to match names; --since/--until bound the window.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(ctx.env).cwd(ctx.dir).quiet().nothrow();

    // The sandbox XDG state tree doubles as the open-tab fixture root: the
    // CLI's reader derives <XDG_STATE_HOME>/opencode/<channel>/tui/tabs.json
    // through the real path derivation. alpha and beta carry tabs (OPEN);
    // the other seeds do not (RECENT).
    const stateRoot = join(ctx.env.XDG_STATE_HOME, "opencode");
    mkdirSync(join(stateRoot, "latest", "tui"), { recursive: true });
    writeFileSync(
      join(stateRoot, "latest", "tui", "tabs.json"),
      JSON.stringify({
        global: { tabs: [], unread: {} },
        cwd: {
          "/sandbox/project": {
            tabs: [{ sessionID: "ses_alpha", title: "watching CI" }, { sessionID: "ses_beta", title: "beta" }],
            unread: {},
          },
        },
      }),
    );

    // Seed on the fixture's THATCH_DB_PATH (the CLI opens the same file
    // through its own env). The seeded db gets the same open-tab reader so
    // its broadcast sees the same tab state the CLI will render.
    const seeded = new ThatchDB(ctx.env.THATCH_DB_PATH, {
      chatOpenTabs: () => readOpenTabSessions(stateRoot),
    });
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
      // Ordering probes: sibling projects bracketing acme/widgets so the
      // roster's project grouping is observable end to end. Registered
      // after the traffic so the broadcast still has exactly one live
      // recipient (beta) and its fan-out assertions stay intact.
      if (!seeded.registerChatSession("ses_early", "acme/alpha", null, "opencode", "early").ok
        || !seeded.registerChatSession("ses_late", "acme/zulu", null, "opencode", "late").ok) {
        console.log("  FAIL: ordering probe seeding failed");
        return "FAIL";
      }
    } finally {
      seeded.close();
    }

    const list = await run(["chat", "list"]);
    if (list.exitCode !== 0) {
      console.log(`  FAIL: chat list exited ${list.exitCode}`);
      return "FAIL";
    }
    const listText = list.stdout.toString();
    // The default roster is open-only: the Active section renders with
    // its aligned header row plus session rows (name, age, status, project,
    // topic) - and no Stale section at all. Piped output carries no ANSI.
    for (const needle of [
      "# Active Sessions",
      "NAME", "AGE", "STATUS", "PROJECT", "TOPIC",
      "alpha-00001", "beta-00001", "watching CI", "acme/widgets", "ago",
    ]) {
      if (!listText.includes(needle)) {
        console.log(`  FAIL: chat list output missing "${needle}":\n${listText}`);
        return "FAIL";
      }
    }
    // The default hides stale rows entirely - section, note, and all.
    if (listText.includes("# Stale Sessions") || listText.includes("ghost-00001") || listText.includes("older stale session")) {
      console.log(`  FAIL: default roster should be open-only:\n${listText}`);
      return "FAIL";
    }
    // The default also hides recent (alive, tab-less) rows: the ordering
    // probes carry no tabs, so they collapse into the hidden-count note.
    if (listText.includes("early-00001") || !listText.includes("2 recent sessions hidden") || !listText.includes("--recent to show")) {
      console.log(`  FAIL: default roster should hide tab-less rows behind the note:\n${listText}`);
      return "FAIL";
    }
    // Bare --stale opts into the stale section under the one-day display
    // cap: the ghost (aged to 2020) stays hidden, and the hidden-count note
    // says so.
    const capped = await run(["chat", "list", "--stale"]);
    if (capped.exitCode !== 0) {
      console.log(`  FAIL: chat list --stale exited ${capped.exitCode}`);
      return "FAIL";
    }
    const cappedText = capped.stdout.toString();
    for (const needle of ["# Active Sessions", "# Stale Sessions", "older stale session"]) {
      if (!cappedText.includes(needle)) {
        console.log(`  FAIL: --stale roster missing "${needle}":\n${cappedText}`);
        return "FAIL";
      }
    }
    if (cappedText.includes("ghost-00001")) {
      console.log(`  FAIL: --stale should keep the one-day cap over the long-stale ghost:\n${cappedText}`);
      return "FAIL";
    }
    const unbounded = await run(["chat", "list", "--stale", "all"]);
    if (unbounded.exitCode !== 0) {
      console.log(`  FAIL: chat list --stale all exited ${unbounded.exitCode}`);
      return "FAIL";
    }
    if (!unbounded.stdout.toString().includes("ghost-00001")) {
      console.log(`  FAIL: --stale all should show the ghost:\n${unbounded.stdout.toString()}`);
      return "FAIL";
    }
    if (!unbounded.stdout.toString().includes("missed their heartbeat")) {
      console.log(`  FAIL: --stale all should show the missed-heartbeat explainer:\n${unbounded.stdout.toString()}`);
      return "FAIL";
    }
    // The flags compose, and order never matters: in "--stale --recent"
    // the flag token must not be eaten as --stale's value (a bare --stale
    // keeps the one-day cap, hiding the long-stale ghost). The combined
    // "--recent --stale all" renders the full three-section page, in
    // section order: Active, then Recent, then Stale.
    const both = await run(["chat", "list", "--stale", "--recent"]);
    if (both.exitCode !== 0) {
      console.log(`  FAIL: chat list --stale --recent exited ${both.exitCode}`);
      return "FAIL";
    }
    const bothText = both.stdout.toString();
    if (!bothText.includes("# Recent Sessions") || bothText.includes("ghost-00001")) {
      console.log(`  FAIL: --stale --recent should render Recent with the cap still hiding the ghost:\n${bothText}`);
      return "FAIL";
    }
    const allThree = await run(["chat", "list", "--recent", "--stale", "all"]);
    if (allThree.exitCode !== 0) {
      console.log(`  FAIL: chat list --recent --stale all exited ${allThree.exitCode}`);
      return "FAIL";
    }
    const allThreeText = allThree.stdout.toString();
    const headers = ["# Active Sessions", "# Recent Sessions", "# Stale Sessions"].map((h) => allThreeText.indexOf(h));
    if (headers.some((i) => i === -1) || headers[0] > headers[1] || headers[1] > headers[2] || !allThreeText.includes("ghost-00001")) {
      console.log(`  FAIL: combined flags should render Active, Recent, Stale in order with the ghost:\n${allThreeText}`);
      return "FAIL";
    }
    // --recent reveals the Recent section: the tab-less ordering probes
    // render with the recent verdict, alongside the Active section's
    // tab-carrying seeds.
    const withRecent = await run(["chat", "list", "--recent"]);
    if (withRecent.exitCode !== 0) {
      console.log(`  FAIL: chat list --recent exited ${withRecent.exitCode}`);
      return "FAIL";
    }
    const recentText = withRecent.stdout.toString();
    if (!recentText.includes("# Recent Sessions") || !recentText.includes("early-00001") || !recentText.includes("late-00001")) {
      console.log(`  FAIL: --recent roster missing the Recent section or its rows:\n${recentText}`);
      return "FAIL";
    }
    // Roster ordering: project groups sort alphabetically within a
    // section (acme/alpha, then acme/zulu). The probes are tab-less, so
    // they only render under --recent, and the section split dominates
    // the page (Active renders before Recent), so the bracket is probed
    // within the Recent section rather than across it. Within-project
    // recency ordering is unit-tested; seeds registered microseconds
    // apart cannot pin it here.
    const at = (needle: string) => recentText.indexOf(needle);
    if (at("early-00001") === -1 || at("early-00001") > at("late-00001")) {
      console.log(`  FAIL: Recent section rows not ordered by project:\n${recentText}`);
      return "FAIL";
    }
    // Liveness verdicts: the tab-carrying seeds render open, the
    // tab-less probes render recent (each in its own section).
    if (!/ago\s+open\b/.test(recentText) || !/ago\s+recent\b/.test(recentText)) {
      console.log(`  FAIL: roster rows missing open/recent verdicts:\n${recentText}`);
      return "FAIL";
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

    // The snapshot is a log: beta drained its inbox at seed time, so every
    // message it received carries a read event linked by id, timestamped
    // by the read.
    const reads = events.filter((e) => e.event === "read");
    if (reads.length !== 3 || !reads.every((e) => e.reader === "beta-00001" && events.some((s) => s.event === "sent" && s.id === e.id))) {
      console.log(`  FAIL: expected 3 read events by beta linked to sent events, got:\n${JSON.stringify(reads)}`);
      return "FAIL";
    }

    // --limit/--match/--from/--since/--until: seed enough rows that the
    // default limit would elide, then check each flag's effect. All runs
    // are one-shot (--once); the limit counts messages, so count sent
    // events (read events ride along with their message).
    const sentCount = (r: { stdout: Buffer }) => parseLines(r.stdout.toString()).filter((e) => e.event === "sent").length;

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
    // The note counts messages, not lines: the last 3 messages are unread
    // fillers, so 3 sent events and a note that agrees with them.
    if (limited.stderr.toString().includes("showing last 3 of 28 messages") === false) {
      console.log(`  FAIL: missing elision note on stderr:\n${limited.stderr.toString()}`);
      return "FAIL";
    }
    if (sentCount(limited) !== 3) {
      console.log("  FAIL: --limit 3 did not print exactly 3 events");
      return "FAIL";
    }

    // The shipped default: a flagless --once shows exactly the default
    // limit with the same elision note.
    const defaulted = await run(["chat", "tail", "--once"]);
    if (defaulted.exitCode !== 0 || sentCount(defaulted) !== 20) {
      console.log(`  FAIL: flagless --once should show 20 of 28 events, got ${sentCount(defaulted)}`);
      return "FAIL";
    }
    if (!defaulted.stderr.toString().includes("showing last 20 of 28 messages")) {
      console.log(`  FAIL: default elision note missing:\n${defaulted.stderr.toString()}`);
      return "FAIL";
    }

    // Repeatable --match ANDs: both patterns together isolate filler 12.
    const anded = await run(["chat", "tail", "--once", "--match", "filler", "--match", "12$"]);
    if (anded.exitCode !== 0 || sentCount(anded) !== 1) {
      console.log(`  FAIL: ANDed --match should show exactly filler 12:\n${anded.stdout.toString()}`);
      return "FAIL";
    }

    // --from matches rendered names case-insensitively; the departed
    // sender only matches through its unknown-departed rendering.
    const departed = await run(["chat", "tail", "--once", "--from", "unknown"]);
    if (departed.exitCode !== 0 || sentCount(departed) !== 1) {
      console.log("  FAIL: --from unknown should show exactly the departed sender's message");
      return "FAIL";
    }

    // The time window is half-open and bounds the backlog: an --until in
    // the past shows nothing, and --since + --until can slice the window.
    const empty = await run(["chat", "tail", "--once", "--until", "2000-01-01"]);
    if (empty.exitCode !== 0 || sentCount(empty) !== 0) {
      console.log("  FAIL: --until in the past should print no events");
      return "FAIL";
    }
    const today = await run(["chat", "tail", "--once", "--since", "1970-01-01", "--until", "2999-01-01", "--limit", "all"]);
    if (today.exitCode !== 0 || sentCount(today) !== 28) {
      console.log("  FAIL: a window covering the seed should print all 28 events");
      return "FAIL";
    }
    // Nothing elided means no note: --limit all must keep stderr quiet.
    if (today.stderr.toString().includes("showing last")) {
      console.log(`  FAIL: --limit all should not print an elision note:\n${today.stderr.toString()}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
