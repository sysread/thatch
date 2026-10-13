import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planStrandActions, type StrandPlan } from "../src/runtime";
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
      // corpse's delete call (the house waitFor pattern, inlined).
      const end = Date.now() + 5000;
      while (!deleteCalls.includes("ses_corpse")) {
        if (Date.now() > end) throw new Error("boot sweep never deleted the machinery corpse");
        await new Promise((r) => setTimeout(r, 25));
      }

      // Only the machinery corpse was deleted: the live-dir session is
      // someone's working state, the user session is skipped (the v1 SDK
      // has no move endpoint), the task child is opencode's own record.
      expect(deleteCalls).toEqual(["ses_corpse"]);
      // One summary toast for the heal, best-effort. The toast lands a few
      // microtasks after the delete call, so poll rather than assert.
      const toastEnd = Date.now() + 5000;
      while (toastCalls.length === 0) {
        if (Date.now() > toastEnd) throw new Error("boot sweep never toasted the heal summary");
        await new Promise((r) => setTimeout(r, 25));
      }
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
  });

  test("enumerate failure degrades the boot sweep to a no-op", async () => {
    // This file's first test removes LIVE_DIR in its finally; rebuild it
    // here (the raw server() from src/index does not mkdir, unlike
    // plugin.test.ts's wrapper).
    mkdirSync(LIVE_DIR, { recursive: true });
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
      await new Promise((r) => setTimeout(r, 150));
      expect(deleteCalls).toEqual([]);
      expect(existsSync(LIVE_DIR)).toBe(true);
    } finally {
      await hooks?.dispose?.();
      rmSync(LIVE_DIR, { recursive: true, force: true });
    }
  });
});
