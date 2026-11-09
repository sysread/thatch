import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { setup } from "../src/opencode/v2";
import { ThatchDB } from "../src/db";
import { TOOL_DEFS, type ToolDef } from "../src/tool-defs";
import {
  addedTools,
  dbDir,
  makeContext,
  PROJECT_DIR,
  SESSION_DIR,
  sessionMoveCalls,
  sessionRemoveCalls,
  setupTestEnv,
  teardownTestEnv,
  waitFor,
} from "./mocks/opencode-v2-harness";

// These tests pump async events through the v2 adapter harness; under a
// loaded CI runner the pump can lag. Bun's default per-test timeout is 5s
// with no margin for that (the 2026-11-03 fleet-contention CI reds). 90s =
// expected (ms-scale pump handling) x ~900 headroom, above the harness
// waitFor deadline so real hangs report the poll message.
setDefaultTimeout(90_000);

// The v2 adapter's dispose-race tests, on the same mocked context as the
// other opencode-v2-*.test.ts parts (tests/mocks/opencode-v2-harness.ts).

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  setupTestEnv();
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  await teardownTestEnv();
});

// ---------------------------------------------------------------------------
// dispose-race hardening: in-flight drain + retryable closed-db surface
// ---------------------------------------------------------------------------

describe("v2 dispose race hardening", () => {
  // The adapter reads def.execute at call time, so swapping the property on
  // the shared TOOL_DEFS entry redirects the registered wrapper. Restore it
  // so later tests (and other suites importing the same module instance)
  // see the real implementation.
  function stubToolExec(name: string, impl: ToolDef["execute"]): () => void {
    const def = TOOL_DEFS.find((d) => d.name === name)!;
    const original = def.execute;
    def.execute = impl;
    return () => {
      def.execute = original;
    };
  }

  test("cleanup waits for an in-flight tool execute before disposing the runtime", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const restore = stubToolExec("watch_list", async () => {
      await gate;
      return "slow result";
    });
    try {
      const tool = addedTools.find((t) => t.name === "thatch_watch_list")!;
      const call = tool.execute({}, { sessionID: "ses_v2_drain", agent: "build" });
      // Let the execute enter the wrapper (in-flight count 1).
      await new Promise((r) => setTimeout(r, 50));

      let cleaned = false;
      const teardown = cleanup!().then(() => (cleaned = true));
      cleanup = undefined;
      // Still draining: the bounded wait holds dispose back while the
      // execute is in flight.
      await new Promise((r) => setTimeout(r, 150));
      expect(cleaned).toBe(false);

      release();
      const result = await call;
      expect(result).toEqual({ content: "slow result" });
      await teardown;
      expect(cleaned).toBe(true);
    } finally {
      restore();
    }
  });

  test("a closed-database failure becomes a retryable message, not a throw", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const restore = stubToolExec("watch_list", async () => {
      throw new RangeError("Cannot use a closed database");
    });
    try {
      const tool = addedTools.find((t) => t.name === "thatch_watch_list")!;
      const result = (await tool.execute({}, { sessionID: "ses_v2_race", agent: "build" })) as {
        content: string;
      };
      expect(result.content).toContain("plugin was reloaded mid-call");
      expect(result.content).toContain("retry");
    } finally {
      restore();
    }
  });

  test("other tool failures still reject the execute", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const restore = stubToolExec("watch_list", async () => {
      throw new Error("some other failure");
    });
    try {
      const tool = addedTools.find((t) => t.name === "thatch_watch_list")!;
      await expect(tool.execute({}, { sessionID: "ses_v2_boom2", agent: "build" })).rejects.toThrow(
        "some other failure",
      );
    } finally {
      restore();
    }
  });

  test("the boot strand sweep heals stranded sessions through the v2 host", async () => {
    // The self-heal wiring end to end on the REAL adapter: the sweep
    // enumerates via the readonly opencode.db read (OPENCODE_DB fixture),
    // deletes machinery corpses via session.remove, and MOVES real
    // sessions stranded in a dead worktree to the project's canonical
    // checkout - the same outcome as the manual "session location
    // unavailable" recovery, without the picking.
    rmSync("/tmp/thatch-v2-sweep-dead", { recursive: true, force: true });
    const sweepPath = join(dbDir, "sweep-fixture.db");
    const s = new Database(sweepPath);
    s.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, title text, directory text, parent_id text, project_id text)`);
    s.exec(`CREATE TABLE project (id text PRIMARY KEY, worktree text)`);
    s.query("INSERT INTO session_v2 VALUES ('ses_v2_corpse', 'thatch-extraction', '/tmp/thatch-v2-sweep-dead', NULL, 'p1')").run();
    s.query("INSERT INTO session_v2 VALUES ('ses_v2_user', 'Fix review findings', '/tmp/thatch-v2-sweep-dead', NULL, 'p1')").run();
    s.query("INSERT INTO session_v2 VALUES ('ses_v2_child', 'review lens', '/tmp/thatch-v2-sweep-dead', 'ses_parent', 'p1')").run();
    s.query("INSERT INTO project VALUES ('p1', ?)").run(PROJECT_DIR);
    s.close();

    const prevDb = process.env.OPENCODE_DB;
    const prevSweep = process.env.THATCH_STRAND_SWEEP;
    delete process.env.THATCH_STRAND_SWEEP; // the beforeEach set it to "off"
    process.env.OPENCODE_DB = sweepPath;
    try {
      const context = makeContext();
      cleanup = (await setup(context as any)) as () => Promise<void>;

      await waitFor("strand sweep healed the stranded sessions", () => sessionMoveCalls.length === 1 && sessionRemoveCalls.length === 1);
      expect(sessionMoveCalls[0]).toEqual({ sessionID: "ses_v2_user", directory: PROJECT_DIR });
      expect(sessionRemoveCalls[0]).toEqual({ sessionID: "ses_v2_corpse" });
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = prevDb;
      if (prevSweep === undefined) delete process.env.THATCH_STRAND_SWEEP;
      else process.env.THATCH_STRAND_SWEEP = prevSweep;
    }
  });

  test("the boot sweep eagerly un-hosts a session it just moved (L3 of the location-switch fix)", async () => {
    // The sweep can move a session THIS instance still hosts (its row
    // directory is stale-dead while the hosted journal still lists it).
    // The move must release hosting immediately - not on the next
    // session.moved round-trip - so this instance never prompts the moved
    // session through its own directory guard. The hosted journal row is
    // the observable: seeded with the moved id before setup, pruned by the
    // sweep's release.
    rmSync("/tmp/thatch-v2-sweep-dead", { recursive: true, force: true });
    const sweepPath = join(dbDir, "sweep-fixture.db");
    const s = new Database(sweepPath);
    s.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, title text, directory text, parent_id text, project_id text)`);
    s.exec(`CREATE TABLE project (id text PRIMARY KEY, worktree text)`);
    s.query("INSERT INTO session_v2 VALUES ('ses_v2_user', 'Fix review findings', '/tmp/thatch-v2-sweep-dead', NULL, 'p1')").run();
    s.query("INSERT INTO project VALUES ('p1', ?)").run(PROJECT_DIR);
    s.close();

    // Seed hosting for the session the sweep is about to move: a same-pid
    // same-directory hosted row rehydrates into rehostedSessions at setup.
    const seed = new ThatchDB(join(dbDir, "test.db"));
    seed.runtimeStatePut("hosted", SESSION_DIR, ["ses_v2_user"], SESSION_DIR);
    seed.close();

    const prevDb = process.env.OPENCODE_DB;
    const prevSweep = process.env.THATCH_STRAND_SWEEP;
    delete process.env.THATCH_STRAND_SWEEP;
    process.env.OPENCODE_DB = sweepPath;
    try {
      const context = makeContext();
      cleanup = (await setup(context as any)) as () => Promise<void>;

      await waitFor("strand sweep moved the stranded session", () => sessionMoveCalls.length === 1);
      await waitFor("the moved session was eagerly released from hosting", () => {
        const check = new ThatchDB(join(dbDir, "test.db"));
        try {
          const row = check.runtimeStateAll().find((r) => r.kind === "hosted" && r.sessionID === SESSION_DIR);
          const ids = Array.isArray(row?.value) ? (row!.value as string[]) : [];
          return !ids.includes("ses_v2_user");
        } finally {
          check.close();
        }
      });
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = prevDb;
      if (prevSweep === undefined) delete process.env.THATCH_STRAND_SWEEP;
      else process.env.THATCH_STRAND_SWEEP = prevSweep;
    }
  });
});
