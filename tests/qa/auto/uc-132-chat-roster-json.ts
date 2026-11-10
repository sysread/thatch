import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { mcpSessionID } from "../../../src/chat";

/**
 * UC-132: `chat list` machine-readable roster and host-id lookup
 * (GitHub issue #23).
 *
 * Automatable: the roster is a store read plus pure row shaping. A lane
 * orchestrator (tskmstr) knows each lane's HOST session id and needs the
 * chat name + unread count without learning thatch's hash scheme:
 * `--json` prints one JSON object per row with stable field names,
 * `--host-id` (repeatable) hashes internally and matches rows, and the
 * JSON rows for a lookup echo the caller's id in `host_id` so a multi-id
 * call is joinable. The default text table is byte-identical to before.
 */

const useCase: UseCase = {
  name: "UC-132-chat-roster-json",
  preconditions: [
    "- No live host needed: the roster is a store read and pure row shaping",
  ].join("\n"),
  steps: [
    "1. Seed a DB with an opencode row and an MCP row; give the MCP row unread mail.",
    "2. Run `thatch chat list --json` and `thatch chat list --host-id <host-id> --json`",
    "   (repeatable, one id per lane).",
    "3. Run the text form and `--host-id` in text mode; run a --host-id with no match.",
  ].join("\n"),
  expected: [
    "- Step 2, roster JSONL: one object per row with name, session_id (the",
    "  row's STORED key - hashed for MCP rows), host_kind, project, topic,",
    "  status, last_seen, unread.",
    "- Step 2, lookup JSONL: only the matching rows, each ECHOING the caller's",
    "  host id in host_id - the join works without the caller learning the",
    "  hash scheme. An MCP row matches from the raw host id; case of the",
    "  caller's id does not matter.",
    "- Step 3: the text table is identical across runs with the new flags",
    "  absent (relative-age tokens normalized: they derive from wall-clock",
    "  time), --host-id in text mode renders the matching rows through the same",
    "  table, and a no-match lookup prints a diagnostic line (JSON prints",
    "  nothing).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(ctx.env).cwd(ctx.dir).quiet().nothrow();
    const failures: string[] = [];

    const db = new ThatchDB(ctx.env.THATCH_DB_PATH, { chatOpenTabs: () => new Set() });
    const hostID = "claude-lane-7f3a";
    db.registerChatSession("ses_lane_opencode", "acme/widgets", null, "opencode", null);
    db.registerChatSession(mcpSessionID(hostID), "acme/widgets", "lane 7", "mcp", null);
    // Unread mail for the MCP row: the launcher's prompt-the-idle-lane signal.
    db.sendChatMessage("ses_lane_opencode", mcpSessionID(hostID), "check the flaky test");

    // Step 2a: the roster JSONL.
    const roster = await run(["chat", "list", "--json", "--stale", "all"]);
    if (roster.exitCode !== 0) failures.push("chat list --json exited non-zero");
    const rosterLines = roster.stdout.toString().split("\n").filter((l) => l.trim());
    if (rosterLines.length !== 2) {
      failures.push(`expected 2 JSON rows (opencode + mcp), got ${rosterLines.length}`);
    }
    const rows = rosterLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const mcpJson = rows.find((r) => r.host_kind === "mcp");
    const openJson = rows.find((r) => r.host_kind === "opencode");
    if (!mcpJson || !openJson) {
      failures.push("JSON roster missing a row kind");
    } else {
      for (const row of [mcpJson, openJson]) {
        for (const field of ["name", "session_id", "host_kind", "project", "topic", "status", "last_seen", "unread"]) {
          if (!(field in row)) failures.push(`JSON row missing ${field}`);
        }
        if ("host_id" in row) failures.push("roster JSONL must not carry a host_id echo (that is the lookup contract)");
      }
      if (mcpJson.session_id !== mcpSessionID(hostID)) failures.push("MCP row's session_id should be the stored hashed key");
      if (mcpJson.unread !== 1) failures.push(`MCP row unread should be 1, got ${mcpJson.unread}`);
      if (openJson.unread !== 0) failures.push(`opencode row unread should be 0, got ${openJson.unread}`);
    }

    // Step 2b: the repeatable --host-id lookup with --json; the caller's
    // id case must not matter.
    const lookup = await run(["chat", "list", "--json", "--host-id", hostID.toUpperCase(), "--host-id", "ses_lane_opencode"]);
    if (lookup.exitCode !== 0) failures.push("host-id lookup exited non-zero");
    const lookupLines = lookup.stdout.toString().split("\n").filter((l) => l.trim());
    if (lookupLines.length !== 2) {
      failures.push(`expected 2 lookup rows, got ${lookupLines.length}`);
    }
    const lookupRows = lookupLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    if (lookupRows.length === 2) {
      const mcpEcho = lookupRows.find((r) => r.host_kind === "mcp")!;
      const rawEcho = lookupRows.find((r) => r.host_kind === "opencode")!;
      if (mcpEcho.host_id !== hostID.toUpperCase()) failures.push(`lookup JSONL should echo the CALLER's id, got ${mcpEcho.host_id}`);
      if (mcpEcho.session_id !== mcpSessionID(hostID)) failures.push("lookup row session_id should stay the stored key");
      if (rawEcho.host_id !== "ses_lane_opencode") failures.push("opencode lookup row should echo its raw id");
      if (mcpEcho.unread !== 1) failures.push("lookup row should carry the unread count");
    }

    // Step 3a: the text table is byte-identical with the new flags absent.
    // The relative age cell ("3s ago") is derived from wall-clock time and
    // can tick between the two invocations, so the age tokens are normalized
    // out before comparing: the pin is that the flags do not change the
    // table, not that time stands still between runs.
    const ageStable = (s: string) => s.replace(/\d+[smhd] ago/g, "X ago");
    const textDefault = await run(["chat", "list", "--stale", "all"]);
    const textDefault2 = await run(["chat", "list", "--stale", "all"]);
    if (ageStable(textDefault.stdout.toString()) !== ageStable(textDefault2.stdout.toString())) {
      failures.push("text output is not deterministic across runs");
    }
    if (textDefault.stdout.toString().includes("--json") || textDefault.stdout.toString().includes("host_id")) {
      failures.push("text output should not advertise the machine contract");
    }

    // Step 3b: --host-id in text mode renders through the same table.
    const textLookup = await run(["chat", "list", "--host-id", hostID]);
    if (textLookup.exitCode !== 0) failures.push("text lookup exited non-zero");
    const textOut = textLookup.stdout.toString();
    // The row's name is pool-minted; the rendered table carries the hashed
    // session id and the topic instead.
    if (!textOut.includes("mcp_") || !textOut.includes("lane 7")) {
      failures.push(`text lookup should render the matching row: ${textOut.slice(0, 120)}`);
    }

    // Step 3c: a no-match lookup is loud in text, silent in JSON.
    const textMiss = await run(["chat", "list", "--host-id", "no-such-host-id"]);
    if (!textMiss.stdout.toString().includes("No chat session matches")) {
      failures.push("text no-match should print the diagnostic line");
    }
    const jsonMiss = await run(["chat", "list", "--json", "--host-id", "no-such-host-id"]);
    if (jsonMiss.stdout.toString().trim() !== "") {
      failures.push("JSON no-match should print nothing (zero rows)");
    }

    if (failures.length > 0) {
      for (const f of failures) console.log(`  FAIL: ${f}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
