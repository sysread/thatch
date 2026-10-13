import { rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { setup as setupV2 } from "../../../src/opencode/v2";
import { makeV2Harness } from "../../mocks/v2-harness";

/**
 * UC-123: stranded-session self-heal sweep.
 *
 * Automatable: yes — seeds a fixture opencode.db (session_v2 + project)
 * with sessions stranded in a directory that does not exist (a merged and
 * deleted worktree), then boots the real v2 adapter with the shared mock
 * promise context. The boot sweep must delete the machinery corpse
 * (thatch-extraction), MOVE the real session to the project's canonical
 * checkout, and leave the task child and live-directory rows alone. The
 * THATCH_STRAND_SWEEP=off kill switch must disarm the sweep entirely.
 */

const useCase: UseCase = {
  name: "UC-123-strand-self-heal",
  preconditions: [
    "- The opencode v2 adapter (src/opencode/v2.ts) loadable with a mock promise context",
    "- An isolated fixture with THATCH_DB_PATH and XDG_CONFIG_HOME set",
  ].join("\n"),
  steps: [
    "1. Seed a fixture opencode.db: a session_v2 table with a thatch-extraction corpse, a real user session, and a task child all pointing at a nonexistent worktree directory, plus a live-directory session; a project table mapping their project to an existing canonical checkout.",
    "2. Load the v2 adapter on a current-host context (session.remove present) and let the boot sweep run.",
    "3. Verify: session.remove carried the corpse's id; session.move carried the real session to the canonical checkout; the task child and the live-directory session were untouched.",
    "4. Re-seed and reload with THATCH_STRAND_SWEEP=off. Verify the sweep is disarmed: no remove, no move.",
  ].join("\n"),
  expected: [
    "- The machinery corpse in the dead directory is deleted via session.remove (the picker stops surfacing it).",
    "- The real session in the dead directory is MOVED to the project's canonical checkout, never deleted (history preserved, the recovery dialog stops firing).",
    "- Task-tool children and sessions in live directories are never touched.",
    "- THATCH_STRAND_SWEEP=off disables both the deletions and the moves.",
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

    const runLeg = async (options: { killSwitch?: boolean }): Promise<{removed: string[]; moved: any[]}> => {
      // A child of the existing sandbox dir that is never created: the
      // dead-worktree path the fixture sessions point at.
      const DEAD_DIR = join(ctx.dir, "deleted-worktree");
      rmSync(DEAD_DIR, { recursive: true, force: true });
      const sweepDbPath = join(ctx.env.XDG_CONFIG_HOME, "sweep-fixture.db");
      rmSync(sweepDbPath, { force: true });
      const s = new Database(sweepDbPath);
      s.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, title text, directory text, parent_id text, project_id text)`);
      s.exec(`CREATE TABLE project (id text PRIMARY KEY, worktree text)`);
      s.query("INSERT INTO session_v2 VALUES ('qa-123-corpse', 'thatch-extraction', ?, NULL, 'p1')").run(DEAD_DIR);
      s.query("INSERT INTO session_v2 VALUES ('qa-123-user', 'Fix review findings', ?, NULL, 'p1')").run(DEAD_DIR);
      s.query("INSERT INTO session_v2 VALUES ('qa-123-child', 'review lens', ?, 'ses_parent', 'p1')").run(DEAD_DIR);
      s.query("INSERT INTO session_v2 VALUES ('qa-123-live', 'live work', ?, NULL, 'p1')").run(ctx.dir);
      s.query("INSERT INTO project VALUES ('p1', ?)").run(ctx.dir);
      s.close();

      const harness = makeV2Harness(ctx.dir, { remove: true, childID: "qa-123-spawn-child" });
      let dispose: (() => Promise<void>) | undefined;
      const prevXdg = process.env.XDG_CONFIG_HOME;
      const prevData = process.env.XDG_DATA_HOME;
      const prevDb = process.env.THATCH_DB_PATH;
      const prevOpencodeDb = process.env.OPENCODE_DB;
      const prevSweep = process.env.THATCH_STRAND_SWEEP;
      process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
      // XDG_DATA_HOME isolation (the runner's scratch tree has no
      // opencode.db): the sweep must never fall through to the host's real
      // database when a concurrent use case's env wins a race on
      // OPENCODE_DB (test.concurrent runs use cases in one process).
      process.env.XDG_DATA_HOME = ctx.env.XDG_DATA_HOME;
      process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
      process.env.OPENCODE_DB = sweepDbPath;
      if (options.killSwitch) process.env.THATCH_STRAND_SWEEP = "off";
      else delete process.env.THATCH_STRAND_SWEEP;
      try {
        dispose = (await setupV2(harness.context as any)) as () => Promise<void>;
        // The boot sweep is fire-and-forget inside setup(); give it a beat
        // in the kill-switch leg (nothing to poll for) and poll in the
        // healing leg.
        if (!options.killSwitch) {
          if (!(await v2wait("corpse removed", () => harness.calls.remove.some((c: any) => c.sessionID === "qa-123-corpse")))) {
            return { removed: harness.calls.remove.map((c: any) => c.sessionID), moved: harness.calls.move };
          }
        } else {
          await new Promise((r) => setTimeout(r, 300));
        }
        return { removed: harness.calls.remove.map((c: any) => c.sessionID), moved: harness.calls.move };
      } finally {
        await dispose?.();
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevData;
        if (prevDb === undefined) delete process.env.THATCH_DB_PATH;
        else process.env.THATCH_DB_PATH = prevDb;
        if (prevOpencodeDb === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = prevOpencodeDb;
        if (prevSweep === undefined) delete process.env.THATCH_STRAND_SWEEP;
        else process.env.THATCH_STRAND_SWEEP = prevSweep;
        rmSync(sweepDbPath, { force: true });
        rmSync(DEAD_DIR, { recursive: true, force: true });
      }
    };

    const healed = await runLeg({});
    if (!healed.removed.includes("qa-123-corpse")) {
      console.log(`  FAIL: the machinery corpse was not removed, got ${JSON.stringify(healed.removed)}`);
      return "FAIL";
    }
    const movedUser = healed.moved.find((m: any) => m.sessionID === "qa-123-user");
    if (!movedUser || movedUser.directory !== ctx.dir) {
      console.log(`  FAIL: the real session should move to the canonical checkout, got ${JSON.stringify(healed.moved)}`);
      return "FAIL";
    }
    if (healed.removed.includes("qa-123-child") || healed.moved.some((m: any) => m.sessionID === "qa-123-child")) {
      console.log("  FAIL: the task child must never be touched");
      return "FAIL";
    }
    if (healed.removed.includes("qa-123-live") || healed.moved.some((m: any) => m.sessionID === "qa-123-live")) {
      console.log("  FAIL: sessions in live directories must never be touched");
      return "FAIL";
    }

    const disarmed = await runLeg({ killSwitch: true });
    if (disarmed.removed.length > 0 || disarmed.moved.length > 0) {
      console.log(`  FAIL: THATCH_STRAND_SWEEP=off must disarm the sweep, got ${JSON.stringify(disarmed)}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
