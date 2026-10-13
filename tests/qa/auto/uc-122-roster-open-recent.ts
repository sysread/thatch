import { $ } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { readOpenTabSessions } from "../../../src/tab-state";

/**
 * UC-122: Roster OPEN/RECENT liveness from tab state drives broadcast
 * targeting.
 *
 * Automatable: the open-tab reader is a file read (the sandbox XDG state
 * tree holds a tabs.json fixture), and broadcast targeting is a pure
 * store operation over it. Heartbeat freshness alone overcounts: a
 * finished conversation stays fresh until its host stops beating it, and
 * a broadcast to it spends a model turn on a wake that can be swallowed
 * without a tab to receive it. The roster therefore splits fresh rows
 * into open (tab present) and recent (no tab), and broadcast targets
 * only open rows plus MCP rows, listing every skip by name. The CLI
 * guards the Recent section behind `--recent` (default: a muted
 * hidden-count note), mirroring how it guards the Stale section behind
 * `--stale`. With no tab signal at all (tabs disabled, no state tree)
 * everything degrades to recent - a broadcast reaches only MCP
 * sessions, never a false fan-out.
 */

const useCase: UseCase = {
  name: "UC-122-roster-open-recent",
  preconditions: [
    "- No live host needed: the reader is a file read and broadcast targeting is a store operation",
  ].join("\n"),
  steps: [
    "1. Seed a DB with four sessions: stale (aged past two beats), tabbed and tabless (fresh heartbeats), and an MCP row; write a tabs.json fixture giving a tab only to the tabbed session.",
    "2. Broadcast from the MCP row and inspect the result's recipients and skipped lists.",
    "3. Run `thatch chat list` (default hides recent rows behind a muted note) and `thatch chat list --recent`; check the per-row status verdicts.",
    "4. Remove the tabs fixture (no tab signal) and verify the roster degrades every fresh row to recent (hidden by default, revealed by --recent), and a broadcast from the MCP row reaches nobody (the sender is the only MCP row).",
  ].join("\n"),
  expected: [
    "- Step 2: recipients = the tabbed session; skipped names both the tab-less fresh row and the stale row.",
    "- Step 3: the default roster renders the tabbed row open and collapses the tab-less fresh row into the hidden-count note pointing at --recent; `--recent` renders the Recent section with the tab-less row.",
    "- Step 4: with no tab signal every fresh opencode row renders recent (hidden by default, shown by --recent), and a broadcast reaches nobody - no false OPEN-driven fan-out.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(ctx.env).cwd(ctx.dir).quiet().nothrow();

    // Step 1: the fixture tabs.json lives in the sandbox XDG state tree,
    // the root the CLI's reader derives through XDG_STATE_HOME.
    const stateRoot = join(ctx.env.XDG_STATE_HOME, "opencode");
    const tabsFile = join(stateRoot, "latest", "tui", "tabs.json");
    const writeTabs = (sessionIDs: string[]) => {
      mkdirSync(join(stateRoot, "latest", "tui"), { recursive: true });
      writeFileSync(
        tabsFile,
        JSON.stringify({
          global: { tabs: [], unread: {} },
          cwd: {
            "/sandbox/project": { tabs: sessionIDs.map((sessionID) => ({ sessionID, title: "t" })), unread: {} },
          },
        }),
      );
    };
    writeTabs(["ses_tabbed"]);

    const seeded = new ThatchDB(ctx.env.THATCH_DB_PATH, {
      chatOpenTabs: () => readOpenTabSessions(stateRoot),
    });
    try {
      for (const [id, base, kind] of [
        ["ses_tabbed", "tabbed", "opencode"],
        ["ses_tabless", "tabless", "opencode"],
        ["ses_stale", "stale", "opencode"],
        ["ses_mcp", "mickey", "mcp"],
      ] as const) {
        if (!seeded.registerChatSession(id, "acme/widgets", null, kind, base).ok) {
          console.log(`  FAIL: seeding ${id}`);
          return "FAIL";
        }
      }
      // Ses_stale's host process is long gone.
      const { Database } = await import("bun:sqlite");
      const raw = new Database(ctx.env.THATCH_DB_PATH);
      raw.run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_stale'");
      raw.close();

      // Step 2: broadcast from the MCP row. OPEN (tabbed) receives; the
      // tab-less fresh row is skipped (wake not guaranteed without a
      // tab) alongside the stale row.
      const result = seeded.broadcastChatMessage("ses_mcp", "main just moved, rebase if you are based on it");
      if (!result.ok) {
        console.log(`  FAIL: broadcast refused: ${result.error}`);
        return "FAIL";
      }
      if (JSON.stringify(result.recipients) !== JSON.stringify(["tabbed-00001"])) {
        console.log(`  FAIL: expected recipients [tabbed], got: ${JSON.stringify(result.recipients)}`);
        return "FAIL";
      }
      if (JSON.stringify(result.skipped.slice().sort()) !== JSON.stringify(["stale-00001", "tabless-00001"])) {
        console.log(`  FAIL: expected skipped [stale, tabless], got: ${JSON.stringify(result.skipped)}`);
        return "FAIL";
      }

      // Step 3: the default roster shows only open rows - the tab-less
      // fresh row collapses into the hidden-count note pointing at
      // --recent, which reveals the Recent section.
      const list = await run(["chat", "list"]);
      if (list.exitCode !== 0) {
        console.log(`  FAIL: chat list exited ${list.exitCode}`);
        return "FAIL";
      }
      const listText = list.stdout.toString();
      if (!/# Active Sessions/.test(listText) || !/ago\s+open\b/.test(listText)) {
        console.log(`  FAIL: roster missing Active section or open verdict:\n${listText}`);
        return "FAIL";
      }
      if (/ago\s+recent\b/.test(listText) || !/1 recent session hidden/.test(listText) || !/--recent to show/.test(listText)) {
        console.log(`  FAIL: default roster should hide the recent row behind the note:\n${listText}`);
        return "FAIL";
      }
      const withRecent = await run(["chat", "list", "--recent"]);
      if (withRecent.exitCode !== 0) {
        console.log(`  FAIL: chat list --recent exited ${withRecent.exitCode}`);
        return "FAIL";
      }
      const withRecentText = withRecent.stdout.toString();
      if (!/# Recent Sessions/.test(withRecentText) || !/ago\s+recent\b/.test(withRecentText)) {
        console.log(`  FAIL: --recent roster missing the Recent section:\n${withRecentText}`);
        return "FAIL";
      }

      // Step 4: no tab signal - everything degrades to recent (hidden
      // by default, revealed by --recent), and the broadcast's only
      // would-be recipient is the MCP row.
      writeTabs([]);
      const bare = await run(["chat", "list"]);
      if (bare.exitCode !== 0) {
        console.log(`  FAIL: bare chat list exited ${bare.exitCode}`);
        return "FAIL";
      }
      const bareText = bare.stdout.toString();
      if (/ago\s+open\b/.test(bareText) || !/2 recent sessions hidden/.test(bareText)) {
        console.log(`  FAIL: no-tab-signal roster should degrade to recent behind the note:\n${bareText}`);
        return "FAIL";
      }
      const bareRecent = await run(["chat", "list", "--recent"]);
      if (bareRecent.exitCode !== 0) {
        console.log(`  FAIL: bare chat list --recent exited ${bareRecent.exitCode}`);
        return "FAIL";
      }
      const bareRecentText = bareRecent.stdout.toString();
      if (/ago\s+open\b/.test(bareRecentText) || !/ago\s+recent\b/.test(bareRecentText)) {
        console.log(`  FAIL: degraded --recent roster should show only recent rows:\n${bareRecentText}`);
        return "FAIL";
      }
      const degraded = seeded.broadcastChatMessage("ses_mcp", "anyone mounted?");
      if (!degraded.ok || JSON.stringify(degraded.recipients) !== JSON.stringify([])) {
        console.log(`  FAIL: degraded broadcast should reach nobody, got: ${JSON.stringify(degraded)}`);
        return "FAIL";
      }
    } finally {
      seeded.close();
    }
    return "PASS";
  },
};

registerUseCase(useCase);
