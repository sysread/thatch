import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../src/opencode/v2";
import { TOOL_DEFS } from "../src/tool-defs";
import {
  addedTools,
  dbDir,
  flowLog,
  makeContext,
  rpcEmitted,
  rpcRegistrations,
  sessionCreateCalls,
  sessionMoveCalls,
  sessionPromptCalls,
  setupTestEnv,
  teardownTestEnv,
} from "./mocks/opencode-v2-harness";

// The session_tab / session_tab_close tool flows through the mocked v2
// adapter: registration schema, spawn ordering, failure narration, and the
// chat-roster pre-registration.

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  setupTestEnv();
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  await teardownTestEnv();
});

describe("opencode v2 adapter", () => {
  test("session_tab registers with a JSON Schema input and the rpc definition", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(rpcRegistrations.map((d) => d.id)).toEqual(["thatch-tabs"]);
    const tool = addedTools.find((t) => t.name === "thatch_session_tab")!;
    expect(tool).toBeDefined();
    // The input schema is pre-converted JSON Schema (the house zod conversion
    // - v2's own converter drops foreign zod and leaves tools parameterless).
    const schema = tool.input as any;
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual(["directory", "prompt", "title", "worktree"]);
    expect(schema.required.sort()).toEqual(["prompt", "title"]);
  });

  test("session_tab directory flow: create -> emit -> prompt, one text body with the coordinator framing", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const tool = addedTools.find((t) => t.name === "thatch_session_tab")!;
    // The tool validates directory existence against the real fs - pass a
    // directory that exists (the test's own sandbox).
    const raw = await tool.execute(
      { prompt: "Run the QA suite", title: "QA run", directory: dbDir },
      { sessionID: "ses_coordinator", agent: "build" },
    );
    const result = typeof raw === "string" ? raw : (raw as any)?.content;

    // Order: create -> emit -> prompt (no move in the directory flow; the
    // chat registration between move and emit is a real-db call and does not
    // appear in the mock log).
    expect(flowLog).toEqual(["create", "emit", "prompt"]);
    expect(sessionCreateCalls[0].title).toBe("QA run");
    expect(sessionCreateCalls[0].location).toEqual({ directory: dbDir });
    expect(sessionCreateCalls[0].metadata.thatch.coordinatorSessionID).toBe("ses_coordinator");
    expect(rpcEmitted).toEqual([
      { name: "tab-opened", data: { sessionID: "v2-test-child", directory: dbDir } },
    ]);
    expect(sessionPromptCalls[0].sessionID).toBe("v2-test-child");
    expect(sessionPromptCalls[0].text.startsWith("Your work session was created by ")).toBe(true);
    expect(sessionPromptCalls[0].text.endsWith("Run the QA suite")).toBe(true);
    // The tool response carries the subordinate's chat name and words the
    // tab honestly (requested, not guaranteed).
    expect(result).toContain("session id: v2-test-child");
    expect(result).toContain("Tab: requested");
  });

  test("session_tab spawn failure names the stranded session and completed steps", async () => {
    // L3: a mid-flow failure (move refused, prompt endpoint down) used to
    // throw bare - the model got no session id, and the created session
    // was stranded (v2 has no session delete, so rollback is not an
    // option either). The error must narrate what completed. The move is
    // the break point: the session exists, nothing else happened.
    const base = mkdtempSync(join(tmpdir(), "thatch-tab-fail-"));
    try {
      const mainRepo = join(base, "main");
      mkdirSync(mainRepo);
      const { $ } = await import("bun");
      const git = async (cmd: string, dir: string) => {
        const proc = await $`git ${cmd.split(" ")}`.cwd(dir).quiet();
        if (proc.exitCode !== 0) throw new Error(`git ${cmd} failed: ${proc.stderr.toString()}`);
      };
      await git("init", mainRepo);
      await git("config user.email test@example.com", mainRepo);
      await git("config user.name Test", mainRepo);
      writeFileSync(join(mainRepo, ".gitkeep"), "");
      await git("add .gitkeep", mainRepo);
      await git("commit -m init", mainRepo);
      const worktree = join(base, "wt-fail");
      await git(`worktree add -b feature ${worktree}`, mainRepo);

      // The worktree flow reaches the move; the location must pass the
      // same-main-checkout check, so the coordinator sits at the main repo.
      cleanup = (await setup(
        makeContext({
          location: { directory: mainRepo, project: { directory: mainRepo, canonical: mainRepo } },
          move: async () => {
            throw new Error("move refused: directory not idle");
          },
        }) as any,
      )) as () => Promise<void>;
      const tool2 = addedTools.find((t) => t.name === "thatch_session_tab")!;
      let message = "";
      try {
        await tool2.execute(
          { prompt: "x", title: "Broken move", worktree },
          { sessionID: "ses_coordinator", agent: "build" },
        );
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("session_tab spawn failed");
      expect(message).toContain("v2-test-child");
      expect(message).toContain("move refused");
      expect(message).toContain("thatch_session_tab_close");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("session_tab refuses a worktree of a different repo", async () => {
    // The default location (SESSION_DIR) is not a git repo; dbDir exists but
    // is not a worktree of anything - the identity check must refuse it.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const tool = addedTools.find((t) => t.name === "thatch_session_tab")!;
    const raw = await tool.execute(
      { prompt: "x", title: "t", worktree: dbDir },
      { sessionID: "ses_coordinator", agent: "build" },
    );
    const result = typeof raw === "string" ? raw : (raw as any)?.content;
    expect(result).toContain("is not a worktree of this session's repository");
    expect(flowLog).toEqual([]);
  });

  test("session_tab worktree flow: create at the coordinator's cwd, move, emit, prompt", async () => {
    // Real worktree: the execute validates same-main-checkout identity with
    // real git (the tests/git-integration.test.ts pattern).
    const base = mkdtempSync(join(tmpdir(), "thatch-tab-flow-"));
    try {
      const mainRepo = join(base, "main");
      mkdirSync(mainRepo);
      const git = async (cmd: string, dir: string) => {
        const { $ } = await import("bun");
        const proc = await $`git ${cmd.split(" ")}`.cwd(dir).quiet();
        if (proc.exitCode !== 0) throw new Error(`git ${cmd} failed: ${proc.stderr.toString()}`);
      };
      await git("init", mainRepo);
      await git("config user.email test@example.com", mainRepo);
      await git("config user.name Test", mainRepo);
      writeFileSync(join(mainRepo, ".gitkeep"), "");
      await git("add .gitkeep", mainRepo);
      await git("commit -m init", mainRepo);
      const worktree = join(base, "wt-feature");
      await git(`worktree add -b feature ${worktree}`, mainRepo);

      // The seam's directory IS the coordinator's cwd - point it at the real
      // main repo so the identity check passes.
      cleanup = (await setup(
        makeContext({ location: { directory: mainRepo, project: { directory: mainRepo, canonical: mainRepo } } }) as any,
      )) as () => Promise<void>;
      const tool = addedTools.find((t) => t.name === "thatch_session_tab")!;
      const raw = await tool.execute(
        { prompt: "Do the work", title: "Worktree worker", worktree },
        { sessionID: "ses_coordinator", agent: "build" },
      );
      const result = typeof raw === "string" ? raw : (raw as any)?.content;
      // Order: create -> move -> emit -> prompt (the chat registration sits
      // between move and emit - a real-db call, not in the mock log).
      expect(flowLog).toEqual(["create", "move", "emit", "prompt"]);
      expect(sessionCreateCalls[0].location).toEqual({ directory: mainRepo });
      expect(sessionMoveCalls[0]).toEqual({ sessionID: "v2-test-child", directory: worktree });
      expect(sessionCreateCalls[0].metadata.thatch.worktree).toBe(worktree);
      expect(sessionPromptCalls[0].text).toContain("Do the work");
      expect(result).toContain(`directory: ${worktree}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("session_tab pre-registers the subordinate in chat under its final directory", async () => {    // Real db on the temp path: assert the roster row directly.
    const { ThatchDB } = await import("../src/db");
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const tool = addedTools.find((t) => t.name === "thatch_session_tab")!;
    const raw = await tool.execute(
      { prompt: "x", title: "Named subordinate", directory: dbDir },
      { sessionID: "ses_coordinator", agent: "build" },
    );
    const result = typeof raw === "string" ? raw : (raw as any)?.content;
    const db = new ThatchDB(join(dbDir, "test.db"));
    try {
      const row = db.findChatSession("v2-test-child");
      expect(row).not.toBeNull();
      expect(row?.session_id).toBe("v2-test-child");
      // The response's chat name matches the row's assigned name.
      expect(result).toContain(`chat name: ${row?.name}`);
    } finally {
      db.close();
    }
  });

  test("session_tab with chat disabled: no roster row, no advertised chat name", async () => {
    // Every other registration path gates on the chat-enabled config; the
    // spawn's pre-registration must too, or the tool advertises a chat
    // name and supervision the roster cannot back.
    const { ThatchDB } = await import("../src/db");
    const { writeFileSync: wf } = await import("node:fs");
    wf(join(dbDir, "config.json"), JSON.stringify({ chat: { enabled: false } }));
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const tool = addedTools.find((t) => t.name === "thatch_session_tab")!;
    const raw = await tool.execute(
      { prompt: "x", title: "Unregistered subordinate", directory: dbDir },
      { sessionID: "ses_coordinator", agent: "build" },
    );
    const result = typeof raw === "string" ? raw : (raw as any)?.content;
    const db = new ThatchDB(join(dbDir, "test.db"));
    try {
      expect(db.findChatSession("v2-test-child")).toBeNull();
      expect(result).toContain("chat name: none");
      // The spawn itself still succeeds - chat off disables supervision,
      // not the subordinate.
      expect(flowLog).toEqual(["create", "emit", "prompt"]);
    } finally {
      db.close();
    }
  });

  test("session_tab_close: resolves the chat name, emits tab-closed, degrades without the seam", async () => {
    // Seed the chat roster with a subordinate, then close it by NAME.
    const { ThatchDB } = await import("../src/db");
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const db = new ThatchDB(join(dbDir, "test.db"));
    try {
      db.registerChatSession("ses_subordinate", "test-owner/test-repo", null, "opencode", null, null);
      const row = db.findChatSession("ses_subordinate");
      expect(row).not.toBeNull();
      const tool = addedTools.find((t) => t.name === "thatch_session_tab_close")!;
      const raw = await tool.execute(
        { session: row?.name },
        { sessionID: "ses_coordinator", agent: "build" },
      );
      const result = typeof raw === "string" ? raw : (raw as any)?.content;
      // The emitted event carries the RESOLVED session id + the chat name
      // (the death-detection consumer keys on the id; notices address by
      // name).
      expect(rpcEmitted).toEqual([
        { name: "tab-closed", data: { sessionID: "ses_subordinate", chatName: row?.name } },
      ]);
      expect(result).toContain("Tab close requested");
      expect(result).toContain("ses_subordinate");
    } finally {
      db.close();
    }
  });

  test("session_tab degrade: no session context and no seam refuse cleanly", async () => {
    const { buildCoreContext } = await import("../src/tool-defs");
    const { ThatchDB } = await import("../src/db");
    const { MockEmbeddingModel } = await import("./mocks/embeddings");
    const def = TOOL_DEFS.find((d) => d.name === "session_tab")!;
    const db = new ThatchDB(join(dbDir, "test.db"));
    try {
      const ctx = buildCoreContext(db, new MockEmbeddingModel(), "test-owner/test-repo");
      expect(await def.execute({ prompt: "p", title: "t" }, ctx, undefined)).toContain("did not provide a session context");
      expect(await def.execute({ prompt: "p", title: "t", directory: "/tmp" }, ctx, { sessionID: "s", agent: "build" })).toContain(
        "did not wire the session-tab surface",
      );
      // The close tool rides the same seam - same refusals.
      const closeDef = TOOL_DEFS.find((d) => d.name === "session_tab_close")!;
      expect(await closeDef.execute({ session: "ses_x" }, ctx, undefined)).toContain("did not provide a session context");
      expect(await closeDef.execute({ session: "ses_x" }, ctx, { sessionID: "s", agent: "build" })).toContain(
        "did not wire the session-tab surface",
      );
    } finally {
      db.close();
    }
  });
});
