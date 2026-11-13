import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { setup as setupV2 } from "../../../src/opencode/v2";
import { makeV2Harness } from "../../mocks/v2-harness";
import { ThatchDB } from "../../../src/db";

/**
 * UC-150: watcher persistence matrix.
 *
 * Automatable: yes - drives the REAL arming tool through the v2 adapter on
 * the shared mock promise context, then walks a watch through every
 * lifecycle boundary it must survive: a same-pid plugin reload (dispose +
 * re-setup), a service restart (the journal row's pid rewritten to a dead
 * foreign one, then the resumed session's first message), and a worktree
 * re-home (the row's directory stamp rewritten, then the session.moved
 * bus event). Finally seeds a gone-session row and lets the boot sweep
 * reclaim it while the live session's row survives. The 2026-11-13
 * watcher-vanishing report (mervyn-of-the-pumpkin-patch + coordinator
 * corroboration) is the incident this use case pins shut.
 */

const SESSION = "qa-150";

const useCase: UseCase = {
  name: "UC-150-watcher-persistence-matrix",
  preconditions: [
    "- The opencode v2 adapter (src/opencode/v2.ts) loadable with a mock promise context",
    "- An isolated fixture with THATCH_DB_PATH and XDG_CONFIG_HOME set",
  ].join("\n"),
  steps: [
    "1. Boot the adapter; arm a command watcher through the real thatch_watch_command_create tool; read back its journal row.",
    "2. Reload leg: dispose and re-setup in the same process. Verify thatch_watch_list still reports the watcher (same-pid rehydration).",
    "3. Restart leg: rewrite the row's pid to a dead foreign pid, dispose, re-setup. Verify the row survives boot dormant; the session's first message re-arms it (notice + live watch_list + the row re-owned by this pid).",
    "4. Re-home leg: rewrite the row's directory stamp to a foreign directory, dispose, re-setup, then queue session.moved pointing at this adapter's directory. Verify the destination adopts: watch_list is live and the row re-stamps here.",
    "5. Sweep leg: seed a gone-session watchers row (no session row in a fixture opencode.db), boot with the sweep enabled and the live session enumerated. Verify the gone row is reclaimed and the live row survives.",
  ].join("\n"),
  expected: [
    "- A watch with live TTL survives a same-pid plugin reload with no model-visible change.",
    "- A watch survives a service restart as a dormant row and re-arms on the resumed session's first message.",
    "- A watch follows its session across a worktree re-home: the destination instance adopts and re-stamps the journal row before any watch tool call.",
    "- The strand sweep reclaims watcher rows whose session is gone from the host db, and never touches a live session's row.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const v2wait = async (desc: string, fn: () => unknown): Promise<boolean> => {
      const end = Date.now() + 5000;
      while (!fn()) {
        if (Date.now() > end) {
          console.log(`  FAIL: timed out waiting for: ${desc}`);
          return false;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return true;
    };
    const OLD_DIR = join(ctx.dir, "old-location");
    mkdirSync(OLD_DIR, { recursive: true });
    const harness = makeV2Harness(ctx.dir, {});
    // The recorder accumulates tools across re-setups (its dispose is a
    // no-op), so each boot marks where its own registrations start.
    let toolMark = 0;
    const boot = async (): Promise<() => Promise<void>> => {
      toolMark = harness.addedTools.length;
      return (await setupV2(harness.context as any)) as () => Promise<void>;
    };
    const tool = (name: string) => {
      const found = harness.addedTools.slice(toolMark).find((t) => t.name === name);
      if (!found) throw new Error(`tool ${name} not registered by this activation`);
      return found;
    };
    const watchList = async (): Promise<string> => {
      const out = await tool("thatch_watch_list").execute({}, { sessionID: SESSION, agent: "build" });
      const text = typeof out === "string" ? out : String((out as { content?: unknown })?.content ?? JSON.stringify(out));
      return text;
    };
    const row = (): { directory: string; pid: number; value: any } | undefined => {
      const check = new ThatchDB(ctx.env.THATCH_DB_PATH);
      try {
        return check.runtimeStateAll().find((r) => r.kind === "watchers" && r.sessionID === SESSION);
      } finally {
        check.close();
      }
    };
    const rowsFor = (sessionID: string): number => {
      const check = new ThatchDB(ctx.env.THATCH_DB_PATH);
      try {
        return check.runtimeStateAll().filter((r) => r.sessionID === sessionID).length;
      } finally {
        check.close();
      }
    };
    const sendMessage = async (): Promise<string[]> => {
      const text = "hi";
      await harness.hooks["prompt"]!({ sessionID: SESSION, messageID: `msg_${Date.now()}`, prompt: { text } });
      const request = { sessionID: SESSION, system: [], messages: [{ role: "user", content: [{ type: "text", text }] }] };
      await harness.hooks["context"]!(request);
      return (request.messages[0].content as any[]).slice(1).map((p: any) => String(p.text ?? ""));
    };
    const rewriteRow = (set: string): void => {
      const raw = new Database(ctx.env.THATCH_DB_PATH);
      raw.run(`UPDATE runtime_state SET ${set} WHERE kind = 'watchers' AND session_id = ?`, [SESSION]);
      raw.close();
    };

    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevData = process.env.XDG_DATA_HOME;
    const prevDb = process.env.THATCH_DB_PATH;
    const prevSweep = process.env.THATCH_STRAND_SWEEP;
    const prevOcDb = process.env.OPENCODE_DB;
    process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
    process.env.XDG_DATA_HOME = ctx.env.XDG_DATA_HOME;
    process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
    process.env.THATCH_STRAND_SWEEP = "off";
    let dispose: (() => Promise<void>) | undefined;
    let sweepDbPath = "";
    try {
      // -- Leg 1: arm through the real tool --------------------------------
      dispose = await boot();
      const armed = await tool("thatch_watch_command_create").execute(
        { command: "false", exit_codes: [0] },
        { sessionID: SESSION, agent: "build" },
      );
      const armedText =
        typeof armed === "string" ? armed : String((armed as { content?: unknown })?.content ?? "");
      if (!armedText.includes("[watching]")) {
        console.log(`  FAIL: arming returned ${armedText}`);
        return "FAIL";
      }
      const watcherId = /id: (\S+)/.exec(armedText)?.[1];
      if (!watcherId || !row()?.value?.length) {
        console.log("  FAIL: the armed watcher never journaled");
        return "FAIL";
      }

      // -- Leg 2: same-pid reload ------------------------------------------
      await dispose();
      dispose = await boot();
      if (!(await watchList()).includes(watcherId)) {
        console.log("  FAIL: the watcher did not survive the same-pid reload");
        return "FAIL";
      }

      // -- Leg 3: restart (dead foreign pid) + first-message rearm ---------
      rewriteRow("pid = -1");
      await dispose();
      dispose = await boot();
      if (row()?.pid !== -1 || !(row()?.value?.length > 0)) {
        console.log("  FAIL: the dormant row did not survive the restart boot");
        return "FAIL";
      }
      const injections = await sendMessage();
      if (!injections.some((t) => t.includes("re-armed"))) {
        console.log("  FAIL: the first message never re-armed the dormant watcher");
        return "FAIL";
      }
      if (!(await watchList()).includes(watcherId) || row()?.pid !== process.pid) {
        console.log("  FAIL: the re-armed watcher is not live and re-owned");
        return "FAIL";
      }

      // -- Leg 4: re-home (foreign directory stamp + session.moved) --------
      rewriteRow(`directory = '${OLD_DIR.replace(/'/g, "''")}'`);
      await dispose();
      dispose = await boot();
      if (row()?.directory !== OLD_DIR) {
        console.log("  FAIL: the re-homed row did not survive the boot partition");
        return "FAIL";
      }
      await harness.queue({
        type: "session.moved",
        data: { sessionID: SESSION, location: { directory: ctx.dir } },
      });
      if (!(await v2wait("moved-in adoption", () => row()?.directory === ctx.dir))) {
        console.log("  FAIL: session.moved never adopted the re-homed session's watchers");
        return "FAIL";
      }
      if (!(await watchList()).includes(watcherId)) {
        console.log("  FAIL: the adopted watcher is not live in the destination instance");
        return "FAIL";
      }

      // -- Leg 5: the sweep reclaims gone sessions, keeps live ones --------
      sweepDbPath = join(ctx.dir, "opencode-sweep.db");
      rmSync(sweepDbPath, { force: true });
      const s = new Database(sweepDbPath);
      s.exec("CREATE TABLE session_v2 (id text PRIMARY KEY, title text, directory text, parent_id text, project_id text)");
      s.exec("CREATE TABLE project (id text PRIMARY KEY, worktree text)");
      // The live session is enumerated at this directory; the gone session
      // has no row at all (deleted with its worktree).
      s.query("INSERT INTO session_v2 VALUES (?, ?, ?, NULL, NULL)").run(SESSION, "watcher matrix", ctx.dir);
      s.close();
      const goneSeed = new ThatchDB(ctx.env.THATCH_DB_PATH);
      try {
        goneSeed.runtimeStatePut(
          "watchers",
          "qa-150-gone",
          [{
            id: "watch_gone", source: "command", sessionID: "qa-150-gone",
            command: "mise run ci-green", cwd: ctx.dir, timeoutMs: 30_000,
            events: ["command_exit"], once: true,
            expiresAt: Date.now() + 600_000, createdAt: Date.now(),
            state: { lastExit: 124 },
          }],
          ctx.dir,
          -1,
        );
      } finally {
        goneSeed.close();
      }
      await dispose();
      delete process.env.THATCH_STRAND_SWEEP;
      process.env.OPENCODE_DB = sweepDbPath;
      dispose = await boot();
      if (!(await v2wait("sweep reclaim", () => rowsFor("qa-150-gone") === 0))) {
        console.log("  FAIL: the sweep never reclaimed the gone session's watcher row");
        return "FAIL";
      }
      if (rowsFor(SESSION) !== 1 || row()?.directory !== ctx.dir) {
        console.log("  FAIL: the sweep disturbed the live session's watcher row");
        return "FAIL";
      }

      return "PASS";
    } finally {
      await dispose?.();
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevData;
      if (prevDb === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDb;
      if (prevSweep === undefined) delete process.env.THATCH_STRAND_SWEEP;
      else process.env.THATCH_STRAND_SWEEP = prevSweep;
      if (prevOcDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = prevOcDb;
      rmSync(sweepDbPath, { force: true });
    }
  },
};

registerUseCase(useCase);
