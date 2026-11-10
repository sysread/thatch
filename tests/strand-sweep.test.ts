import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { planStrandActions, type StrandPlan } from "../src/runtime";
import { ThatchDB } from "../src/db";
import { TOAST_EVENT } from "../src/session-tab-shared";
import { setup } from "../src/opencode/v2";
import {
  dbDir,
  makeContext,
  rpcEmitted,
  sessionMoveCalls,
  sessionRemoveCalls,
  setupTestEnv,
  teardownTestEnv,
} from "./mocks/opencode-v2-harness";

// These tests pump async events through the v2 adapter harness; under a
// loaded CI runner the pump can lag. Bun's default per-test timeout is 5s
// with no margin for that (the 2026-11-03 fleet-contention CI reds). 90s =
// expected (ms-scale pump handling) x ~900 headroom, above the harness
// waitFor deadline so real hangs report the poll message.
setDefaultTimeout(90_000);

// The stranded-session self-heal: opencode v2 records the directory on every
// session, and a session whose directory is gone (a merged + deleted
// worktree) makes opening it boot a dead path and show the "session location
// unavailable" recovery dialog. The sweep deletes machinery corpses
// (thatch's own extraction children) and MOVES real sessions to their
// project's canonical checkout - never deletes those. planStrandActions is
// the pure decision core and gets the exhaustive coverage here; the
// integration tests prove the wiring (boot sweep fires inside setup(),
// machinery rows reach the host's remove endpoint, one summary toast).

// The sweep must never act on the developer's real opencode.db - but this
// file is the one place it runs, pointed at fixture rows in a fixture
// opencode.db (the v2 adapter enumerates via the db read
// enumerateSweepSessions, not a client list). OPENCODE_DB is set per test
// to the fixture; setupTestEnv's XDG_DATA_HOME isolation covers the tests
// that leave it unset.

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  setupTestEnv();
  // This file is the one place the strand sweep runs; the shared test env
  // defaults it off.
  delete process.env.THATCH_STRAND_SWEEP;
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  await teardownTestEnv();
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

// Builds the fixture opencode.db the v2 adapter's sweep enumeration reads
// (session_v2 rows + the project table's canonical worktree).
function makeOpencodeDb(rows: { id: string; title: string; directory: string; parentId?: string; projectId?: string }[]): string {
  const path = join(dbDir, "opencode.db");
  const raw = new Database(path);
  raw.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT, project_id TEXT)");
  raw.exec("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT)");
  for (const r of rows) {
    raw.run("INSERT INTO session_v2 (id, title, directory, parent_id, project_id) VALUES (?, ?, ?, ?, ?)", [
      r.id, r.title, r.directory, r.parentId ?? null, r.projectId ?? null,
    ]);
  }
  raw.run("INSERT INTO project (id, worktree) VALUES (?, ?)", ["p1", CANONICAL]);
  raw.close();
  return path;
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

  test("canMove false degrades real sessions to skipped (a host with no move endpoint)", () => {
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
  // runtime costs ~2.3s wall on macOS (7.7 CPU-seconds) before the sweep
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
    try {
      cleanup = (await setup(makeContext({
        location: { directory: LIVE_DIR, project: { directory: LIVE_DIR, canonical: LIVE_DIR } },
      }) as any)) as () => Promise<void>;

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
      rmSync(DEAD_DIR, { recursive: true, force: true });
      rmSync(LIVE_DIR, { recursive: true, force: true });
      rmSync(CANONICAL, { recursive: true, force: true });
    }
  }, { timeout: 90_000 });
});

describe("strand sweep integration (v2 db-read enumeration, boot trigger)", () => {
  test("boot sweep deletes machinery corpses through the host, moves the stranded, and toasts once", async () => {
    ensureFixtureDirs();
    // The v2 adapter enumerates via enumerateSweepSessions (a readonly
    // opencode.db read) - point OPENCODE_DB at fixture rows.
    const prevOcDb = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = makeOpencodeDb([
      { id: "ses_corpse", title: "thatch-extraction", directory: DEAD_DIR, projectId: "p1" },
      { id: "ses_live", title: "real work", directory: LIVE_DIR, projectId: "p1" },
      { id: "ses_user_dead", title: "real work", directory: DEAD_DIR, projectId: "p1" },
      { id: "ses_child_dead", title: "review lens", directory: DEAD_DIR, parentId: "ses_parent", projectId: "p1" },
    ]);
    try {
      cleanup = (await setup(makeContext({
        location: { directory: LIVE_DIR, project: { directory: LIVE_DIR, canonical: LIVE_DIR } },
      }) as any)) as () => Promise<void>;

      // The boot sweep is fire-and-forget inside setup(); poll for the
      // corpse's remove call.
      await waitForSweep(() => sessionRemoveCalls.length > 0, "boot sweep never deleted the machinery corpse");

      // Only the machinery corpse was removed; the stranded real session
      // MOVED to its project's canonical checkout; the live-dir session is
      // someone's working state and the task child is opencode's own
      // record - both left alone.
      expect(sessionRemoveCalls).toEqual([{ sessionID: "ses_corpse" }]);
      expect(sessionMoveCalls).toEqual([{ sessionID: "ses_user_dead", directory: CANONICAL }]);

      // One summary toast for the heal, best-effort. The toast lands a few
      // microtasks after the remove call, so poll rather than assert.
      const toasts = rpcEmitted.filter((e) => e.name === TOAST_EVENT);
      await waitForSweep(() => toasts.length > 0, "boot sweep never toasted the heal summary");
      expect(toasts).toHaveLength(1);
      expect(toasts[0].data.message).toContain("healed 2 stranded session");
      expect(toasts[0].data.message).toContain("1 moved, 1 removed");
    } finally {
      if (prevOcDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = prevOcDb;
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
    // The v2 enumerate read fails open: a missing opencode.db resolves to
    // null ("nothing known, do nothing") - the same degrade as every other
    // best-effort capability, never a setup failure.
    const prevOcDb = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = "/nonexistent/opencode.db";
    try {
      cleanup = (await setup(makeContext({
        location: { directory: LIVE_DIR, project: { directory: LIVE_DIR, canonical: LIVE_DIR } },
      }) as any)) as () => Promise<void>;
      // Negative wait: the sweep must NOT act. The degrade (enumerate
      // returns null) completes within a few ms of the server settling, so
      // the settle budget is expected x 100 headroom - long enough that a
      // loaded runner cannot mistake "sweep still starting" for "sweep
      // behaved", short enough not to bloat the gate.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(sessionRemoveCalls).toEqual([]);
      expect(sessionMoveCalls).toEqual([]);
      expect(existsSync(LIVE_DIR)).toBe(true);
    } finally {
      if (prevOcDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = prevOcDb;
      rmSync(LIVE_DIR, { recursive: true, force: true });
    }
  }, { timeout: 90_000 });
});
