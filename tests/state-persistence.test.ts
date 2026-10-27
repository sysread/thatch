import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ThatchDB } from "../src/db";
import { ExtractionPipeline, planJournalPrune, EXTRACTION_JOURNAL_KINDS, RUNTIME_STATE_TTL_MS, type ToolInteraction } from "../src/extraction";
import { WatcherRegistry } from "../src/watchers";
import { SharedModelPool } from "../src/embeddings";
import { server } from "../src/index";
import { hostedSessionIds, unexpiredGraceRehosts } from "../src/chat";

// Persistence of volatile plugin-runtime state across v2 plugin reloads and
// process restarts (docs/dev/features/opencode-plugin.md, the dispose row of
// the capability table): the runtime
// journals buffers, child bookkeeping, wrap-up arms, and watcher definitions
// into runtime_state; setup() rehydrates same-pid rows (reload) and prunes
// foreign-pid rows unless the session is the startup resume (restart).

let dbDir: string;
let dbPath: string;
// The directory the test runtime runs in (the instance-scoping key).
// Created eagerly: the delivery guard skips wake attempts when the
// runtime's bound directory is gone, so every fixed fixture directory
// this file binds a runtime to must actually exist.
const WORK_DIR = "/tmp/thatch-state-workdir";
for (const dir of [WORK_DIR, "/tmp/thatch-state-a", "/tmp/thatch-state-b", "/tmp/thatch-test-worktree"]) {
  mkdirSync(dir, { recursive: true });
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-state-"));
  dbPath = join(dbDir, "test.db");
  // The rehydrate tests here drive the restart-branch finalize directly;
  // the boot-time strand sweep stays off so it can never act on the
  // developer's real opencode.db through the mock clients.
  process.env.THATCH_STRAND_SWEEP = "off";
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
  delete process.env.THATCH_STRAND_SWEEP;
});

const ix = (sessionID: string, tool = "bash"): ToolInteraction => ({
  tool,
  sessionID,
  args: { command: "echo hi" },
  title: "echo hi",
  output: "hi",
});

describe("runtime_state db API", () => {
  test("put/get/all/delete round-trip with JSON values", () => {
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("buffer", "ses_a", [ix("ses_a")], "/test/dir");
    db.runtimeStatePut("buffer", "ses_a", [ix("ses_a"), ix("ses_a", "read")], "/test/dir");
    db.runtimeStatePut("wrapup", "ses_b", { token: "T", kind: "compact" }, "/test/dir");

    const rows = db.runtimeStateAll();
    expect(rows).toHaveLength(2);
    const buf = rows.find((r) => r.sessionID === "ses_a");
    expect((buf?.value as ToolInteraction[]).length).toBe(2);
    expect(buf?.pid).toBe(process.pid);

    db.runtimeStateDelete("buffer", "ses_a");
    expect(db.runtimeStateAll().map((r) => r.sessionID)).toEqual(["ses_b"]);
    db.close();
  });
});

describe("ExtractionPipeline journal + hydrate", () => {
  test("mutations journal the session state; hydrate restores it", () => {
    const journal: { kind: string; sessionID: string; value: ToolInteraction[] | undefined }[] = [];
    const pipeline = new ExtractionPipeline((kind, sessionID, value) => journal.push({ kind, sessionID, value }));

    pipeline.push(ix("ses_j"));
    pipeline.accept("ses_j");
    pipeline.consume("ses_j");

    const kinds = journal.map((j) => `${j.kind}:${j.value === undefined ? "clear" : j.value.length}`);
    // push journals the buffer; accept journals the buffer clear AND the
    // accepted hold; consume journals another buffer clear (the accepted
    // hold persists - completeAccepted would clear it separately).
    expect(kinds).toEqual(["buffer:1", "buffer:clear", "accepted:1", "buffer:clear"]);

    // Rehydrate a fresh pipeline from the accepted snapshot mid-flight.
    const restored = new ExtractionPipeline();
    restored.hydrate([], [ix("ses_j")]);
    expect(restored.peekAccepted("ses_j").length).toBe(1);
  });
});

describe("WatcherRegistry journal + hydrate", () => {
  const quietGh: any = async (apiArgs: string[]) => {
    const joined = apiArgs.join(" ");
    if (/\/pulls\/\d+$/.test(joined)) return { head: { sha: "aaaa1111" }, state: "open", merged: false, title: "t", body: "" };
    if (/issues\/\d+\/comments/.test(joined)) return [];
    if (/pulls\/\d+\/comments/.test(joined)) return [];
    if (/check-runs/.test(joined)) return { check_runs: [] };
    if (/^graphql/.test(joined)) return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };
    throw new Error(`no route: ${joined}`);
  };
  const makeRegistry = (journal?: (sessionID: string, watchers: any[]) => void) =>
    new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => false,
      ghRunner: quietGh,
      journal,
      pollIntervalMs: 60_000,
    });

  test("create and cancel journal the session's watcher list", async () => {
    const journal: { sessionID: string; watchers: any[] }[] = [];
    const registry = makeRegistry((sessionID, watchers) => journal.push({ sessionID, watchers }));
    const res = await registry.createPr("ses_w", "sysread/thatch", 16, ["pr_commit", "pr_ci"], {});
    expect(res.ok).toBe(true);
    expect(journal.at(-1)?.watchers.length).toBe(1);

    expect(registry.cancel("ses_w", (res as any).watcher.id)).toBe(true);
    expect(journal.at(-1)?.watchers.length).toBe(0);
  });

  test("hydrate restores watchers without clobbering newer registrations", async () => {
    const registry = makeRegistry();
    const res = await registry.createPr("ses_w", "sysread/thatch", 16, ["pr_commit", "pr_ci"], {});
    const live = (res as any).watcher;
    // A persisted copy of the same watcher (as a reload would read it) plus
    // a stale one under a different id: the live one must win its id.
    registry.hydrate([{ ...live, id: live.id }, { ...live, id: "watch_stale", createdAt: 1 }]);
    expect(registry.listForSession("ses_w").map((w) => w.id).sort()).toEqual([live.id, "watch_stale"].sort());
  });
});

describe("SharedModelPool refcount", () => {
  test("one model per db path; disposed only at zero refs", () => {
    const pool = new SharedModelPool();
    const a = pool.acquire("/tmp/db-a", "test-model");
    const a2 = pool.acquire("/tmp/db-a", "test-model");
    const b = pool.acquire("/tmp/db-b", "test-model");
    expect(a).toBe(a2);
    expect(b).not.toBe(a);
    expect(pool.size).toBe(2);

    pool.release("/tmp/db-a");
    expect(pool.size).toBe(2); // a2 still holds db-a's model
    pool.release("/tmp/db-a");
    expect(pool.size).toBe(1); // only db-b remains
    pool.release("/tmp/db-b");
    expect(pool.size).toBe(0);
  });
});

describe("runtime rehydration through server()", () => {
  test("a foreign-pid extraction-child row is finalized through the host on restart, not just pruned", async () => {
    // The restart-window leak: the child's opencode session row is global
    // and outlives the journaled bookkeeping, so pruning alone left the
    // corpse in the session picker (and -c could land in it). The restart
    // branch must DELETE the child session through the host when the
    // journal row carries the extraction kind.
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut(
      "child",
      "ses_corpse_child",
      { kind: "extraction", parentID: "ses_dead_parent", snapshot: [], metrics: { new: 0, updated: 0, deleted: 0 } },
      WORK_DIR,
      process.pid + 999,
    );
    db.runtimeStatePut(
      "child",
      "ses_task_child",
      { kind: "task", parentID: "ses_dead_parent", snapshot: [], metrics: { new: 0, updated: 0, deleted: 0 } },
      WORK_DIR,
      process.pid + 999,
    );
    db.close();

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
        list: async () => ({ data: [] }),
      },
      tui: {
        showToast: async () => {},
        executeCommand: async () => ({ data: true }),
        publish: async () => ({ data: true }),
      },
    };

    let hooks: { dispose?: () => Promise<void> } | undefined;
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevDbPath = process.env.THATCH_DB_PATH;
    try {
      process.env.THATCH_DB_PATH = dbPath;
      process.env.XDG_CONFIG_HOME = join(dbDir, "config");
      hooks = (await server({ client: mockClient, worktree: WORK_DIR, directory: WORK_DIR } as any)) as any;

      // The finalize is fire-and-forget; poll for the delete call.
      const end = Date.now() + 5000;
      while (!deleteCalls.includes("ses_corpse_child")) {
        if (Date.now() > end) throw new Error("restart finalize never deleted the extraction child");
        await new Promise((r) => setTimeout(r, 25));
      }
      // A task-dispatched sub-agent is opencode's own record of subagent
      // work - the finalize must never touch it.
      expect(deleteCalls).toEqual(["ses_corpse_child"]);
      // Both journal rows are pruned either way (the pre-existing behavior).
      const check = new ThatchDB(dbPath);
      const ids = check.runtimeStateAll().map((r) => r.sessionID);
      expect(ids).not.toContain("ses_corpse_child");
      expect(ids).not.toContain("ses_task_child");
      check.close();
    } finally {
      await hooks?.dispose?.();
      if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevConfig;
      if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDbPath;
    }
  });

  test("same-pid rows survive (reload); foreign-pid rows are pruned", async () => {
    const db = new ThatchDB(dbPath);
    // Reload case: written by THIS process (a v2 plugin reload re-runs
    // setup() in the same pid).
    db.runtimeStatePut("buffer", "ses_reload", [ix("ses_reload")], WORK_DIR);
    // Restart case: foreign pid (the api stamps the current pid by default,
    // so override), no startup resume -> pruned.
    db.runtimeStatePut("buffer", "ses_dead", [ix("ses_dead")], WORK_DIR, process.pid + 999);
    // A foreign-pid hosted set is RE-HOSTED under a grace window now (open
    // TUI tabs reconnect but emit no events until typed into) - the row
    // itself must survive startup so the grace survives further restarts.
    db.runtimeStatePut("hosted", WORK_DIR, ["ses_dead"], WORK_DIR, process.pid + 999);
    db.close();

    let hooks: { dispose?: () => Promise<void> } | undefined;
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevDbPath = process.env.THATCH_DB_PATH;
    try {
      process.env.THATCH_DB_PATH = dbPath;
      process.env.XDG_CONFIG_HOME = join(dbDir, "config");
      const mockClient = {
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
      };
      hooks = (await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree", directory: WORK_DIR } as any)) as any;
      const toolMap = (hooks as any)?.tool as Record<string, { execute: (input: unknown, host?: unknown) => Promise<unknown> }>;

      // Reload row rehydrated: the payload tool serves the buffered entry.
      const payload = await toolMap.thatch_get_extraction_payload.execute({ limit: 20 }, { sessionID: "ses_reload" });
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      expect(text).toContain("echo hi");

      // Foreign-pid row pruned at setup.
      const check = new ThatchDB(dbPath);
      const sessions = check.runtimeStateAll().map((r) => r.sessionID);
      expect(sessions).not.toContain("ses_dead");
      expect(sessions).toContain("ses_reload");
      // The hosted row SURVIVES the restart (grace rehosting): its session
      // set re-hosts under the grace instead of being dropped.
      expect(sessions).toContain(WORK_DIR);
      check.close();
    } finally {
      await hooks?.dispose?.();
      if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevConfig;
      if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDbPath;
    }
  });

  test("a same-pid wrap-up arm rehydrates into pendingWrapUp; a foreign-pid row is pruned", async () => {
    // The rehydration pin for the wrap-up branch (src/runtime.ts, the
    // row.kind === "wrapup" arm of the journal restore): no other test
    // drives the real rehydrate path for wrap-up rows. Observable for
    // "landed back in the map": the greenlight tool flips the rehydrated
    // exit arm and the journal row gains greenlit - a row that never
    // rehydrated would refuse the tool as "no exit in progress".
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("wrapup", "ses_wrap_reload", { kind: "exit" }, WORK_DIR);
    db.runtimeStatePut("wrapup", "ses_wrap_dead", { kind: "exit" }, WORK_DIR, process.pid + 999);
    db.close();

    let hooks: { dispose?: () => Promise<void>; event?: (arg: unknown) => Promise<void>; tool?: Record<string, { execute: (input: unknown, host?: unknown) => Promise<unknown> }> } | undefined;
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevDbPath = process.env.THATCH_DB_PATH;
    try {
      process.env.THATCH_DB_PATH = dbPath;
      process.env.XDG_CONFIG_HOME = join(dbDir, "config");
      const mockClient = {
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
        tui: { showToast: async () => {}, executeCommand: async () => ({ data: true }), publish: async () => ({ data: true }) },
      };
      hooks = (await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree", directory: WORK_DIR } as any)) as any;

      // Foreign-pid row pruned at setup; same-pid row kept (rehydrated).
      const check = new ThatchDB(dbPath);
      const rows = check.runtimeStateAll().filter((r) => r.kind === "wrapup");
      check.close();
      expect(rows.map((r) => r.sessionID)).toEqual(["ses_wrap_reload"]);

      // The rehydrated un-greenlit arm survives the session's first idle:
      // a mid-exit wait must not consume the arm (the fix this branch
      // pins).
      await hooks!.event!({ event: { type: "session.status", properties: { sessionID: "ses_wrap_reload", status: { type: "idle" } } } });
      const mid = new ThatchDB(dbPath);
      expect(mid.runtimeStateAll().some((r) => r.kind === "wrapup" && r.sessionID === "ses_wrap_reload")).toBe(true);
      mid.close();

      // The arm is live in the map: the exit tool greenlights it and the
      // journal row is rewritten with the flag (reload preserves greenlit).
      await hooks!.tool!.thatch_exit.execute({}, { sessionID: "ses_wrap_reload", agent: "build" } as any);
      const after = new ThatchDB(dbPath);
      const arm = after.runtimeStateAll().find((r) => r.kind === "wrapup" && r.sessionID === "ses_wrap_reload");
      after.close();
      expect((arm?.value as any)?.greenlit).toBe(true);
    } finally {
      await hooks?.dispose?.();
      if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevConfig;
      if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDbPath;
    }
  });

  test("a same-pid reload restores a GREENLIT exit arm; the next idle closes", async () => {
    // The greenlit flag is journaled, so a same-pid plugin reload between
    // the tool call and the closing idle cannot strand a greenlit session.
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("wrapup", "ses_wrap_green", { kind: "exit", greenlit: true }, WORK_DIR);
    db.close();

    const published: any[] = [];
    let hooks: { dispose?: () => Promise<void>; event?: (arg: unknown) => Promise<void> } | undefined;
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevDbPath = process.env.THATCH_DB_PATH;
    try {
      process.env.THATCH_DB_PATH = dbPath;
      process.env.XDG_CONFIG_HOME = join(dbDir, "config");
      const mockClient = {
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
        tui: { showToast: async () => {}, executeCommand: async () => ({ data: true }), publish: async (opts: any) => { published.push(opts); return { data: true }; } },
      };
      hooks = (await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree", directory: WORK_DIR } as any)) as any;

      await hooks!.event!({ event: { type: "session.status", properties: { sessionID: "ses_wrap_green", status: { type: "idle" } } } });
      // The close executor ran: the v1 exit host action (app.exit publish).
      expect(published).toHaveLength(1);
      // The resolved arm's journal row is gone.
      const after = new ThatchDB(dbPath);
      expect(after.runtimeStateAll().some((r) => r.kind === "wrapup" && r.sessionID === "ses_wrap_green")).toBe(false);
      after.close();
    } finally {
      await hooks?.dispose?.();
      if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevConfig;
      if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDbPath;
    }
  });

  test("a same-pid reload restores journaled watcher pending events to the live registry", async () => {
    // Regression wiring test for the reload-loss incident (watch_qn449jio):
    // pending events journaled while the session was busy must come back
    // through the REAL rehydrate path in server() setup - the wiring was
    // missing once and a hand-called hydratePending unit test hid it.
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("watcher_pending", "ses_reload", [
      {
        event: { type: "pr_commit", target: "sysread/thatch#16", summary: "new commit aaaa2222", url: "https://github.com/sysread/thatch/pull/16" },
        queuedAt: Date.now(),
      },
    ], WORK_DIR);
    db.close();

    const prompts: Array<{ path?: { id?: string }; body?: { parts?: Array<{ text?: string }> } }> = [];
    let hooks: { dispose?: () => Promise<void>; event?: (arg: unknown) => Promise<void> } | undefined;
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevDbPath = process.env.THATCH_DB_PATH;
    try {
      process.env.THATCH_DB_PATH = dbPath;
      process.env.XDG_CONFIG_HOME = join(dbDir, "config");
      const mockClient = {
        session: {
          prompt: async () => {},
          promptAsync: async (call: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => { prompts.push(call); },
          create: async () => ({ data: { id: "test-child" } }),
          delete: async () => {},
          get: async () => ({ data: { title: "Test session" } }),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
          list: async () => ({ data: [] }),
        },
        tui: { showToast: async () => {}, executeCommand: async () => ({ data: true }), publish: async () => ({ data: true }) },
      };
      const started = (await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree", directory: WORK_DIR } as any)) as any;
      hooks = started;

      // The rehydrated queue delivers on the session's next idle event
      // (deliverPending on idle) - the same trigger the live poller uses.
      await started.event({ event: { type: "session.status", properties: { sessionID: "ses_reload", status: { type: "idle" } } } });
      const nudge = prompts.find((p) => p.body?.parts?.some((pt) => pt.text?.includes("sysread/thatch#16")));
      expect(nudge).toBeTruthy();
      expect(nudge?.path?.id).toBe("ses_reload");

      // Delivered events consume the durable row.
      const check = new ThatchDB(dbPath);
      expect(check.runtimeStateAll().some((r) => r.kind === "watcher_pending" && r.sessionID === "ses_reload")).toBe(false);
      check.close();
    } finally {
      await hooks?.dispose?.();
      if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevConfig;
      if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDbPath;
    }
  });

  test("a second instance on the same db does not hydrate the first's watchers", async () => {
    // Two location instances share one server process AND one db: instance
    // scoping is the directory column, not the pid. Instance B must leave
    // instance A's rows alone (a live sibling owns them) and must not arm
    // its pollers with A's watchers.
    const dirA = "/tmp/thatch-state-a";
    const dirB = "/tmp/thatch-state-b";
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("watchers", "ses_a1", [{ id: "watch_a", source: "pr", sessionID: "ses_a1", repo: "sysread/thatch", pr: 16, events: ["pr_commit"], once: false, expiresAt: Date.now() + 600_000, createdAt: Date.now(), state: { headSha: "aaaa1111" } }], dirA);
    db.close();

    process.env.THATCH_DB_PATH = dbPath;
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevDbPath = process.env.THATCH_DB_PATH;
    let hooksA: { dispose?: () => Promise<void> } | undefined;
    let hooksB: { dispose?: () => Promise<void> } | undefined;
    try {
      process.env.XDG_CONFIG_HOME = join(dbDir, "config");
      const mockClient = {
        session: {
          prompt: async () => {}, promptAsync: async () => {}, create: async () => ({ data: { id: "c" } }),
          delete: async () => {}, get: async () => ({ data: { title: "Test session" } }),
          messages: async () => ({ data: [] }), status: async () => ({ data: {} }), list: async () => ({ data: [] }),
        },
        tui: { showToast: async () => {}, executeCommand: async () => ({ data: true }), publish: async () => ({ data: true }) },
      };
      hooksA = (await server({ client: mockClient, worktree: dirA, directory: dirA } as any)) as any;
      hooksB = (await server({ client: mockClient, worktree: dirB, directory: dirB } as any)) as any;

      // Instance A rehydrated its watcher (same pid, same directory).
      // Instance B must not see it in its own runtime. Observable: B's
      // tool-level watcher list is empty. Drive through B's watch_list tool.
      const listB = await (hooksB as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_b1", agent: "build" });
      const textB = typeof listB === "string" ? listB : JSON.stringify(listB);
      expect(textB).not.toContain("watch_a");
      // A still lists it.
      const listA = await (hooksA as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_a1", agent: "build" });
      const textA = typeof listA === "string" ? listA : JSON.stringify(listA);
      expect(textA).toContain("watch_a");

      // A's journal row survived B's setup (a live sibling - not pruned).
      const check = new ThatchDB(dbPath);
      const rows = check.runtimeStateAll();
      expect(rows.some((r) => r.kind === "watchers" && r.sessionID === "ses_a1")).toBe(true);
      check.close();
    } finally {
      await hooksA?.dispose?.();
      await hooksB?.dispose?.();
      if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevConfig;
      if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDbPath;
    }
  });
});

describe("WatcherRegistry rearm (dormant recovery)", () => {
  const quietGh: any = async (apiArgs: string[]) => {
    const joined = apiArgs.join(" ");
    if (/\/pulls\/\d+$/.test(joined)) return { head: { sha: "aaaa1111" }, state: "open", merged: false, title: "t", body: "" };
    if (/issues\/\d+\/comments/.test(joined)) return [];
    if (/pulls\/\d+\/comments/.test(joined)) return [];
    if (/check-runs/.test(joined)) return { check_runs: [] };
    if (/^graphql/.test(joined)) return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };
    throw new Error(`no route: ${joined}`);
  };
  const makeRegistry2 = (journal?: (sessionID: string, watchers: any[]) => void) =>
    new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => false,
      ghRunner: quietGh,
      journal,
      pollIntervalMs: 60_000,
    });
  const def = (id: string, sessionID: string, overrides: Record<string, unknown> = {}): any => ({
    id,
    source: "pr",
    sessionID,
    repo: "sysread/thatch",
    pr: 16,
    events: ["pr_commit"],
    once: false,
    expiresAt: Date.now() + 600_000,
    createdAt: Date.now(),
    state: { headSha: "aaaa1111" },
    ...overrides,
  });

  test("rearm restores definitions and rewrites the journal under the current pid", async () => {
    const journal: { sessionID: string; watchers: any[] }[] = [];
    const registry = makeRegistry2((sessionID, watchers) => journal.push({ sessionID, watchers }));
    const res = await registry.rearm("ses_w", [def("watch_d1", "ses_w")]);
    expect(res.rearmed).toHaveLength(1);
    expect(res.expired).toBe(0);
    expect(res.failed).toBe(0);
    expect(registry.listForSession("ses_w").map((w) => w.id)).toEqual(["watch_d1"]);
    // The journal rewrite is the point: the dormant row now belongs to this
    // process, so the next reload rehydrates it live.
    expect(journal.at(-1)).toEqual({ sessionID: "ses_w", watchers: res.rearmed });
  });

  test("rearm drops expired definitions and reports the count; an all-expired rearm clears the row", async () => {
    const journal: { sessionID: string; watchers: any[] }[] = [];
    const registry = makeRegistry2((sessionID, watchers) => journal.push({ sessionID, watchers }));
    const res = await registry.rearm("ses_w", [
      def("watch_old", "ses_w", { expiresAt: Date.now() - 1000, createdAt: Date.now() - 5000 }),
      def("watch_fresh", "ses_w"),
    ]);
    expect(res.rearmed.map((w) => w.id)).toEqual(["watch_fresh"]);
    expect(res.expired).toBe(1);

    const gone = makeRegistry2((sessionID, watchers) => journal.push({ sessionID, watchers }));
    const res2 = await gone.rearm("ses_x", [def("watch_old", "ses_x", { expiresAt: Date.now() - 1000 })]);
    expect(res2.rearmed).toHaveLength(0);
    expect(res2.expired).toBe(1);
    // Nothing re-armed -> the journal emits an empty list, deleting the row.
    expect(journal.at(-1)).toEqual({ sessionID: "ses_x", watchers: [] });
  });

  test("rearm revalidates pr targets: an unreachable target drops the definition as failed", async () => {
    const journal: { sessionID: string; watchers: any[] }[] = [];
    const failing = new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => false,
      ghRunner: async () => {
        throw new Error("target gone");
      },
      journal: (sessionID, watchers) => journal.push({ sessionID, watchers }),
      pollIntervalMs: 60_000,
    });
    const res = await failing.rearm("ses_w", [def("watch_gone", "ses_w")]);
    expect(res.rearmed).toHaveLength(0);
    expect(res.failed).toBe(1);
    // Nothing re-armed -> the journal row is cleared.
    expect(journal.at(-1)?.watchers).toEqual([]);
  });

  test("rearm caps at the per-session limit, newest first", async () => {
    const registry = makeRegistry2();
    registry.hydrate([
      def("live_1", "ses_w", { createdAt: 1 }),
      def("live_2", "ses_w", { createdAt: 2 }),
      def("live_3", "ses_w", { createdAt: 3 }),
      def("live_4", "ses_w", { createdAt: 4 }),
    ]);
    const res = await registry.rearm("ses_w", [
      def("dormant_old", "ses_w", { createdAt: 10 }),
      def("dormant_new", "ses_w", { createdAt: 20 }),
      def("dormant_newest", "ses_w", { createdAt: 30 }),
    ]);
    // Budget: 5 max - 4 live = 1 slot, filled by the newest dormant def.
    expect(res.rearmed.map((w) => w.id)).toEqual(["dormant_newest"]);
    expect(registry.listForSession("ses_w")).toHaveLength(5);
  });

  test("rearm does not clobber a live watcher re-registered after the restart", async () => {
    const registry = makeRegistry2();
    const live = def("watch_x", "ses_w", { state: { headSha: "live-sha" } });
    registry.hydrate([live]);
    await registry.rearm("ses_w", [def("watch_x", "ses_w", { state: { headSha: "stale-sha" } })]);
    const now = registry.listForSession("ses_w").find((w) => w.id === "watch_x");
    expect((now as any).state.headSha).toBe("live-sha");
    expect(registry.listForSession("ses_w")).toHaveLength(1);
  });
});

describe("hostedSessionIds (reload re-hosting)", () => {
  test("rehosted sessions join the hosted set; children and duplicates excluded", () => {
    const hosted = hostedSessionIds({
      statusKeys: ["ses_child", "ses_seen", "ses_seen"],
      resumedSessions: ["ses_resumed"],
      rehostedSessions: ["ses_rehydrated", "ses_seen"],
      exclude: ["ses_child"],
    });
    expect(hosted.sort()).toEqual(["ses_rehydrated", "ses_resumed", "ses_seen"]);
  });
});

describe("unexpiredGraceRehosts (restart grace re-hosting)", () => {
  test("live grace entries join the set; expired ones are pruned", () => {
    const now = 1_000_000;
    const grace = new Map<string, number>([
      ["ses_open_tab", now + 60_000],
      ["ses_closed_tab", now - 1],
    ]);
    const live = unexpiredGraceRehosts(grace, now);
    expect(live).toEqual(["ses_open_tab"]);
    expect(grace.has("ses_closed_tab")).toBe(false); // expired: pruned
    expect(grace.has("ses_open_tab")).toBe(true); // live: kept
  });

  test("an empty or fully-expired grace map contributes nothing", () => {
    const grace = new Map<string, number>([["ses_gone", 0]]);
    expect(unexpiredGraceRehosts(grace, Date.now())).toEqual([]);
    expect(grace.size).toBe(0);
  });
});

describe("dormant watcher recovery through server()", () => {
  const prDef = (id: string, sessionID: string, overrides: Record<string, unknown> = {}): any => ({
    id,
    source: "pr",
    sessionID,
    repo: "sysread/thatch",
    pr: 16,
    events: ["pr_commit"],
    once: false,
    expiresAt: Date.now() + 600_000,
    createdAt: Date.now(),
    state: { headSha: "aaaa1111" },
    ...overrides,
  });
  const mockClient = {
    session: {
      prompt: async () => {}, promptAsync: async () => {}, create: async () => ({ data: { id: "c" } }),
      delete: async () => {}, get: async () => ({ data: { title: "Test session" } }),
      messages: async () => ({ data: [] }), status: async () => ({ data: {} }), list: async () => ({ data: [] }),
    },
    tui: { showToast: async () => {}, executeCommand: async () => ({ data: true }), publish: async () => ({ data: true }) },
  };
  const startServer = async () => {
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevDbPath = process.env.THATCH_DB_PATH;
    process.env.THATCH_DB_PATH = dbPath;
    process.env.XDG_CONFIG_HOME = join(dbDir, "config");
    const hooks = (await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree", directory: WORK_DIR } as any)) as any;
    return {
      hooks,
      finally: async () => {
        await hooks?.dispose?.();
        if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevConfig;
        if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
        else process.env.THATCH_DB_PATH = prevDbPath;
      },
    };
  };
  // Short prompt (< MIN_PROMPT_LEN): the recall nudge's embedding-model path
  // stays untouched, keeping the test hermetic.
  const sendMessage = async (hooks: any, sessionID: string): Promise<any[]> => {
    const output: any = { parts: [{ type: "text", text: "hi" }], message: { id: `msg_${sessionID}` } };
    await hooks["chat.message"]({ sessionID, messageID: output.message.id }, output);
    return output.parts;
  };

  test("a restarted session's dormant watchers re-arm on its first message", async () => {
    // Seeded as a COMMAND watcher: rearm() revalidates pr/branch baselines
    // through the registry's real gh runner (network!), so a server()-level
    // test must use the command source - it skips revalidation by design
    // and keeps the test hermetic. CI has no gh CLI; a pr-def rearm would
    // fail the fetch and re-arm nothing.
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut(
      "watchers",
      "ses_w",
      [{
        id: "watch_w", source: "command", sessionID: "ses_w",
        command: "mise run ci-green", cwd: WORK_DIR, timeoutMs: 30_000,
        events: ["command_exit"], once: true,
        expiresAt: Date.now() + 600_000, createdAt: Date.now(),
        state: { lastExit: 124 },
      }],
      WORK_DIR,
      -1,
    );
    db.close();

    const { hooks, finally: done } = await startServer();
    try {
      const parts = await sendMessage(hooks, "ses_w");
      const rearm = parts.find((p: any) => p.synthetic && p.text.includes("re-armed"));
      expect(rearm).toBeTruthy();
      expect(rearm.text).toContain("mise run ci-green");

      // The watcher is live in the registry: watch_list shows it.
      const list = await hooks.tool.thatch_watch_list.execute({}, { sessionID: "ses_w" });
      expect(typeof list === "string" ? list : JSON.stringify(list)).toContain("watch_w");

      // The journal row now belongs to this process, so the next reload
      // rehydrates it live instead of re-dormanting it.
      const check = new ThatchDB(dbPath);
      const row = check.runtimeStateAll().find((r) => r.kind === "watchers" && r.sessionID === "ses_w");
      expect(row?.pid).toBe(process.pid);
      check.close();
    } finally {
      await done();
    }
  });

  test("a live session hears one death notice about dead sessions' watchers; the next session hears none", async () => {
    // A process that already exited: a genuinely dead pid, not a guess.
    const deadPid = Bun.spawnSync(["true"]).pid;
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("watchers", "ses_d1", [prDef("watch_d1", "ses_d1")], WORK_DIR, deadPid);
    db.close();

    const { hooks, finally: done } = await startServer();
    try {
      const p1 = await sendMessage(hooks, "ses_live1");
      const notice = p1.find((p: any) => p.synthetic && p.text.includes("no longer running"));
      expect(notice).toBeTruthy();
      expect(notice.text).toContain("sysread/thatch#16");
      // The dormant row survives the notice - its session may still be
      // resumed, and resuming re-arms it.
      const mid = new ThatchDB(dbPath);
      expect(mid.runtimeStateAll().some((r) => r.sessionID === "ses_d1")).toBe(true);
      mid.close();

      // Deduplicated per process per target: a second live session hears
      // nothing.
      const p2 = await sendMessage(hooks, "ses_live2");
      expect(p2.some((p: any) => p.synthetic && p.text.includes("no longer running"))).toBe(false);
    } finally {
      await done();
    }
  });

  test("a live sibling process's watcher rows are never reported dead", async () => {
    // A v1 sibling TUI window: its own process, same project db, alive for
    // the duration of the test.
    const sibling = Bun.spawn(["sleep", "5"]);
    try {
      const db = new ThatchDB(dbPath);
      db.runtimeStatePut("watchers", "ses_sib", [prDef("watch_s", "ses_sib")], WORK_DIR, sibling.pid);
      db.close();

      const { hooks, finally: done } = await startServer();
      try {
        const parts = await sendMessage(hooks, "ses_live");
        expect(parts.some((p: any) => p.synthetic && p.text.includes("no longer running"))).toBe(false);
      } finally {
        await done();
      }
    } finally {
      sibling.kill();
    }
  });

  test("dormant rows age out at setup past the watcher TTL plus grace", async () => {
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut(
      "watchers",
      "ses_old",
      [prDef("watch_o", "ses_old", { expiresAt: Date.now() - 25 * 60 * 60 * 1000, createdAt: Date.now() - 26 * 60 * 60 * 1000 })],
      WORK_DIR,
      -1,
    );
    db.close();

    const { finally: done } = await startServer();
    try {
      const check = new ThatchDB(dbPath);
      expect(check.runtimeStateAll().some((r) => r.sessionID === "ses_old")).toBe(false);
      check.close();
    } finally {
      await done();
    }
  });

  test("a restart prunes only its own directory's rows - other locations' rows survive", async () => {
    // Two v1 TUI windows on different projects share one thatch db: this
    // instance's restart prune must not sweep the other location's rows -
    // they belong to a live sibling instance's lifecycle, and deleting them
    // destroyed its crash-recovery state. The foreign directory must exist
    // on disk: the extraction journal sweep reclaims rows whose directory
    // is gone, and this test pins the sibling rule for live ones.
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("buffer", "ses_otherdir", [ix("ses_otherdir")], "/tmp/thatch-state-b", -1);
    db.runtimeStatePut("buffer", "ses_own", [ix("ses_own")], WORK_DIR, -1);
    db.close();

    const { finally: done } = await startServer();
    try {
      const check = new ThatchDB(dbPath);
      const sessions = check.runtimeStateAll().map((r) => r.sessionID);
      expect(sessions).toContain("ses_otherdir"); // foreign directory - untouched
      expect(sessions).not.toContain("ses_own"); // own directory, not the startup resume - pruned
      check.close();
    } finally {
      await done();
    }
  });

  test("a restored child that went idle during the reload window is finalized", async () => {
    // Same-pid reload with a child row: the plugin restores `extracting`
    // for the parent - if the child's idle event was lost to the reload
    // window, nothing would ever clear it and BOTH extraction paths stay
    // suppressed for the session's life. The reconciler must finalize the
    // child (delete its session, drop the bookkeeping) when it is no longer
    // running. The production reload window is 10s; the runtime reads it
    // from the environment at call time, so shorten it here - the suite
    // must stay fast, and the wait itself is not what is under test.
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut(
      "child",
      "ses_child_r",
      { parentID: "ses_parent_r", snapshot: [ix("ses_parent_r")], metrics: { new: 1, updated: 0, deleted: 0 } },
      WORK_DIR,
    );
    db.close();

    const prevWindow = process.env.THATCH_CHILD_RECONCILE_MS;
    process.env.THATCH_CHILD_RECONCILE_MS = "50";
    const { finally: done } = await startServer();
    try {
      // Finalization journals the child row gone (the maps are cleared, and
      // journalChild journals a delete for a parentless child). Poll for it
      // - the reconciler waits out the (shortened) reload window first.
      const deadline = Date.now() + 5_000;
      for (;;) {
        const check = new ThatchDB(dbPath);
        const rows = check.runtimeStateAll().filter((r) => r.sessionID === "ses_child_r");
        check.close();
        if (rows.length === 0) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const check = new ThatchDB(dbPath);
      expect(check.runtimeStateAll().some((r) => r.sessionID === "ses_child_r")).toBe(false);
      check.close();
    } finally {
      await done();
      if (prevWindow === undefined) delete process.env.THATCH_CHILD_RECONCILE_MS;
      else process.env.THATCH_CHILD_RECONCILE_MS = prevWindow;
    }
  }, 10_000);

  test("a task-kind child row restores without the extraction sets", async () => {
    // A task-dispatched sub-agent journaled with kind "task" must come back
    // from a reload OUTSIDE the extraction machinery: no `extracting` for
    // the parent (its pending entries must still nudge) and no
    // `extractionChildren` (the child's idle must take the task path, not
    // the extraction branch whose consumeSnapshot drops buffered entries
    // without extraction and deletes a session the task tool needs).
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("child", "ses_task_child", {
      kind: "task", parentID: "ses_parent_t",
      snapshot: [ix("ses_parent_t")], metrics: { new: 0, updated: 0, deleted: 0 },
    }, WORK_DIR);
    db.runtimeStatePut("buffer", "ses_parent_t", [ix("ses_parent_t")], WORK_DIR);
    db.close();

    const { hooks, finally: done } = await startServer();
    try {
      const parts = await sendMessage(hooks, "ses_parent_t");
      // There is no model-facing extraction nudge on opencode any more -
      // chat.message stays clean even with pending entries.
      expect(parts.some((pt: any) => pt.text?.includes("fact-extractor"))).toBe(false);
      // The buffered entries survive the reload and are still served for
      // extraction by the plugin.
      const served = await hooks.tool.thatch_get_extraction_payload.execute(
        { session_id: "ses_parent_t" },
        { sessionID: "ses_ext_t" },
      );
      expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("hi");
      // The task child's row survives - its idle event, not the reconciler,
      // owns its cleanup.
      const check = new ThatchDB(dbPath);
      expect(check.runtimeStateAll().some((r) => r.kind === "child" && r.sessionID === "ses_task_child")).toBe(true);
      check.close();
    } finally {
      await done();
    }
  }, 30_000);

  test("legacy child rows without a kind restore as extraction children", async () => {
    // Pre-marker rows were only meant to hold extraction children, so the
    // default keeps their old restore behavior: `extracting` comes back for
    // the parent and tier 1 stays suppressed while the child runs.
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("child", "ses_legacy_child", {
      parentID: "ses_parent_l",
      snapshot: [ix("ses_parent_l")], metrics: { new: 0, updated: 0, deleted: 0 },
    }, WORK_DIR);
    db.runtimeStatePut("buffer", "ses_parent_l", [ix("ses_parent_l")], WORK_DIR);
    db.close();

    const { hooks, finally: done } = await startServer();
    try {
      const parts = await sendMessage(hooks, "ses_parent_l");
      expect(parts.some((pt: any) => pt.text?.includes("fact-extractor"))).toBe(false);
    } finally {
      await done();
    }
  }, 30_000);

  test("journalChild records the child kind from the live sets", async () => {
    const { hooks, finally: done } = await startServer();
    try {
      // A task-dispatched sub-agent: session.created with a parentID, no
      // extraction machinery - journaled as kind "task".
      await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_j_task", parentID: "ses_j_parent" } } } });
      // An extraction child: buffered parent work + idle triggers the
      // direct-extraction child (the mock client creates session "c").
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "ses_j_parent", callID: "j1", args: { command: "echo hi" } },
        { title: "echo hi", output: "hi", metadata: {} },
      );
      await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_j_parent", status: { type: "idle" } } } });

      const check = new ThatchDB(dbPath);
      const rows = check.runtimeStateAll().filter((r) => r.kind === "child");
      check.close();
      const taskRow = rows.find((r) => r.sessionID === "ses_j_task");
      const extractionRow = rows.find((r) => r.sessionID === "c");
      expect(taskRow?.value ? (taskRow.value as any).kind : undefined).toBe("task");
      expect(extractionRow?.value ? (extractionRow.value as any).kind : undefined).toBe("extraction");
    } finally {
      await done();
    }
  }, 30_000);
});

describe("extraction journal sweep", () => {
  // Minimal boot harness: same shape as the startServer helper in the
  // dormant-watcher describe (which scopes that helper to itself). Env
  // isolation is NOT optional: without THATCH_DB_PATH/XDG_CONFIG_HOME the
  // server boots against the developer's real ~/.config/thatch/thatch.db
  // and the boot sweep acts on it.
  const bootServer = async () => {
    const prevDbPath = process.env.THATCH_DB_PATH;
    const prevConfig = process.env.XDG_CONFIG_HOME;
    process.env.THATCH_DB_PATH = dbPath;
    process.env.XDG_CONFIG_HOME = join(dbDir, "config");
    const hooks = (await server({
      client: {
        session: {
          prompt: async () => {}, promptAsync: async () => {}, create: async () => ({ data: { id: "c" } }),
          delete: async () => {}, get: async () => ({ data: { title: "Test session" } }),
          messages: async () => ({ data: [] }), status: async () => ({ data: {} }), list: async () => ({ data: [] }),
        },
        tui: { showToast: async () => {}, executeCommand: async () => ({ data: true }), publish: async () => ({ data: true }) },
      },
      worktree: "/tmp/thatch-test-worktree",
      directory: WORK_DIR,
    } as any)) as any;
    return {
      hooks,
      finally: async () => {
        await hooks?.dispose?.();
        if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
        else process.env.THATCH_DB_PATH = prevDbPath;
        if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevConfig;
      },
    };
  };

  // The sweep's decision core is planJournalPrune (unit-tested in
  // extraction.test.ts); here it is wired to the real db API: rows seeded
  // through ThatchDB, one backdated past the TTL through raw SQL, deletes
  // applied the way runtime.ts applies them.
  test("prunes dead-directory and past-TTL extraction rows, leaves other kinds", () => {
    const live = "/tmp/thatch-state-a"; // created eagerly at file top
    const dead = join(dbDir, "swept-away-dir"); // never created
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("buffer", "ses_dead", [ix("ses_dead")], dead);
    db.runtimeStatePut("buffer", "ses_live", [ix("ses_live")], live);
    db.runtimeStatePut("buffer", "ses_stale", [ix("ses_stale")], live);
    db.runtimeStatePut("accepted", "ses_dead", [ix("ses_dead")], dead);
    db.runtimeStatePut("wrapup", "ses_wrap", { token: "T", kind: "compact" }, dead);
    // Backdate one live-directory row past the TTL (8 days).
    const raw = new Database(dbPath);
    raw.run(`UPDATE runtime_state SET created_at = ? WHERE kind = 'buffer' AND session_id = 'ses_stale'`, [
      new Date(Date.now() - RUNTIME_STATE_TTL_MS - 86_400_000).toISOString(),
    ]);
    raw.close();

    const doomed = planJournalPrune(db.runtimeStateJournalRows(EXTRACTION_JOURNAL_KINDS), {
      nowMs: Date.now(),
      ttlMs: RUNTIME_STATE_TTL_MS,
      pathExists: (p) => p === live,
    });
    for (const r of doomed) db.runtimeStateDelete(r.kind, r.sessionID);

    const survivors = db.runtimeStateAll().map((r) => `${r.kind}:${r.sessionID}`);
    expect(survivors.sort()).toEqual(["buffer:ses_live", "wrapup:ses_wrap"]);
    db.close();
  });

  test("session.deleted drops the session's buffer journal row", async () => {
    const { hooks, finally: done } = await bootServer();
    try {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "ses_delrow", callID: "dr1", args: { command: "ls" } },
        { title: "list", output: "file.txt", metadata: {} },
      );
      // The row exists while the session lives...
      const before = new ThatchDB(dbPath);
      expect(before.runtimeStateAll().some((r) => r.kind === "buffer" && r.sessionID === "ses_delrow")).toBe(true);
      before.close();

      await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_delrow" } } } });

      // ...and the journal row dies with the session - no future prompt can
      // nudge it, so the row would otherwise strand until a restart.
      const after = new ThatchDB(dbPath);
      expect(after.runtimeStateAll().some((r) => r.kind === "buffer" && r.sessionID === "ses_delrow")).toBe(false);
      after.close();
    } finally {
      await done();
    }
  });

  test("THATCH_RUNTIME_STATE_TTL_MS shortens the sweep's age bound end-to-end", async () => {
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("buffer", "ses_hour_old", [ix("ses_hour_old")], WORK_DIR);
    db.runtimeStatePut("buffer", "ses_fresh", [ix("ses_fresh")], WORK_DIR);
    db.close();
    const raw = new Database(dbPath);
    raw.run(`UPDATE runtime_state SET created_at = ? WHERE session_id = 'ses_hour_old'`, [
      new Date(Date.now() - 3_600_000).toISOString(),
    ]);
    raw.close();

    // A 1-minute TTL dooms the hour-old row but not the fresh one; the env
    // knob is read at sweep time, so no rebuild is needed.
    process.env.THATCH_RUNTIME_STATE_TTL_MS = "60000";
    const { finally: done } = await bootServer();
    try {
      const end = Date.now() + 5000;
      let ids: string[] = [];
      const check = () => {
        const sweeped = new ThatchDB(dbPath);
        ids = sweeped.runtimeStateAll().filter((r) => r.kind === "buffer").map((r) => r.sessionID);
        sweeped.close();
      };
      check();
      while (ids.includes("ses_hour_old")) {
        if (Date.now() > end) throw new Error("boot journal sweep never honored the TTL env override");
        await new Promise((r) => setTimeout(r, 25));
        check();
      }
      expect(ids).toEqual(["ses_fresh"]);
    } finally {
      delete process.env.THATCH_RUNTIME_STATE_TTL_MS;
      await done();
    }
  });

  test("the interval sweep reclaims rows that go stale while the process lives", async () => {
    // Boot wiring for the recurring path: a short THATCH_STRAND_SWEEP_MS
    // makes the shared timer fire the journal sweep every 50ms. The row is
    // doomed by the TTL env knob, not the timer speed.
    process.env.THATCH_STRAND_SWEEP_MS = "50";
    process.env.THATCH_RUNTIME_STATE_TTL_MS = "60000";
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("buffer", "ses_ages", [ix("ses_ages")], WORK_DIR);
    db.close();
    const raw = new Database(dbPath);
    raw.run(`UPDATE runtime_state SET created_at = ? WHERE session_id = 'ses_ages'`, [
      new Date(Date.now() - 3_600_000).toISOString(),
    ]);
    raw.close();

    const { finally: done } = await bootServer();
    try {
      const end = Date.now() + 5000;
      let ids: string[] = [];
      const check = () => {
        const swept = new ThatchDB(dbPath);
        ids = swept.runtimeStateAll().filter((r) => r.kind === "buffer").map((r) => r.sessionID);
        swept.close();
      };
      check();
      while (ids.includes("ses_ages")) {
        if (Date.now() > end) throw new Error("interval journal sweep never ran");
        await new Promise((r) => setTimeout(r, 25));
        check();
      }
    } finally {
      delete process.env.THATCH_STRAND_SWEEP_MS;
      delete process.env.THATCH_RUNTIME_STATE_TTL_MS;
      await done();
    }
  });
});
