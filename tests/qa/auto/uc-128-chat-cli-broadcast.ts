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
 * long-stale-but-resumable through an opencode.db fixture, long-stale
 * and dead, and a NULL-project row), pins a deterministic sender name
 * through a scratch git config (GIT_CONFIG_GLOBAL), then runs the CLI
 * broadcast with the default audience, with both audience flags
 * (--closed --stale), and with --project. Verifies the flag-gated
 * default (ACTIVE only: open tabs plus mcp; closed-tab and stale rows
 * get flag-hinted skip lines, no rows), the full reach when both flags
 * are set, and the summarized delivery report (open tabs named,
 * no-tab/mcp/stale-queued/skipped/out-of-scope counted - never one
 * line per session), the fence note in the persisted bodies (the
 * protocol note that tells receiving sessions the user is not in the
 * chat), the sentinel sender rows (from_session 'cli', via_broadcast 1,
 * read/delivered unstamped), the tail's JSONL sent events rendering the
 * broadcast under the snapshotted sender name, the dedupe notice on an
 * identical unread retry, and the loud failure paths (unknown flag,
 * empty message).
 */

const useCase: UseCase = {
  name: "UC-128-chat-cli-broadcast",
  preconditions: [
    "- Bun on PATH (the test runs the repo binary directly)",
    "- A DB with registered sessions across two projects",
  ].join("\n"),
  steps: [
    "1. Seed a DB: sessions in two projects (open tab, tab-less RECENT, MCP, two long-stale rows, and one with no project), plus a tabs.json fixture, an opencode.db fixture whose session_v2 table keeps one stale row resumable (the other stale row is absent, so it is dead), and a scratch git config pinning the sender name.",
    "2. Run `thatch chat broadcast <msg>` with no flags and verify the flag-gated default: only the open-tab recipients are named and the mcp session counted; the closed-tab and stale rows get aggregate skip lines naming --closed / --stale, and no inbox rows.",
    "3. Run `thatch chat broadcast <msg> --closed --stale` and verify the full reach: no-tab and mcp recipients counted by delivery state, the stale-but-resumable session queued, and only the dead stale skip counted per project.",
    "4. Run `thatch chat broadcast <msg> --project P --project=Q --closed --stale` and verify the filter: only the named projects delivered, out-of-scope rows (including the NULL-project session) counted per project in the out-of-scope section.",
    "5. Query the DB: delivered rows carry from_session 'cli', the snapshotted sender name, via_broadcast 1, and NULL read_at/delivered_at; bodies begin with the fence note stating the user is not a chat session and replies go to the user's own session, not chat.",
    "6. Run `thatch chat tail --once` and verify the broadcast renders as ordinary sent events (broadcast: true) under the sender name, bodies carrying the fence note.",
    "7. Re-run the identical --project broadcast and verify the duplicate-suppressed notice; run with an unknown flag and with no message and verify both die loudly with a plain error.",
  ].join("\n"),
  expected: [
    "- The default audience is ACTIVE only: open-tab opencode sessions (woken immediately) plus MCP sessions (read at their next prompt). Closed-tab and stale sessions get NO inbox rows; the report summarizes them as aggregate skip lines naming the flag that includes them (\"skipped N closed-tab sessions (--closed to include)\", \"skipped N stale sessions (--stale to include)\").",
    "- With --closed and --stale, closed-tab sessions receive (single nudge, then read at next prompt) and the stale-but-resumable session gets queued mail (no wake; it reads the mail when its harness returns). Only the dead stale row is skipped. Both flags together reach everything; the resumability consult runs only under --stale.",
    "- --project narrows by exact match; non-matching and NULL-project rows appear in a counted out-of-scope section, never as skipped or delivered.",
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
    // The host session database fixture (production: opencode.db's
    // session_v2 table, read through resumableSessionIds): the stale
    // ghost is still resumable, so broadcasts queue its mail; the stale
    // dead row is absent from it, so broadcasts skip that row.
    const hostDb = join(ctx.dir, "opencode.db");
    const odb = new Database(hostDb);
    odb.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL)");
    odb.run("INSERT INTO session_v2 (id, directory) VALUES ('ses_ghost', '/sandbox/project')");
    odb.close();
    const env = { ...ctx.env, GIT_CONFIG_GLOBAL: gitConfig, OPENCODE_DB: hostDb };
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
        ["ses_dead", "acme/alpha-proj", "opencode", "dead"],
        ["ses_np", null, "opencode", "noplan"],
      ] as const) {
        const r = seeded.registerChatSession(id, project, null, kind, base);
        if (!r.ok) {
          console.log(`  FAIL: seeding ${id} failed: ${r.error}`);
          return "FAIL";
        }
      }
      // The ghost's and dead row's host processes are long gone; the
      // ghost stays resumable through the opencode.db fixture above,
      // while dead is absent from it.
      const raw = new Database(ctx.env.THATCH_DB_PATH);
      raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id IN ('ses_ghost', 'ses_dead')");
      raw.close();
    } finally {
      seeded.close();
    }

    // Default audience: ACTIVE only. The open tabs (alpha, beta) are
    // named and woken; the mcp session is counted; the closed-tab rows
    // (gamma, noplan) and the stale rows (ghost, dead - resumable or
    // not) get aggregate skip lines naming the flag that includes them,
    // and NO inbox rows.
    const wide = await run(["chat", "broadcast", "holler one", "from", "the", "fence"]);
    if (wide.exitCode !== 0) {
      console.log(`  FAIL: broadcast exited ${wide.exitCode}:\n${wide.stderr.toString()}`);
      return "FAIL";
    }
    const wideText = wide.stdout.toString();
    for (const needle of [
      "Broadcast from Fence Holler to 3 of 7 registered sessions:",
      "  delivered: alpha-00001 (acme/alpha-proj) [open]",
      "  delivered: beta-00001 (acme/alpha-proj) [open]",
      "  delivered to 1 mcp session (read at next prompt)",
      "Skipped:",
      "  skipped 2 closed-tab sessions (--closed to include)",
      "  skipped 2 stale sessions (--stale to include)",
    ]) {
      if (!wideText.includes(needle)) {
        console.log(`  FAIL: unfiltered broadcast report missing "${needle}":\n${wideText}`);
        return "FAIL";
      }
    }
    // No session name may appear outside its named delivered line: the
    // count lines summarize, they never name.
    for (const name of ["gamma-00001", "mike-00001", "noplan-00001", "ghost-00001", "dead-00001"]) {
      if (wideText.includes(name)) {
        console.log(`  FAIL: bulk recipient "${name}" named in the summarized report:\n${wideText}`);
        return "FAIL";
      }
    }
    if (/out of scope/i.test(wideText)) {
      console.log(`  FAIL: unfiltered broadcast should have no out-of-scope section:\n${wideText}`);
      return "FAIL";
    }
    // The default audience writes rows ONLY for the active sessions:
    // three recipients, one row each.
    const wideRaw = new Database(ctx.env.THATCH_DB_PATH);
    const wideRows = wideRaw.query("SELECT COUNT(*) AS n FROM chat_messages WHERE body LIKE '%holler one%'").get() as any;
    wideRaw.close();
    if (wideRows.n !== 3) {
      console.log(`  FAIL: default audience should write 3 rows, wrote ${wideRows.n}`);
      return "FAIL";
    }

    // Both flags together restore the full reach: closed-tab rows
    // (single nudge, then read at next prompt) and the stale-but-
    // resumable ghost (queued; the resumability consult ran) receive;
    // only the dead stale row is skipped.
    const full = await run(["chat", "broadcast", "--closed", "--stale", "holler two", "from", "the", "fence"]);
    if (full.exitCode !== 0) {
      console.log(`  FAIL: --closed --stale broadcast exited ${full.exitCode}:\n${full.stderr.toString()}`);
      return "FAIL";
    }
    const fullText = full.stdout.toString();
    for (const needle of [
      "Broadcast from Fence Holler to 6 of 7 registered sessions:",
      "  delivered: alpha-00001 (acme/alpha-proj) [open]",
      "  delivered: beta-00001 (acme/alpha-proj) [open]",
      "  delivered to 2 sessions with no open tab (single nudge; otherwise read at next prompt)",
      "  delivered to 1 mcp session (read at next prompt)",
      "  delivered to 1 stale session (queued; delivered when the session resumes)",
      "Skipped:",
      "  - 1 stale session in acme/alpha-proj",
    ]) {
      if (!fullText.includes(needle)) {
        console.log(`  FAIL: --closed --stale broadcast report missing "${needle}":\n${fullText}`);
        return "FAIL";
      }
    }

    // --project (both flag forms) narrows by exact match; the
    // NULL-project row is counted as out of scope, not skipped. The
    // audience flags ride along so the stale-but-resumable ghost is
    // reached.
    const filtered = await run(["chat", "broadcast", "--project", "acme/alpha-proj", "--project=acme/gamma-proj", "--closed", "--stale", "standup in five"]);
    if (filtered.exitCode !== 0) {
      console.log(`  FAIL: filtered broadcast exited ${filtered.exitCode}:\n${filtered.stderr.toString()}`);
      return "FAIL";
    }
    const filteredText = filtered.stdout.toString();
    for (const needle of [
      "Broadcast from Fence Holler to 5 of 7 registered sessions (projects: acme/alpha-proj, acme/gamma-proj):",
      "  delivered: alpha-00001 (acme/alpha-proj) [open]",
      "  delivered: beta-00001 (acme/alpha-proj) [open]",
      "  delivered to 1 session with no open tab (single nudge; otherwise read at next prompt)",
      "  delivered to 1 mcp session (read at next prompt)",
      "  delivered to 1 stale session (queued; delivered when the session resumes)",
      "Skipped:",
      "  - 1 stale session in acme/alpha-proj",
      "Out of scope (project filter):",
      "  - 1 session with no project",
    ]) {
      if (!filteredText.includes(needle)) {
        console.log(`  FAIL: filtered broadcast report missing "${needle}":\n${filteredText}`);
        return "FAIL";
      }
    }
    if (filteredText.includes("noplan-00001")) {
      console.log(`  FAIL: NULL-project row named instead of counted:\n${filteredText}`);
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
    // alpha, beta, mike (wide default), then alpha, beta, gamma, mike,
    // ghost, dead -- wait: the full-reach run delivered to alpha, beta,
    // gamma (no-tab), mike (mcp), and ghost (queued) = 6; the filtered
    // rerun's fresh rows to alpha, beta, ghost, gamma, mike = 5.
    // 3 + 6 + 5 = 14 delivered rows total.
    if (rows.length !== 14) problems.push(`expected 14 delivered sentinel rows, got ${rows.length}`);
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
    if (cliEvents.length !== 14 || !cliEvents.every((e) => e.event === "sent" && e.broadcast === true && e.body.startsWith(fence))) {
      console.log(`  FAIL: expected 14 fence-noted broadcast sent events from Fence Holler, got:\n${JSON.stringify(cliEvents.slice(0, 3))}`);
      return "FAIL";
    }

    // An identical unread retry is deduped per recipient, and the report
    // says so.
    const retry = await run(["chat", "broadcast", "--project", "acme/alpha-proj", "--project=acme/gamma-proj", "--closed", "--stale", "standup in five"]);
    if (retry.exitCode !== 0 || !retry.stdout.toString().includes("duplicate suppressed for 5 recipients")) {
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
    // Default audience within --project acme/alpha-proj: only the open
    // tabs (alpha, beta) get rows - the stale ghost and dead rows are
    // flag-gated out.
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
