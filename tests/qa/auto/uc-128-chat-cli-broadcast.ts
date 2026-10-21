import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { readOpenTabSessions } from "../../../src/tab-state";

/**
 * UC-128: Chat CLI broadcast (`thatch chat broadcast`).
 *
 * Automatable: the broadcast write path is a pure CLI write over a
 * controlled DB. Seeds registered sessions across two projects covering
 * every audience class (open with tab, fresh tab-less = RECENT, MCP,
 * long-stale, and a NULL-project row), pins a deterministic sender name
 * through a scratch git config (GIT_CONFIG_GLOBAL), then runs the CLI
 * broadcast with and without --project. Verifies the delivery report
 * (delivered/skipped/out-of-scope buckets with liveness labels), the
 * fence note in the persisted bodies (the protocol note that tells
 * receiving sessions the user is not in the chat), the sentinel sender
 * rows (from_session 'cli', via_broadcast 1, read/delivered unstamped),
 * the tail's JSONL sent events rendering the broadcast under the
 * snapshotted sender name, the dedupe notice on an identical unread
 * retry, and the loud failure paths (unknown flag, empty message).
 */

const useCase: UseCase = {
  name: "UC-128-chat-cli-broadcast",
  preconditions: [
    "- Bun on PATH (the test runs the repo binary directly)",
    "- A DB with registered sessions across two projects",
  ].join("\n"),
  steps: [
    "1. Seed a DB: sessions in two projects (open tab, tab-less RECENT, MCP, long-stale, and one with no project), plus a tabs.json fixture and a scratch git config pinning the sender name.",
    "2. Run `thatch chat broadcast <msg>` with no --project and verify the report: one delivered line per live recipient with liveness labels (open / no tab / mcp), the stale skip named, no out-of-scope section.",
    "3. Run `thatch chat broadcast <msg> --project P --project=Q` and verify the filter: only the named projects delivered, out-of-scope rows (including the NULL-project session) named in the out-of-scope bucket.",
    "4. Query the DB: delivered rows carry from_session 'cli', the snapshotted sender name, via_broadcast 1, and NULL read_at/delivered_at; bodies begin with the fence note stating the user is not a chat session and replies go to the user's own session, not chat.",
    "5. Run `thatch chat tail --once` and verify the broadcast renders as ordinary sent events (broadcast: true) under the sender name, bodies carrying the fence note.",
    "6. Re-run the identical --project broadcast and verify the duplicate-suppressed notice; run with an unknown flag and with no message and verify both die loudly with a plain error.",
  ].join("\n"),
  expected: [
    "- The unfiltered broadcast reaches every live session regardless of tab state (RECENT and MCP included) and skips only the stale row, which is named with its project.",
    "- --project narrows by exact match; non-matching and NULL-project rows appear in an out-of-scope section, never as skipped or delivered.",
    "- Delivered rows are sentinel-sent ('cli'), carry the sender name snapshot and via_broadcast 1, and leave delivery stamping to the wake/poll machinery (read_at and delivered_at NULL).",
    "- Every delivered body starts with the fence note: the message is from the human user, who is not a chat session; recipients act in their own session and do not reply into thatch chat.",
    "- The tail shows the broadcast as ordinary per-recipient sent events with broadcast: true and from set to the snapshotted sender name.",
    "- An identical unread retry reports duplicate suppression; an unknown flag or an empty message exits 1 with a plain error and no stack trace.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;

    // Deterministic sender identity: the CLI derives its sender name from
    // `git config user.name` (falling back to $USER); a scratch config
    // pins it so the report and tail assertions are exact.
    const gitConfig = join(ctx.dir, "gitconfig");
    writeFileSync(gitConfig, "[user]\n\tname = Fence Holler\n");
    const env = { ...ctx.env, GIT_CONFIG_GLOBAL: gitConfig };
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(env).cwd(ctx.dir).quiet().nothrow();

    // Open-tab fixture: alpha and beta carry tabs (OPEN); every other
    // seed degrades to RECENT for the tab check.
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

    // Seed on the fixture's THATCH_DB_PATH with the same tab reader the
    // CLI will use, so store-side and CLI-side liveness agree.
    const seeded = new ThatchDB(ctx.env.THATCH_DB_PATH, {
      chatOpenTabs: () => readOpenTabSessions(stateRoot),
    });
    try {
      for (const [id, project, kind, base] of [
        ["ses_alpha", "acme/alpha-proj", "opencode", "alpha"],
        ["ses_beta", "acme/alpha-proj", "opencode", "beta"],
        ["ses_gamma", "acme/gamma-proj", "opencode", "gamma"],
        ["ses_mike", "acme/gamma-proj", "mcp", "mike"],
        ["ses_ghost", "acme/alpha-proj", "opencode", "ghost"],
        ["ses_np", null, "opencode", "noplan"],
      ] as const) {
        const r = seeded.registerChatSession(id, project, null, kind, base);
        if (!r.ok) {
          console.log(`  FAIL: seeding ${id} failed: ${r.error}`);
          return "FAIL";
        }
      }
      // The ghost's host process is long gone.
      const raw = new Database(ctx.env.THATCH_DB_PATH);
      raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_ghost'");
      raw.close();
    } finally {
      seeded.close();
    }

    // Unfiltered broadcast: every live session receives - RECENT and MCP
    // included (the ordinary poller delivers to open sessions, and the
    // others read at their next prompt) - and only the stale ghost is
    // skipped.
    const wide = await run(["chat", "broadcast", "holler one", "from", "the", "fence"]);
    if (wide.exitCode !== 0) {
      console.log(`  FAIL: broadcast exited ${wide.exitCode}:\n${wide.stderr.toString()}`);
      return "FAIL";
    }
    const wideText = wide.stdout.toString();
    for (const needle of [
      "Broadcast from Fence Holler to 5 of 6 registered sessions:",
      "  delivered: alpha-00001 (acme/alpha-proj) [open]",
      "  delivered: beta-00001 (acme/alpha-proj) [open]",
      "  delivered: gamma-00001 (acme/gamma-proj) [no tab, reads at next prompt]",
      "  delivered: mike-00001 (acme/gamma-proj) [mcp, reads at next prompt]",
      "  delivered: noplan-00001 (no project)",
      "  skipped (stale): ghost-00001 (acme/alpha-proj)",
    ]) {
      if (!wideText.includes(needle)) {
        console.log(`  FAIL: unfiltered broadcast report missing "${needle}":\n${wideText}`);
        return "FAIL";
      }
    }
    if (wideText.includes("out of scope")) {
      console.log(`  FAIL: unfiltered broadcast should have no out-of-scope section:\n${wideText}`);
      return "FAIL";
    }

    // --project (both flag forms) narrows by exact match; the
    // NULL-project row is named as out of scope, not skipped.
    const filtered = await run(["chat", "broadcast", "--project", "acme/alpha-proj", "--project=acme/gamma-proj", "standup in five"]);
    if (filtered.exitCode !== 0) {
      console.log(`  FAIL: filtered broadcast exited ${filtered.exitCode}:\n${filtered.stderr.toString()}`);
      return "FAIL";
    }
    const filteredText = filtered.stdout.toString();
    for (const needle of [
      "Broadcast from Fence Holler to 4 of 6 registered sessions (projects: acme/alpha-proj, acme/gamma-proj):",
      "  delivered: alpha-00001 (acme/alpha-proj) [open]",
      "  delivered: gamma-00001 (acme/gamma-proj) [no tab, reads at next prompt]",
      "  skipped (stale): ghost-00001 (acme/alpha-proj)",
      "  out of scope (project filter): noplan-00001 (no project)",
    ]) {
      if (!filteredText.includes(needle)) {
        console.log(`  FAIL: filtered broadcast report missing "${needle}":\n${filteredText}`);
        return "FAIL";
      }
    }
    if (filteredText.includes("noplan-00001") && !filteredText.includes("out of scope (project filter): noplan-00001")) {
      console.log(`  FAIL: NULL-project row rendered outside the out-of-scope bucket:\n${filteredText}`);
      return "FAIL";
    }

    // Row-level contract: sentinel sender, name snapshot, broadcast flag,
    // delivery stamping left to the wake/poll machinery, fence note
    // leading every body.
    const raw = new Database(ctx.env.THATCH_DB_PATH);
    const rows = raw.query(
      "SELECT from_session, from_name, to_name, via_broadcast, read_at, delivered_at, body FROM chat_messages WHERE from_session = 'cli' AND body NOT LIKE '%continued in next message%'",
    ).all() as any[];
    const fence = "[Broadcast from the human user via `thatch chat broadcast`.";
    const problems: string[] = [];
    for (const row of rows) {
      if (row.from_name !== "Fence Holler") problems.push(`bad from_name: ${row.from_name}`);
      if (row.via_broadcast !== 1) problems.push(`bad via_broadcast: ${row.via_broadcast}`);
      if (row.read_at !== null) problems.push(`read_at stamped by the CLI: ${row.read_at}`);
      if (row.delivered_at !== null) problems.push(`delivered_at stamped by the CLI: ${row.delivered_at}`);
      if (!row.body.startsWith(`${fence}`)) problems.push(`body missing fence note: ${String(row.body).slice(0, 60)}`);
      if (!row.body.includes("not a chat session") || !row.body.includes("Do NOT reply into thatch chat")) {
        problems.push("fence note missing the protocol statements");
      }
    }
    // alpha, beta, gamma, mike, noplan (wide) + the filtered rerun's
    // fresh rows to alpha, beta, gamma, mike = 9 delivered rows total.
    if (rows.length !== 9) problems.push(`expected 9 delivered sentinel rows, got ${rows.length}`);
    raw.close();
    if (problems.length > 0) {
      console.log(`  FAIL: sentinel row contract violated:\n${problems.join("\n")}`);
      return "FAIL";
    }

    // The tail shows the broadcast as ordinary sent events under the
    // snapshotted sender name, broadcast flagged, fence note in the body.
    const tail = await run(["chat", "tail", "--once"]);
    if (tail.exitCode !== 0) {
      console.log(`  FAIL: chat tail exited ${tail.exitCode}`);
      return "FAIL";
    }
    let events: any[];
    try {
      events = tail.stdout.toString().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    } catch (err) {
      console.log(`  FAIL: tail stdout is not JSONL (${err})`);
      return "FAIL";
    }
    const cliEvents = events.filter((e) => e.from === "Fence Holler");
    if (cliEvents.length !== 9 || !cliEvents.every((e) => e.event === "sent" && e.broadcast === true && e.body.startsWith(fence))) {
      console.log(`  FAIL: expected 9 fence-noted broadcast sent events from Fence Holler, got:\n${JSON.stringify(cliEvents.slice(0, 3))}`);
      return "FAIL";
    }

    // An identical unread retry is deduped per recipient, and the report
    // says so.
    const retry = await run(["chat", "broadcast", "--project", "acme/alpha-proj", "--project=acme/gamma-proj", "standup in five"]);
    if (retry.exitCode !== 0 || !retry.stdout.toString().includes("duplicate suppressed for 4 recipients")) {
      console.log(`  FAIL: identical retry should report duplicate suppression:\n${retry.stdout.toString()}\n${retry.stderr.toString()}`);
      return "FAIL";
    }

    // A body whose FRAMED length crosses the cap is refused with the
    // user's own character count (the fence note pushes 20000 over).
    const toolong = await run(["chat", "broadcast", "x".repeat(20_000)]);
    if (toolong.exitCode !== 1 || !toolong.stderr.toString().includes("attempted 20000 characters")) {
      console.log(`  FAIL: a 20000-char body should be refused with the user's count:\n${toolong.stderr.toString()}`);
      return "FAIL";
    }

    // A bare `--` puts every later token in the message, so a body that
    // starts with `--` is sendable.
    const dashdash = await run(["chat", "broadcast", "--project", "acme/alpha-proj", "--", "--leading dashes body"]);
    if (dashdash.exitCode !== 0) {
      console.log(`  FAIL: -- end-of-flags broadcast exited ${dashdash.exitCode}:\n${dashdash.stderr.toString()}`);
      return "FAIL";
    }
    const ddRaw = new Database(ctx.env.THATCH_DB_PATH);
    // alpha and beta are both in acme/alpha-proj: one row per recipient.
    const ddRow = ddRaw.query("SELECT COUNT(*) AS n FROM chat_messages WHERE from_session = 'cli' AND body LIKE '%--leading dashes body%'").get() as any;
    ddRaw.close();
    if (ddRow.n !== 2) {
      console.log(`  FAIL: -- body not stored verbatim (rows: ${ddRow.n})`);
      return "FAIL";
    }

    // A typo'd flag must not go out to every session as message text.
    const typo = await run(["chat", "broadcast", "--prjoect", "x", "oops"]);
    if (typo.exitCode !== 1 || !typo.stderr.toString().includes("unknown flag")) {
      console.log(`  FAIL: unknown flag should die loudly:\n${typo.stderr.toString()}`);
      return "FAIL";
    }
    // An empty message is a usage error, not an empty broadcast.
    const noMsg = await run(["chat", "broadcast"]);
    if (noMsg.exitCode !== 1 || !noMsg.stderr.toString().includes("usage: thatch chat broadcast")) {
      console.log(`  FAIL: empty message should print usage:\n${noMsg.stderr.toString()}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
