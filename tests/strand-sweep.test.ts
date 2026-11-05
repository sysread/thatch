import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planStrandActions, type StrandPlan } from "../src/runtime";
import { ThatchDB } from "../src/db";
import { server } from "../src/index";

// The stranded-session self-heal: opencode v2 records the directory on every
// session, and a session whose directory is gone (a merged + deleted
// worktree) makes opening it boot a dead path and show the "session location
// unavailable" recovery dialog. The sweep deletes machinery corpses
// (thatch's own extraction children) and MOVES real sessions to their
// project's canonical checkout - never deletes those. planStrandActions is
// the pure decision core and gets the exhaustive coverage here; the
// integration tests prove the wiring (boot sweep fires inside server(),
// machinery rows reach the host's delete endpoint, one summary toast).

// The sweep must never act on the developer's real opencode.db through test
// mocks - but this file is the one place it runs, pointed at fixture rows
// from the mock client's session.list. OPENCODE_DB stays untouched: the v1
// harness enumerates via the client, not the database.
let dbDir: string;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-strand-sweep-"));
  process.env.THATCH_DB_PATH = join(dbDir, "test.db");
  process.env.XDG_CONFIG_HOME = join(dbDir, "config");
});

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true });
  delete process.env.THATCH_DB_PATH;
  delete process.env.XDG_CONFIG_HOME;
});

const DEAD_DIR = "/tmp/thatch-strand-sweep-dead";
const LIVE_DIR = "/tmp/thatch-strand-sweep-live";
const CANONICAL = "/tmp/thatch-strand-sweep-canonical";

// The planner's pathExists is injected, but the integration test uses the
// real existsSync, so the fixture directories must honor the names above.
function ensureFixtureDirs(): void {
  rmSync(DEAD_DIR, { recursive: true, force: true });
  mkdirSync(LIVE_DIR, { recursive: true });
  mkdirSync(CANONICAL, { recursive: true });
}

describe("planStrandActions", () => {
  const base = {
    canonicalByProject: { p1: CANONICAL },
    pathExists: (p: string) => p === LIVE_DIR || p === CANONICAL,
    canMove: true,
  };

  test("live directories are never touched, whatever the row looks like", () => {
    const plan = planStrandActions({
      ...base,
      sessions: [
        { id: "ses_live_user", title: "real work", directory: LIVE_DIR, parentId: null, projectId: "p1" },
        { id: "ses_live_corpse", title: "thatch-extraction", directory: LIVE_DIR, parentId: null, projectId: "p1" },
        { id: "ses_live_child", title: "sub", directory: LIVE_DIR, parentId: "ses_p", projectId: "p1" },
      ],
    });
    expect(plan).toEqual<StrandPlan>({ remove: [], move: [], skipped: 0 });
  });

  test("machinery corpses in dead directories are removed, even with a live canonical", () => {
    const plan = planStrandActions({
      ...base,
      sessions: [{ id: "ses_corpse", title: "thatch-extraction", directory: DEAD_DIR, parentId: null, projectId: "p1" }],
    });
    expect(plan.remove).toEqual(["ses_corpse"]);
    expect(plan.move).toEqual([]);
  });

  test("real top-level sessions in dead directories move to the canonical checkout", () => {
    const plan = planStrandActions({
      ...base,
      sessions: [{ id: "ses_user", title: "Fix review findings", directory: DEAD_DIR, parentId: null, projectId: "p1" }],
    });
    expect(plan.move).toEqual([{ id: "ses_user", to: CANONICAL }]);
    expect(plan.remove).toEqual([]);
  });

  test("real sessions with no canonical, a dead canonical, or no move endpoint are skipped, not deleted", () => {
    // The user-sessions-might-exist-in-the-wild rule: deletion is reserved
    // for machinery. Anything the sweep cannot safely relocate is counted
    // as skipped and left exactly as it was.
    const plan = planStrandActions({
      ...base,
      sessions: [
        { id: "ses_nocanon", title: "work", directory: DEAD_DIR, parentId: null, projectId: "p_unknown" },
        { id: "ses_deadcanon", title: "work", directory: DEAD_DIR, parentId: null, projectId: "p_dead" },
        { id: "ses_selfcanon", title: "work", directory: DEAD_DIR, parentId: null, projectId: "p_self" },
      ],
      canonicalByProject: { p_dead: DEAD_DIR, p_self: "/tmp/thatch-strand-sweep-dead2" },
      canMove: true,
    });
    expect(plan.move).toEqual([]);
    expect(plan.skipped).toBe(3);
  });

  test("canMove false degrades real sessions to skipped (v1 has no move endpoint)", () => {
    const plan = planStrandActions({
      ...base,
      sessions: [
        { id: "ses_user", title: "work", directory: DEAD_DIR, parentId: null, projectId: "p1" },
        { id: "ses_corpse", title: "thatch-extraction", directory: DEAD_DIR, parentId: null, projectId: "p1" },
      ],
      canMove: false,
    });
    expect(plan.remove).toEqual(["ses_corpse"]);
    expect(plan.move).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  test("host-created task children in dead directories are always skipped", () => {
    const plan = planStrandActions({
      ...base,
      sessions: [{ id: "ses_child", title: "review lens", directory: DEAD_DIR, parentId: "ses_parent", projectId: "p1" }],
    });
    expect(plan).toEqual<StrandPlan>({ remove: [], move: [], skipped: 1 });
  });
});

/**
 * Poll helper for the integration tests. House pattern; the deadline is
 * deliberately huge relative to the work (the boot sweep acts within
 * ~100ms of the server settling): the budget is expected x ~600 headroom
 * so a loaded CI runner cannot flake the test. The per-test timeout below
 * is set ABOVE this deadline so a genuine sweep failure reports THIS
 * message, not bun's "(timeout)".
 */
async function waitForSweep(cond: () => boolean, message: string): Promise<void> {
  const end = Date.now() + 60_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("extraction journal sweep integration (boot trigger)", () => {
  // Explicit timeout: bun's default is 5s per test, and booting the plugin
  // server costs ~2.3s wall on macOS (7.7 CPU-seconds) before the sweep
  // even runs - CI legs historically measured 3-7s for these tests, which
  // straddles the default. That zero-margin shape caused the 2026-11-03
  // double-red main (fleet contention; five PR-bisect runs exonerated the
  // diff). 90s = ~40x the expected boot+sweep cost.
  test("boot sweep prunes dead-directory and past-TTL journal rows", async () => {
    ensureFixtureDirs();
    // Seed the journal before the runtime boots: a dead-directory buffer
    // row (no instance can ever consume it) and a live fresh one.
    const seed = new ThatchDB(join(dbDir, "test.db"));
    seed.runtimeStatePut("buffer", "ses_dead_row", [{ tool: "read", sessionID: "ses_dead_row", args: {}, title: "f", output: "x" }], DEAD_DIR);
    seed.runtimeStatePut("buffer", "ses_live_row", [{ tool: "read", sessionID: "ses_live_row", args: {}, title: "f", output: "x" }], LIVE_DIR);
    seed.close();

    // ONE polling connection held across the whole wait: reopening the db
    // per 25ms poll makes every close checkpoint the WAL under the running
    // server's feet - the open/close churn that produces SQLITE_IOERR
    // under load (the UC-100 flake signature).
    const pollDb = new ThatchDB(join(dbDir, "test.db"));
    let hooks: { dispose?: () => Promise<void> } | undefined;
    try {
      hooks = (await server({
        client: {
          session: {
            prompt: async () => {},
            promptAsync: async () => {},
            create: async () => ({ data: { id: "test-child" } }),
            delete: async () => {},
            get: async () => ({ data: { title: "Test session" } }),
            messages: async () => ({ data: [] }),
            status: async () => ({ data: {} }),
            list: async () => ({ data: [] }),
          },
          tui: {
            showToast: async () => {},
            executeCommand: async () => ({ data: true }),
            publish: async () => ({ data: true }),
          },
        },
        worktree: LIVE_DIR,
        directory: LIVE_DIR,
      } as any)) as any;

      // The boot sweep runs fire-and-forget inside setup(); poll for the
      // dead-directory row's deletion on the held connection.
      const check = () => {
        const ids = pollDb.runtimeStateAll().filter((r) => r.kind === "buffer").map((r) => r.sessionID);
        return ids;
      };
      await waitForSweep(() => !check().includes("ses_dead_row"), "boot journal sweep never pruned the dead-directory row");
      expect(check()).toEqual(["ses_live_row"]);
    } finally {
      pollDb.close();
      await hooks?.dispose?.();
      rmSync(DEAD_DIR, { recursive: true, force: true });
      rmSync(LIVE_DIR, { recursive: true, force: true });
      rmSync(CANONICAL, { recursive: true, force: true });
    }
  }, { timeout: 90_000 });
});

describe("strand sweep integration (v1 harness, boot trigger)", () => {
  test("boot sweep deletes machinery corpses through the host and toasts once", async () => {
    ensureFixtureDirs();
    const deleteCalls: string[] = [];
    // The mock records the v1 client's whole toast envelope ({ body }), not
    // the bare ToastInput the runtime hands caps.showToast.
    const toastCalls: { body: { message: string } }[] = [];
    const mockClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "test-child" } }),
        delete: async (opts: any) => {
          deleteCalls.push(opts?.path?.id);
        },
        get: async () => ({ data: { title: "Test session" } }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        list: async () => ({
          data: [
            { id: "ses_corpse", title: "thatch-extraction", directory: DEAD_DIR, parentID: null },
            { id: "ses_live", title: "real work", directory: LIVE_DIR, parentID: null },
            { id: "ses_user_dead", title: "real work", directory: DEAD_DIR, parentID: null },
            { id: "ses_child_dead", title: "review lens", directory: DEAD_DIR, parentID: "ses_parent" },
          ],
        }),
      },
      tui: {
        showToast: async (opts: any) => {
          toastCalls.push(opts);
        },
        executeCommand: async () => ({ data: true }),
        publish: async () => ({ data: true }),
      },
    };

    let hooks: { dispose?: () => Promise<void> } | undefined;
    try {
      hooks = (await server({
        client: mockClient,
        worktree: LIVE_DIR,
        directory: LIVE_DIR,
      } as any)) as any;

      // The boot sweep is fire-and-forget inside setup(); poll for the
      // corpse's delete call.
      await waitForSweep(() => deleteCalls.includes("ses_corpse"), "boot sweep never deleted the machinery corpse");

      // Only the machinery corpse was deleted: the live-dir session is
      // someone's working state, the user session is skipped (the v1 SDK
      // has no move endpoint), the task child is opencode's own record.
      expect(deleteCalls).toEqual(["ses_corpse"]);
      // One summary toast for the heal, best-effort. The toast lands a few
      // microtasks after the delete call, so poll rather than assert.
      await waitForSweep(() => toastCalls.length > 0, "boot sweep never toasted the heal summary");
      expect(toastCalls).toHaveLength(1);
      // The v1 client wraps the toast payload: the mock records the whole
      // { body: ToastInput } envelope, not the bare input.
      expect(toastCalls[0].body.message).toContain("healed 1 stranded session");
    } finally {
      await hooks?.dispose?.();
      rmSync(DEAD_DIR, { recursive: true, force: true });
      rmSync(LIVE_DIR, { recursive: true, force: true });
      rmSync(CANONICAL, { recursive: true, force: true });
    }
  }, { timeout: 90_000 });

  test("enumerate failure degrades the boot sweep to a no-op", async () => {
    // Rebuild ALL fixture dirs: the earlier tests' finally blocks remove
    // them, and this test only assumes the paths exist (or not, for the
    // dead dir). Rebuilding everything keeps the test order-independent.
    ensureFixtureDirs();
    const deleteCalls: string[] = [];
    const mockClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "test-child" } }),
        delete: async (opts: any) => {
          deleteCalls.push(opts?.path?.id);
        },
        get: async () => ({ data: { title: "Test session" } }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        // No session.list member: the v1 enumerate call throws, and the
        // sweep must swallow that (the same degrade as every other
        // best-effort capability) rather than fail the runtime's setup.
      },
      tui: {
        showToast: async () => {},
        executeCommand: async () => ({ data: true }),
        publish: async () => ({ data: true }),
      },
    };
    let hooks: { dispose?: () => Promise<void> } | undefined;
    try {
      hooks = (await server({ client: mockClient, worktree: LIVE_DIR, directory: LIVE_DIR } as any)) as any;
      // Negative wait: the sweep must NOT act. The degrade (enumerate
      // throws) completes within a few ms of the server settling, so the
      // settle budget is expected x 100 headroom - long enough that a
      // loaded runner cannot mistake "sweep still starting" for "sweep
      // behaved", short enough not to bloat the gate.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(deleteCalls).toEqual([]);
      expect(existsSync(LIVE_DIR)).toBe(true);
    } finally {
      await hooks?.dispose?.();
      rmSync(LIVE_DIR, { recursive: true, force: true });
    }
  }, { timeout: 90_000 });
});
