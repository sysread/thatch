import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../src/db";
import { ExtractionPipeline, type ToolInteraction } from "../src/extraction";
import { WatcherRegistry } from "../src/watchers";
import { SharedModelPool } from "../src/embeddings";
import { server } from "../src/index";

// Persistence of volatile plugin-runtime state across v2 plugin reloads and
// process restarts (docs/plans/plugin-state-persistence.md): the runtime
// journals buffers, child bookkeeping, wrap-up arms, and watcher definitions
// into runtime_state; setup() rehydrates same-pid rows (reload) and prunes
// foreign-pid rows unless the session is the startup resume (restart).

let dbDir: string;
let dbPath: string;

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
    db.runtimeStatePut("buffer", "ses_a", [ix("ses_a")]);
    db.runtimeStatePut("buffer", "ses_a", [ix("ses_a"), ix("ses_a", "read")]);
    db.runtimeStatePut("wrapup", "ses_b", { token: "T", kind: "compact" });

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
    db.runtimeStatePut("buffer", "ses_reload", [ix("ses_reload")]);
    // Restart case: foreign pid (the api stamps the current pid by default,
    // so override), no startup resume -> pruned.
    db.runtimeStatePut("buffer", "ses_dead", [ix("ses_dead")], process.pid + 999);
    db.close();

    delete process.env.THATCH_DB_PATH; // ensure the env of other suites leaks nothing
    process.env.THATCH_DB_PATH = dbPath;
    const prevConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(dbDir, "config");

    let hooks: { dispose?: () => Promise<void> } | undefined;
    try {
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
      hooks = (await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree" } as any)) as any;
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
      delete process.env.THATCH_DB_PATH;
    }
  });
});
