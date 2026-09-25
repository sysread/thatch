import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../src/db";
import { ExtractionPipeline, type ToolInteraction } from "../src/extraction";
import { WatcherRegistry } from "../src/watchers";
import { SharedModelPool } from "../src/embeddings";
import { server } from "../src/index";
import { hostedSessionIds } from "../src/chat";

// Persistence of volatile plugin-runtime state across v2 plugin reloads and
// process restarts (docs/dev/features/opencode-plugin.md, the dispose row of
// the capability table): the runtime
// journals buffers, child bookkeeping, wrap-up arms, and watcher definitions
// into runtime_state; setup() rehydrates same-pid rows (reload) and prunes
// foreign-pid rows unless the session is the startup resume (restart).

let dbDir: string;
let dbPath: string;
// The directory the test runtime runs in (the instance-scoping key).
const WORK_DIR = "/tmp/thatch-state-workdir";

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-state-"));
  dbPath = join(dbDir, "test.db");
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
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
  test("same-pid rows survive (reload); foreign-pid rows are pruned", async () => {
    const db = new ThatchDB(dbPath);
    // Reload case: written by THIS process (a v2 plugin reload re-runs
    // setup() in the same pid).
    db.runtimeStatePut("buffer", "ses_reload", [ix("ses_reload")], WORK_DIR);
    // Restart case: foreign pid (the api stamps the current pid by default,
    // so override), no startup resume -> pruned.
    db.runtimeStatePut("buffer", "ses_dead", [ix("ses_dead")], WORK_DIR, process.pid + 999);
    // A foreign-pid hosted set must be dropped too - re-hosting it would
    // wake sessions whose harnesses died with the old process.
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
          delete: async () => {}, messages: async () => ({ data: [] }), status: async () => ({ data: {} }), list: async () => ({ data: [] }),
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
      delete: async () => {}, messages: async () => ({ data: [] }), status: async () => ({ data: {} }), list: async () => ({ data: [] }),
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
        events: ["command_success"], once: true,
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
    // destroyed its crash-recovery state.
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut("buffer", "ses_otherdir", [ix("ses_otherdir")], "/tmp/thatch-state-somewhere-else", -1);
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
    // running. 30s timeout: the reconciler deliberately waits out a 10s
    // reload window first.
    const db = new ThatchDB(dbPath);
    db.runtimeStatePut(
      "child",
      "ses_child_r",
      { parentID: "ses_parent_r", snapshot: [ix("ses_parent_r")], metrics: { new: 1, updated: 0, deleted: 0 } },
      WORK_DIR,
    );
    db.close();

    const { finally: done } = await startServer();
    try {
      // Finalization journals the child row gone (the maps are cleared, and
      // journalChild journals a delete for a parentless child). Poll for it
      // - the reconciler deliberately waits out the reload window first.
      const deadline = Date.now() + 20_000;
      for (;;) {
        const check = new ThatchDB(dbPath);
        const rows = check.runtimeStateAll().filter((r) => r.sessionID === "ses_child_r");
        check.close();
        if (rows.length === 0) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const check = new ThatchDB(dbPath);
      expect(check.runtimeStateAll().some((r) => r.sessionID === "ses_child_r")).toBe(false);
      check.close();
    } finally {
      await done();
    }
  }, 30_000);
});
