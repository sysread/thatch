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
// process restarts (docs/plans/plugin-state-persistence.md): the runtime
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
