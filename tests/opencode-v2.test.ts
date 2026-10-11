import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { setup, eventMatchesInstance, flattenToolContent, mapSessionContextMessages, translateEvent } from "../src/opencode/v2";
import { EXIT_TAB_CLOSED_EVENT, TAB_CLOSED_EVENT, TOAST_EVENT, exitTabClosedEventType, tabClosedEventType, tabOpenedEventType } from "../src/session-tab-shared";
import { TOOL_DEFS, type ToolDef } from "../src/tool-defs";

// Mock @huggingface/transformers (same as tests/plugin.test.ts): without it,
// every setup() builds a real BgeEmbeddingModel and the runtime's embedding
// calls would download a model.
mock.module("@huggingface/transformers", () => ({
  env: {},
  pipeline: async () => async (text: string, _opts: any) => {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h) + text.charCodeAt(i);
      h |= 0;
    }
    h ^= 0x9e3779b9;
    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      h |= 0;
      vec[i] = h / 0x80000000;
    }
    return { data: vec };
  },
}));

// The v2 adapter's contract test: a mocked v2 promise context (plain
// objects, call-recording arrays - the house pattern from
// tests/plugin.test.ts) driving the real runtime through the adapter.

const SESSION_DIR = "/tmp/thatch-v2-test-session";
const PROJECT_DIR = "/tmp/thatch-v2-test-project";

type HookFn = (input: any) => any;
type Registration = { dispose: () => void };

let dbDir: string;
let promptHook: HookFn | undefined;
let contextHook: HookFn | undefined;
let toolAfterHook: HookFn | undefined;
let addedCommands: { name: string; execute: (input: any) => Promise<void> }[];
let addedTools: {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, toolContext?: { sessionID: string; agent: string }) => Promise<unknown>;
}[];
let sessionPromptCalls: any[];
let sessionSyntheticCalls: any[];
let sessionCreateCalls: any[];
let sessionGetCalls: any[];
let sessionContextCalls: any[];
let sessionCompactCalls: any[];
let sessionRemoveCalls: any[];
let sessionMoveCalls: any[];
let rpcRegistrations: any[];
let rpcEmitted: { name: string; data: any }[];
// Shared call log across the mocked session/rpc domains: the session-tab
// execute flow's ordering (create -> move -> emit -> prompt) is load-bearing
// (docs/dev/features/session-tabs.md, "How it works"), and the flow spans four
// different mocks - only a shared log can assert relative order.
const flowLog: string[] = [];
const eventQueue: any[] = [];

function makeContext(options?: {
  get?: (input: any) => Promise<any>;
  context?: (input: any) => Promise<any>;
  location?: { directory: string; project: { directory: string; canonical: string } };
  move?: (input: any) => Promise<any>;
  // A session.compact member (upstream #52385). Absent by default so the
  // default context models the older SDK floor the adapter must guard.
  compact?: (input: any) => Promise<any>;
  // A session.remove member (upstream #52387), same floor rule as compact.
  remove?: (input: any) => Promise<any>;
  // Omit the rpc domain entirely: the older SDK floor without the
  // session-tab surface.
  omitRpc?: boolean;
}) {
  addedTools = [];
  sessionPromptCalls = [];
  sessionSyntheticCalls = [];
  sessionCreateCalls = [];
  sessionGetCalls = [];
  sessionContextCalls = [];
  sessionCompactCalls = [];
  sessionRemoveCalls = [];
  sessionMoveCalls = [];
  rpcRegistrations = [];
  rpcEmitted = [];
  flowLog.length = 0;
  promptHook = undefined;
  contextHook = undefined;
  toolAfterHook = undefined;
  addedCommands = [];
  const context: Record<string, any> = {
    location: options?.location ?? { directory: SESSION_DIR, project: { directory: PROJECT_DIR, canonical: PROJECT_DIR } },
    command: {
      transform: async (callback: (editor: any) => void): Promise<Registration> => {
        callback({
          add: (definition: any) => addedCommands.push(definition),
        });
        return { dispose: () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: any) => void): Promise<Registration> => {
        callback({
          add: (tool: any) => addedTools.push({ name: tool.name, description: tool.description, input: tool.input, execute: tool.execute }),
        });
        return { dispose: () => {} };
      },
      hook: async (name: string, callback: HookFn): Promise<Registration> => {
        if (name === "execute.after") toolAfterHook = callback;
        return { dispose: () => {} };
      },
    },
    session: {
      hook: async (name: string, callback: HookFn): Promise<Registration> => {
        if (name === "prompt") promptHook = callback;
        if (name === "context") contextHook = callback;
        return { dispose: () => {} };
      },
      create: async (input: any) => {
        sessionCreateCalls.push(input);
        flowLog.push("create");
        // The real promise client returns the created SessionInfo directly
        // (the envelope types are `{data: X}["data"]` indexed - unwrapped).
        return { id: "v2-test-child" };
      },
      move: async (input: any) => {
        sessionMoveCalls.push(input);
        flowLog.push("move");
        if (options?.move) return options.move(input);
        return {};
      },
      get: async (input: any) => {
        sessionGetCalls.push(input);
        if (options?.get) return options.get(input);
        return { title: "some title" };
      },
      context: async (input: any) => {
        sessionContextCalls.push(input);
        if (options?.context) return options.context(input);
        return [];
      },
      prompt: async (input: any) => {
        sessionPromptCalls.push(input);
        flowLog.push("prompt");
        return {};
      },
      synthetic: async (input: any) => {
        sessionSyntheticCalls.push(input);
        return {};
      },
      ...(options?.compact
        ? {
            compact: async (input: any) => {
              sessionCompactCalls.push(input);
              return options.compact!(input);
            },
          }
        : {}),
      ...(options?.remove
        ? {
            remove: async (input: any) => {
              sessionRemoveCalls.push(input);
              return options.remove!(input);
            },
          }
        : {}),
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          // Poll instead of promise-waiting: a wake signal sent while the
          // pump is still processing the previous event would be lost, and
          // the last queued event would never yield.
          while (!signal.aborted) {
            if (eventQueue.length > 0) yield eventQueue.shift();
            else await new Promise((r) => setTimeout(r, 5));
          }
        })(),
    },
  };
  if (!options?.omitRpc) {
    context.rpc = {
      register: async (
        definition: any,
        _handlers: any,
      ): Promise<{ dispose: () => void; events: { emit: (name: string, data: any) => Promise<void> } }> => {
        rpcRegistrations.push(definition);
        return {
          dispose: () => {},
          events: {
            emit: async (name: string, data: any) => {
              rpcEmitted.push({ name, data });
              flowLog.push("emit");
            },
          },
        };
      },
    };
  }
  return context;
}

async function queueEvent(event: any): Promise<void> {
  eventQueue.push(event);
  // The mock generator polls every 5ms; give it a beat to start consuming.
  await new Promise((r) => setTimeout(r, 15));
}

/** Polls until `fn` is truthy (the pump's handlers are async); 5s deadline. */
async function waitFor(desc: string, fn: () => unknown): Promise<void> {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-v2-test-"));
  process.env.THATCH_DB_PATH = join(dbDir, "test.db");
  // Redirect skill installation away from the real ~/.config.
  process.env.XDG_CONFIG_HOME = join(dbDir, "config");
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  delete process.env.THATCH_DB_PATH;
  delete process.env.XDG_CONFIG_HOME;
  rmSync(dbDir, { recursive: true, force: true });
});

describe("translateEvent session.created parentID", () => {
  test("maps the parent link from info.parentID (v2 payload shape)", () => {
    // v2 publishes the v1-compat payload { sessionID, info: SessionInfo };
    // the task tool dispatches sub-agents with a parentID, and the runtime's
    // childToParent map reads properties.info.parentID.
    const [event] = translateEvent({
      type: "session.created",
      data: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_parent" } },
    });
    expect(event.type).toBe("session.created");
    expect(event.properties.info.id).toBe("ses_child");
    expect(event.properties.info.parentID).toBe("ses_parent");
  });

  test("falls back to a top-level parentID", () => {
    const [event] = translateEvent({
      type: "session.created",
      data: { sessionID: "ses_child", parentID: "ses_parent" },
    });
    expect(event.properties.info.parentID).toBe("ses_parent");
  });
});

describe("opencode v2 adapter", () => {
  test("setup registers every TOOL_DEF through the ToolEditor with thatch_ names", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const names = addedTools.map((t) => t.name);
    expect(addedTools.length).toBe(TOOL_DEFS.length);
    for (const def of TOOL_DEFS) expect(names).toContain(`thatch_${def.name}`);
    for (const tool of addedTools) expect(tool.description).toBeTruthy();
  });

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


  test("system prompt hook injects the thatch system prompt", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(contextHook).toBeDefined();
    // v2 system parts are {type: "text", text} objects; the adapter must
    // convert the runtime's plain strings before pushing.
    const system: unknown[] = [];
    await contextHook!({ system });
    expect(system.length).toBe(1);
    const part = system[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("Persistence");
    expect(part.text).toContain("thatch_memory_remember");
  });

  test("prompt hook preserves the user's text when nothing fires", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(promptHook).toBeDefined();
    const prompt = { text: "remember the thing we discussed about deployment" };
    await promptHook!({ sessionID: "ses_v2_a", messageID: "msg_1", prompt });
    // The runtime buffered no tool interactions, so no extraction nudge
    // fires and no injection appends.
    expect(prompt.text).toBe("remember the thing we discussed about deployment");
  });

  test("nudges stay out of the stored prompt and ride the context hook", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(toolAfterHook).toBeDefined();
    expect(contextHook).toBeDefined();
    // Buffer a tool interaction through the v2 execute.after hook, then
    // send a prompt: nothing may touch prompt.text (v2 stores prompt text
    // as the user message - injecting there would echo any injection into
    // the visible transcript). There is no extraction nudge on opencode at
    // all any more - extraction is plugin-driven at idle.
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_v2_nudge",
      input: { file_path: "/src/app.ts" },
      status: "completed",
      result: { content: "const x = 1;" },
    });
    const prompt = { text: "what do we know about this" };
    await promptHook!({ sessionID: "ses_v2_nudge", messageID: "msg_n", prompt });
    expect(prompt.text).toBe("what do we know about this");

    // The context hook must not inject an extraction nudge into the
    // outbound request either: the model-facing handshake is gone.
    const request = {
      sessionID: "ses_v2_nudge",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "what do we know about this" }] }],
    };
    await contextHook!(request);
    const parts = request.messages[0].content as { type: string; text: string }[];
    expect(parts.length).toBe(1);
    expect(parts[0].text).not.toContain("thatch_get_extraction_payload");
  });

  test("event pump drops events from other directories and serves matching ones", async () => {
    const context = makeContext();
    cleanup = (await setup(context as any)) as () => Promise<void>;

    // Buffer an interaction so the matching idle event triggers direct
    // extraction (session.create) - the observable for "the runtime got it".
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_v2_new",
      input: { file_path: "/src/app.ts" },
      status: "completed",
      result: { content: "const x = 1;" },
    });

    // v2 bus shape: payload in `data`; the pump translates the execution
    // lifecycle into the runtime's v1-shaped events.
    // Foreign-directory event: the pump must drop it.
    await queueEvent({
      type: "session.execution.started",
      location: { directory: "/some/other/dir" },
      data: { sessionID: "ses_v2_new" },
    });
    // Location-less event: dropped (v1's server-side filter shape) - the
    // resolver runs but the mock's session.get returns no location, so the
    // event's directory cannot be established.
    await queueEvent({
      type: "session.execution.started",
      data: { sessionID: "ses_v2_new" },
    });

    // Only a matching-directory event reaches the runtime, whose idle
    // handler triggers direct extraction through the capabilities. v2's
    // create has no parentID: a top-level session in the parent's project
    // directory (the runtime sets the child mapping eagerly).
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_new" },
    });
    await waitFor("direct extraction for ses_v2_new", () => sessionCreateCalls.length === 1);
    expect(sessionCreateCalls[0].title).toBe("thatch-extraction");
    expect(sessionCreateCalls[0].location.directory).toBe(PROJECT_DIR);
  });

  test("pump: tab rpc events carry the payload's own directory, never the publisher's location stamp", async () => {
    // Regression (M2): tab-opened/tab-closed events are stamped with the
    // PUBLISHING instance's location. Caching that against the
    // subordinate's sessionID pinned its location-less execution events to
    // the coordinator's instance - the worktree instance that owns the
    // subordinate dropped its idle signal, and the coordinator
    // double-processed it. The payload's directory field (the subordinate's
    // final, post-move directory) is the authoritative cache source.
    const WORKTREE_DIR = "/tmp/thatch-v2-test-sub-worktree";
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // A tab-opened stamped by a coordinator elsewhere, carrying the
    // subordinate's FINAL directory (here: another directory entirely -
    // the directory-variant spawn). Its location-less idle event must
    // resolve to that directory and be DROPPED by this instance.
    await queueEvent({
      type: tabOpenedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_wt", directory: WORKTREE_DIR },
    });
    await queueEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_sub_wt" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(sessionCreateCalls.length).toBe(0);
    // The rpc envelope's location must not have leaked into the cache
    // either: a resolver fallback would still have dropped this, so assert
    // the resolver did not run (the cache miss fell through to get).
    expect(sessionGetCalls.some((c: any) => c?.sessionID === "ses_sub_wt")).toBe(false);

    // The positive: a tab-opened whose payload directory IS this instance's
    // directory caches the subordinate here, so its later location-less
    // idle event routes to this instance and drives extraction.
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_sub_local",
      input: { file_path: "/src/app.ts" },
      status: "completed",
      result: { content: "const x = 1;" },
    });
    await queueEvent({
      type: tabOpenedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_local", directory: SESSION_DIR },
    });
    await queueEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_sub_local" } });
    await waitFor("extraction for the locally-owned subordinate", () => sessionCreateCalls.length === 1);
    expect(sessionCreateCalls[0].title).toBe("thatch-extraction");
  });

  test("pump: tab_closed routes by the closed session's own location - owned sessions die here", async () => {
    // Regression (M3): the tab-closed event is stamped with the publisher's
    // (coordinator's) directory, so only the coordinator's instance passed
    // the instance filter and its registry held none of the subordinate's
    // watchers - the confirmed close silently no-oped. Routing now keys on
    // the CLOSED session's own directory.
    const { ThatchDB } = await import("../src/db");
    const db = new ThatchDB(join(dbDir, "test.db"));
    db.runtimeStatePut(
      "watchers",
      "ses_sub_close",
      [{
        id: "watch_sub", source: "pr", sessionID: "ses_sub_close", repo: "acme/widgets", pr: 7,
        events: ["pr_commit"], once: false, expiresAt: Date.now() + 600_000,
        createdAt: Date.now(), state: { headSha: "aaaa1111" },
      }],
      SESSION_DIR,
    );
    db.close();

    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // The tab-opened cached the subordinate under THIS instance's directory
    // (a directory-variant spawn: the subordinate lives here).
    await queueEvent({
      type: tabOpenedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_close", directory: SESSION_DIR },
    });
    // The close event: the PUBLISHER's stamp points elsewhere (the
    // coordinator emitted it from another location); the closed session's
    // cached location decides.
    await queueEvent({
      type: tabClosedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_close", chatName: "rosie-unit-one-00007" },
    });
    await waitFor("watcher_death row for the closed subordinate", () => {
      const check = new ThatchDB(join(dbDir, "test.db"));
      const rows = check.runtimeStateAll().filter((r) => r.sessionID === "ses_sub_close");
      check.close();
      return rows.some((r) => r.kind === "watcher_death");
    });
    const check = new ThatchDB(join(dbDir, "test.db"));
    // The confirmed close cancelled the subordinate's watchers...
    expect(check.runtimeStateAll().some((r) => r.kind === "watchers" && r.sessionID === "ses_sub_close")).toBe(false);
    // ...and the death row carries the watch targets for peer surfacing.
    const death = check.runtimeStateAll().find((r) => r.kind === "watcher_death" && r.sessionID === "ses_sub_close");
    expect((death?.value as any)?.targets).toContain("acme/widgets#7");
    check.close();
  });

  test("pump: tab_closed for a session owned elsewhere is ignored", async () => {
    // The other side of the M3 routing: this instance must not run the
    // death path for a subordinate whose owning instance lives in another
    // directory (the old code ran it against the publisher's stamp and
    // silently deleted a death row nobody received).
    const { ThatchDB } = await import("../src/db");
    const db = new ThatchDB(join(dbDir, "test.db"));
    db.runtimeStatePut(
      "watchers",
      "ses_sub_foreign",
      [{
        id: "watch_foreign", source: "pr", sessionID: "ses_sub_foreign", repo: "acme/widgets", pr: 8,
        events: ["pr_commit"], once: false, expiresAt: Date.now() + 600_000,
        createdAt: Date.now(), state: { headSha: "aaaa1111" },
      }],
      SESSION_DIR,
    );
    db.close();

    cleanup = (await setup(makeContext({
      get: async () => ({ data: { title: "t", location: { directory: "/tmp/thatch-v2-test-elsewhere" } } }),
    }) as any)) as () => Promise<void>;
    // No cache entry: the pump resolves the closed session's directory live
    // (a session in another location) and drops the close.
    await queueEvent({
      type: tabClosedEventType,
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_sub_foreign", chatName: null },
    });
    await new Promise((r) => setTimeout(r, 50));
    const check = new ThatchDB(join(dbDir, "test.db"));
    expect(check.runtimeStateAll().some((r) => r.kind === "watcher_death" && r.sessionID === "ses_sub_foreign")).toBe(false);
    // The watcher row survives - its owning instance owns the close.
    expect(check.runtimeStateAll().some((r) => r.kind === "watchers" && r.sessionID === "ses_sub_foreign")).toBe(true);
    check.close();
  });

  test("prompt hook skips chat echoes (nudge-loop prevention on the v2 path)", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // An echo delivery re-entering the prompt hook (if v2 routes its own
    // synthetic deliveries back through it) must not trigger nudges - the
    // runtime's isChatEchoParts skip covers it, seeded through the same
    // parts shape the adapter builds. The generate hook then has no cache
    // entry to inject.
    const prompt = { text: `[chat] al-go-rithm-00001 registered in the session directory` };
    await promptHook!({ sessionID: "ses_v2_echo", messageID: "msg_e", prompt });
    expect(prompt.text).toBe(`[chat] al-go-rithm-00001 registered in the session directory`);
    const request = {
      sessionID: "ses_v2_echo",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "echo" }] }],
    };
    await contextHook!(request);
    expect((request.messages[0].content as unknown[]).length).toBe(1);
  });

  test("tool execute.after hook skips error-status calls", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // An errored tool call must not feed the extraction buffer: the next
    // prompt must fire no extraction nudge (matching v1, whose hook only
    // fired on completed calls).
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_v2_err",
      input: { file_path: "/src/app.ts" },
      status: "error",
      error: { message: "boom" },
    });
    const prompt = { text: "what do we know about this" };
    await promptHook!({ sessionID: "ses_v2_err", messageID: "msg_e2", prompt });
    expect(prompt.text).toBe("what do we know about this");
  });

  test("buffered tool entries get a derived title (v2 sends no title field)", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // v2's Tool.Result has no title: `output` is the typed output value.
    // The adapter derives the title from the tool name and args (same rule
    // as the MCP host path); a bash call's command text becomes the title.
    // The observable is the extraction payload the payload-fetch tool
    // serves: it lists each buffered entry's title.
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_title",
      input: { command: "mise run check" },
      status: "completed",
      result: { content: [{ type: "text", text: "all green" }] },
    });
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload");
    expect(payloadTool).toBeDefined();
    // The v2 execute wraps (input, toolContext) - the host context carries
    // the session the buffer is keyed by.
    const result = await payloadTool!.execute({ limit: 20 }, { sessionID: "ses_v2_title", agent: "build" });
    const payload = typeof result === "string" ? result : JSON.stringify(result);
    expect(payload).toContain("mise run check");
  });

  test("prompt hook swallows runtime failures instead of rejecting", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // A runtime failure (here: messageID undefined, which the runtime's
    // buffer does not expect) must not reject the host's hook. Drive it
    // with a hook input whose shape the runtime does not expect.
    const prompt = { text: "hello there" };
    await expect(
      promptHook!({ sessionID: "ses_v2_boom", messageID: undefined, prompt }),
    ).resolves.toBeUndefined();
    expect(prompt.text).toBe("hello there");
  });

  test("wrap-up commands deliver a real (non-synthetic) prompt", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // The wrap-up body is the user-visible prompt (like v1's command file
    // expansion), so it must go through session.prompt, NOT the synthetic
    // endpoint - the all-synthetic routing is exercised by the wake paths
    // (see the chat wake use case), not here.
    const compact = addedCommands.find((c) => c.name === "thatch/compact");
    const exit = addedCommands.find((c) => c.name === "thatch/exit");
    expect(compact).toBeDefined();
    expect(exit).toBeDefined();
    await compact!.execute({ sessionID: "ses_v2_cmd" });
    await exit!.execute({ sessionID: "ses_v2_cmd" });
    // Both wrapped up through promptSession ("sync" mode, non-synthetic
    // body): the command body is the user-visible prompt, like v1's
    // command file expansion.
    expect(sessionSyntheticCalls.length).toBe(0);
    expect(sessionPromptCalls.length).toBe(2);
    expect(sessionPromptCalls[0].text).toContain("Pre-compact wrap-up");
    expect(sessionPromptCalls[0].text).toContain("THATCH_COMPACT_READY");
    expect(sessionPromptCalls[1].text).toContain("Pre-exit wrap-up");
  });

  test("loading the v2 adapter never evaluates the v1 SDK (isolation rule)", () => {
    // A v2 user install skips optional peers, so @opencode-ai/plugin is
    // ABSENT. Simulate the absence in a SUBPROCESS (module mocks are
    // process-global, so an in-process mock would leak into the v1 adapter
    // tests): a generated test file registers a mock that throws on
    // require, then imports the v2 adapter. If any RUNTIME import path
    // from src/opencode/v2.ts reached tools.ts (the v1 wrapper), the
    // import would explode here - and on a real v2 host it would kill the
    // whole plugin load.
    const probe = join(dbDir, "iso-probe.test.ts");
    writeFileSync(
      probe,
      [
        `import { test, mock } from "bun:test";`,
        `mock.module("@opencode-ai/plugin", () => {`,
        `  throw new Error("SIMULATED ABSENCE: @opencode-ai/plugin must not load under v2");`,
        `});`,
        `test("v2 adapter loads without the v1 SDK", async () => {`,
        `  await import(${JSON.stringify(join(import.meta.dir, "..", "src", "opencode", "v2.ts"))});`,
        `});`,
      ].join("\n"),
    );
    const proc = Bun.spawnSync([process.execPath, "test", probe], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, THATCH_DB_PATH: join(dbDir, "iso.db"), XDG_CONFIG_HOME: join(dbDir, "config") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
  });

  test("cleanup is idempotent and disposes the runtime once", async () => {
    const context = makeContext();
    const dispose = (await setup(context as any)) as () => Promise<void>;
    await dispose();
    // A second call must not re-run disposal (double db.close would throw).
    await expect(dispose()).resolves.toBeUndefined();
  });

  test("wrap-up commands substitute the user's typed arguments for $ARGUMENTS", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // v2's session.prompt does no template expansion (v1 expanded
    // $ARGUMENTS from the command file), so the adapter must substitute the
    // invocation's prompt text itself - bare runs get the n/a marker.
    const exit = addedCommands.find((c) => c.name === "thatch/exit");
    await exit!.execute({ sessionID: "ses_v2_args", prompt: { text: "Good work - see you tomorrow" } });
    const delivered = sessionPromptCalls[0].text as string;
    expect(delivered).toContain("Good work - see you tomorrow");
    expect(delivered).not.toContain("$ARGUMENTS");

    // $ sequences in the user's text must survive: a string replacement
    // would interpret them ($$ -> $, $& -> the match).
    sessionPromptCalls.length = 0;
    await exit!.execute({ sessionID: "ses_v2_args", prompt: { text: "costs $$5 and $ARGUMENTS-ish things" } });
    const delivered2 = sessionPromptCalls[0].text as string;
    expect(delivered2).toContain("costs $$5 and $ARGUMENTS-ish things");
    // The template's own placeholder (followed by the section note) is gone.
    expect(delivered2).not.toContain("$ARGUMENTS\n\n");

    // A bare invocation (no prompt) still delivers a usable body.
    sessionPromptCalls.length = 0;
    await exit!.execute({ sessionID: "ses_v2_args" });
    expect(sessionPromptCalls[0].text).not.toContain("$ARGUMENTS");
  });

  // Wrap-up completion actions: the armed journal row is the resolution
  // observable (the branch deletes it whether or not the token matched, so
  // its absence proves the branch ran to completion - not that it never
  // ran). The greenlight is the FINAL assistant message's trailing token,
  // read through session.context (mapped into the v1 shape).
  const wrapupArmed = (sessionID: string): boolean => {
    const db = new Database(process.env.THATCH_DB_PATH!, { readonly: true });
    try {
      return db.query("SELECT 1 FROM runtime_state WHERE kind = 'wrapup' AND session_id = ?").get(sessionID) != null;
    } finally {
      db.close();
    }
  };

  test("a greenlit /thatch/compact triggers session.compact on the next idle", async () => {
    const context = makeContext({
      compact: async () => ({}),
      context: async () => [
        { type: "assistant", content: [{ type: "text", text: "flushed; no loose ends THATCH_COMPACT_READY" }] },
      ],
    });
    cleanup = (await setup(context as any)) as () => Promise<void>;
    const compact = addedCommands.find((c) => c.name === "thatch/compact")!;
    await compact.execute({ sessionID: "ses_v2_wrap_ok" });
    expect(wrapupArmed("ses_v2_wrap_ok")).toBe(true);
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_wrap_ok" },
    });
    await waitFor("session.compact called", () => sessionCompactCalls.length === 1);
    expect(sessionCompactCalls[0]).toEqual({ sessionID: "ses_v2_wrap_ok" });
    expect(wrapupArmed("ses_v2_wrap_ok")).toBe(false);
    // The greenlit branch returns early: no extraction child spawn.
    expect(sessionCreateCalls.length).toBe(0);
  });

  test("a greenlit /thatch/exit emits the TUI-only close event for the session's own tab", async () => {
    const context = makeContext({
      context: async () => [
        { type: "assistant", content: [{ type: "text", text: "flushed; no loose ends THATCH_EXIT_READY" }] },
      ],
    });
    cleanup = (await setup(context as any)) as () => Promise<void>;
    const exit = addedCommands.find((c) => c.name === "thatch/exit")!;
    await exit.execute({ sessionID: "ses_v2_exit_ok" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_exit_ok" },
    });
    await waitFor("exit close emitted", () => rpcEmitted.some((e) => e.name === EXIT_TAB_CLOSED_EVENT));
    const closed = rpcEmitted.find((e) => e.name === EXIT_TAB_CLOSED_EVENT)!;
    // TUI-only payload (just the tab to close): the runtime records the
    // session's watcher deaths synchronously before the action, and the
    // pump never translates this event - a session_tab_close-style payload
    // would invite that translation.
    expect(closed.data).toEqual({ sessionID: "ses_v2_exit_ok" });
    expect(wrapupArmed("ses_v2_exit_ok")).toBe(false);
    expect(sessionCreateCalls.length).toBe(0);
  });

  test("a greenlit /thatch/exit places the session's watcher deaths before unregistering it", async () => {
    // The death row's placement is the load-bearing ordering: onSessionDeath
    // places the row by the session's chat row, and the exit unregisters that
    // row - so the deaths must run FIRST or the row lands unplaceable (a
    // project-null row no peer ever surfaces and nothing deletes).
    const context = makeContext({
      context: async () => [
        { type: "assistant", content: [{ type: "text", text: "flushed; no loose ends THATCH_EXIT_READY" }] },
      ],
    });
    cleanup = (await setup(context as any)) as () => Promise<void>;
    // The watcher's validation run executes the command in the project
    // directory, so it must exist on disk.
    mkdirSync(PROJECT_DIR, { recursive: true });
    const sessionID = "ses_v2_exit_watch";
    const chatRegister = addedTools.find((t) => t.name === "thatch_chat_register")!;
    await chatRegister.execute({}, { sessionID, agent: "general" });
    const watchCreate = addedTools.find((t) => t.name === "thatch_watch_command_create")!;
    // A condition that stays unmet: registers (validation exit != 0) and
    // never fires during the test.
    const registered = await watchCreate.execute(
      { command: "test -f /nonexistent-thatch-exit-watch-marker" },
      { sessionID, agent: "general" },
    );
    expect(String((registered as any).content)).not.toContain("refused");

    const exit = addedCommands.find((c) => c.name === "thatch/exit")!;
    await exit.execute({ sessionID });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID },
    });
    await waitFor("exit close emitted", () => rpcEmitted.some((e) => e.name === EXIT_TAB_CLOSED_EVENT));

    const stateRow = (kind: string): any => {
      const db = new Database(process.env.THATCH_DB_PATH!, { readonly: true });
      try {
        return db.query("SELECT value FROM runtime_state WHERE kind = ? AND session_id = ?").get(kind, sessionID) ?? null;
      } finally {
        db.close();
      }
    };
    // The death row is placed (project resolved from the still-registered
    // chat row) and carries the cancelled watch as a target.
    const death = stateRow("watcher_death");
    expect(death).not.toBeNull();
    const deathValue = JSON.parse(death.value);
    expect(deathValue.project).toBeTruthy();
    expect(deathValue.targets).toContain("test -f /nonexistent-thatch-exit-watch-marker");
    // The watcher definition row is gone (cancelled, not dormant).
    expect(stateRow("watchers")).toBeNull();
    // The chat roster row is unregistered.
    const db = new Database(process.env.THATCH_DB_PATH!, { readonly: true });
    try {
      expect(db.query("SELECT 1 FROM chat_sessions WHERE session_id = ?").get(sessionID)).toBeNull();
    } finally {
      db.close();
    }

    // The SSE echo of the emit (the bus feeds a plugin's own events back to
    // it) must not translate into a second death pass: the second pass would
    // write an empty-targets row over the placed one and delete it, erasing
    // the notice the surfacing pass owes the session's peers.
    await queueEvent({ type: exitTabClosedEventType, data: { sessionID }, location: { directory: SESSION_DIR } });
    await new Promise((r) => setTimeout(r, 150));
    expect(stateRow("watcher_death")).not.toBeNull();

    // A second greenlit exit (the user reopened the tab and ran the command
    // again) must not erase the placed row either: the second sessionDied
    // finds no watchers, and an empty-targets upsert would overwrite the
    // placed row before the watchless cleanup deletes it.
    await exit.execute({ sessionID });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID },
    });
    await waitFor("second exit close emitted", () => rpcEmitted.filter((e) => e.name === EXIT_TAB_CLOSED_EVENT).length === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(stateRow("watcher_death")).not.toBeNull();
  });

  test("a blocked wrap-up (no greenlight token) triggers no host action", async () => {
    const context = makeContext({
      compact: async () => ({}),
      context: async () => [
        // Blockers listed, no trailing token: the branch falls through
        // without firing the action (the model surfaced the blockers in
        // its response; the blocked-path toast degrades silently on v2).
        { type: "assistant", content: [{ type: "text", text: "two loose ends remain: the migration, the QA pass" }] },
      ],
    });
    cleanup = (await setup(context as any)) as () => Promise<void>;
    const compact = addedCommands.find((c) => c.name === "thatch/compact")!;
    await compact.execute({ sessionID: "ses_v2_wrap_blocked" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_wrap_blocked" },
    });
    await waitFor("wrap-up resolved without greenlight", () => !wrapupArmed("ses_v2_wrap_blocked"));
    // The row delete happens BEFORE the token check, so the branch is
    // still running at row-gone: settle before asserting the negatives.
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionCompactCalls.length).toBe(0);
    // Neither close event - the blocked path must not fire any host action.
    expect(rpcEmitted.filter((e) => e.name === TAB_CLOSED_EVENT || e.name === EXIT_TAB_CLOSED_EVENT).length).toBe(0);
    // The blocked-path warning toast rides the bridge on v2 - find it by
    // variant + command name, not position: the fall-through auto-register
    // can emit its own toast after it.
    expect(
      rpcEmitted.some(
        (e) => e.name === TOAST_EVENT && e.data?.variant === "warning" && String(e.data?.message).includes("/thatch/compact"),
      ),
    ).toBe(true);
  });

  test("an older SDK without session.compact degrades to a logged no-op, not a crash", async () => {
    // The pinned dev types predate upstream #52385, so the adapter guards
    // the call at runtime; the default context (no compact member) models
    // that older host.
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const context = makeContext({
        context: async () => [
          { type: "assistant", content: [{ type: "text", text: "clear THATCH_COMPACT_READY" }] },
        ],
      });
      cleanup = (await setup(context as any)) as () => Promise<void>;
      const compact = addedCommands.find((c) => c.name === "thatch/compact")!;
      await compact.execute({ sessionID: "ses_v2_wrap_floor" });
      await queueEvent({
        type: "session.execution.succeeded",
        location: { directory: SESSION_DIR },
        data: { sessionID: "ses_v2_wrap_floor" },
      });
      await waitFor("wrap-up resolved on the floor host", () => !wrapupArmed("ses_v2_wrap_floor"));
      await new Promise((r) => setTimeout(r, 150));
      expect(sessionCompactCalls.length).toBe(0);
      expect(errors.some((line) => line.includes("compaction trigger unavailable"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("a host without the rpc surface exits greenlit with a logged no-op", async () => {
    // Same floor rule as session.compact, for the exit action: without the
    // session-tab bridge there is no closeable tab surface, so the
    // greenlit exit degrades to a log (the checklist and flush still ran).
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const context = makeContext({
        omitRpc: true,
        context: async () => [
          { type: "assistant", content: [{ type: "text", text: "clear THATCH_EXIT_READY" }] },
        ],
      });
      cleanup = (await setup(context as any)) as () => Promise<void>;
      const exit = addedCommands.find((c) => c.name === "thatch/exit")!;
      await exit.execute({ sessionID: "ses_v2_exit_floor" });
      await queueEvent({
        type: "session.execution.succeeded",
        location: { directory: SESSION_DIR },
        data: { sessionID: "ses_v2_exit_floor" },
      });
      await waitFor("wrap-up resolved without rpc", () => !wrapupArmed("ses_v2_exit_floor"));
      await new Promise((r) => setTimeout(r, 150));
      expect(rpcEmitted.length).toBe(0);
      // "tab close skipped" pins the ACTION's degrade log, distinct from
      // the setup-time "rpc surface unavailable" line.
      expect(errors.some((line) => line.includes("tab close skipped"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("flattenToolContent passes strings through and joins text parts", async () => {
    expect(flattenToolContent("plain output")).toBe("plain output");
    expect(
      flattenToolContent([{ type: "text", text: "line one" }, { type: "file", uri: "file:///x" }, { type: "text", text: "line two" }]),
    ).toBe("line one\nline two");
    expect(flattenToolContent([{ type: "file", uri: "file:///x" }])).toBe("");
    expect(flattenToolContent(undefined)).toBe("");
    expect(flattenToolContent(42)).toBe("");
  });

  test("mapSessionContextMessages maps v2 message kinds into the v1 shape", () => {
    const mapped = mapSessionContextMessages([
      { type: "user", text: "hello" },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "hmm" },
          { type: "tool", name: "read" },
          { type: "text", text: "the answer" },
        ],
        error: { type: "MessageAbortedError", message: "aborted" },
      },
      { type: "synthetic" },
    ]);
    expect(mapped).toHaveLength(3);
    expect(mapped[0]).toEqual({ info: { role: "user" }, parts: [{ type: "text", text: "hello", synthetic: false }] });
    expect(mapped[1].info.role).toBe("assistant");
    // Reasoning parts are skipped; tool parts keep the tool name (other
    // consumers may want it - the alert classifier reads roles and errors,
    // not tool names); the message-level error name rides info.
    expect(mapped[1].info.error).toBe("MessageAbortedError");
    expect(mapped[1].parts).toEqual([
      { type: "tool", tool: "read" },
      { type: "text", text: "the answer" },
    ]);
    expect(mapped[2].parts).toEqual([{ type: "text", text: "", synthetic: true }]);
  });

  test("session get resolves by sessionID and location-less events survive handler throws", async () => {
    const context = makeContext({
      // A shared-DB hiccup under v2 (SQLITE_BUSY etc.) surfaces as a throw
      // from the get endpoint; the pump must log and keep consuming.
      get: async (input: any) => {
        if (input?.sessionID === "ses_v2_dead") throw new Error("database is locked");
        return { data: { title: "t" } };
      },
    });
    cleanup = (await setup(context as any)) as () => Promise<void>;

    // Location-less event for a session whose get throws: the per-event
    // catch swallows it, and - critically - the loop continues.
    await queueEvent({ type: "session.execution.started", data: { sessionID: "ses_v2_dead" } });
    // The resolver must be using the v2 input shape ({sessionID}, not {id}).
    expect(sessionGetCalls.length).toBe(1);
    expect(sessionGetCalls[0]).toEqual({ sessionID: "ses_v2_dead" });

    // A subsequent event for a session whose get succeeds still lands.
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_v2_alive",
      input: { file_path: "/src/app.ts" },
      status: "completed",
      result: { content: "const x = 1;" },
    });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_alive" },
    });
    await waitFor("extraction after a handler throw", () => sessionCreateCalls.length === 1);
  });

  test("v2 end-to-end: idle-triggered extraction child completes with zero session ids", async () => {
    // The whole opencode v2 lifecycle through the real adapter, with the
    // model passing NO session ids anywhere: parent work buffers -> parent
    // idle (session.execution.succeeded) creates the child via
    // sessionCreate (childToParent set eagerly - v2 create has no parentID)
    // -> the child fetches with no id (auto-resolves to the parent via
    // childToParent) -> the child acks with no id -> the parent's buffer is
    // drained. No prompt-hook injection ever carried an extraction nudge.
    const context = makeContext();
    cleanup = (await setup(context as any)) as () => Promise<void>;
    const fetchTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    expect(fetchTool).toBeDefined();

    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_e2e",
      input: { command: "git log" },
      status: "completed",
      result: { content: "abc123 real work" },
    });

    // Parent idle: the plugin creates the extraction child itself.
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_e2e" },
    });
    await waitFor("child created", () => sessionCreateCalls.length === 1);
    // The child was prompted with the parent's id interpolated by the
    // plugin - but the child below never uses it.
    await waitFor("child prompted", () => sessionPromptCalls.length >= 1);
    expect(sessionPromptCalls[0].text).toContain("thatch-fact-extractor");

    // The child fetches with NO session_id: the host supplies the child's
    // own id, and the provider retargets to the parent via childToParent.
    const served = await fetchTool.execute({}, { sessionID: "v2-test-child", agent: "general" });
    expect(String((served as any).content)).toContain("abc123");

    // The child acks with NO session_id: parentID is known, the claim
    // completes, and the parent's buffer is gone.
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "v2-test-child",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    const drained = await fetchTool.execute({ session_id: "ses_v2_e2e" }, { sessionID: "ses_v2_other", agent: "general" });
    expect(String((drained as any).content)).not.toContain("abc123");

    // The prompt hook never injected an extraction nudge for the parent.
    const prompt = { text: "and now what" };
    await promptHook!({ sessionID: "ses_v2_e2e", messageID: "msg_e2e", prompt });
    const request = {
      sessionID: "ses_v2_e2e",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "and now what" }] }],
    };
    await contextHook!(request);
    expect((request.messages[0].content as any[]).length).toBe(1);
  });

  test("v2 end-to-end: a model-dispatched sub-agent (info.parentID link) extracts with zero ids", async () => {
    // v2's session.created carries info.parentID for task-tool-dispatched
    // sub-agents (translateEvent). Such a child is linked in childToParent
    // the same way, so the auto-resolution and claim-scoped completion
    // cover it too - even though no plugin-side triggerExtraction created
    // it. Its memory write (not an ack) is the completion signal here.
    const context = makeContext();
    cleanup = (await setup(context as any)) as () => Promise<void>;
    const fetchTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;

    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_task_parent",
      input: { command: "ls" },
      status: "completed",
      result: { content: "payload-xyz" },
    });
    await queueEvent({
      type: "session.created",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_task_child", info: { id: "ses_v2_task_child", parentID: "ses_v2_task_parent" } },
    });
    // The pump's handler is async: poll until the link is live, then fetch
    // with NO session_id - the child's own id retargets to the parent.
    let linked = "";
    const end = Date.now() + 5000;
    while (!linked.includes("payload-xyz")) {
      if (Date.now() > end) throw new Error("timed out waiting for: child linked");
      const r = await fetchTool.execute({}, { sessionID: "ses_v2_task_child", agent: "general" });
      linked = String((r as any).content);
      if (!linked.includes("payload-xyz")) await new Promise((res) => setTimeout(res, 25));
    }

    // Memory write in the linked child completes its claim.
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: "ses_v2_task_child",
      input: { label: "x", content: "y" },
      status: "completed",
      result: { content: "[saved]" },
    });
    const drained = await fetchTool.execute({ session_id: "ses_v2_task_parent" }, { sessionID: "ses_v2_other2", agent: "general" });
    expect(String((drained as any).content)).not.toContain("payload-xyz");
  });

  test("the extraction child's idle deletes it via session.remove on a current host", async () => {
    // The child deletion keeps the session picker clean on v2 (and `-c`
    // resume out of extraction children). finishExtractionChild drives it
    // from the child's idle event; the child routes through the
    // childSessions forwarding set (its events carry no location here).
    const context = makeContext({ remove: async () => ({}) });
    cleanup = (await setup(context as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_child_del",
      input: { command: "git log" },
      status: "completed",
      result: { content: "abc123 real work" },
    });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_child_del" },
    });
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);
    await queueEvent({ type: "session.execution.succeeded", data: { sessionID: "v2-test-child" } });
    await waitFor("child deleted", () => sessionRemoveCalls.length === 1);
    expect(sessionRemoveCalls[0]).toEqual({ sessionID: "v2-test-child" });
  });

  test("an older SDK without session.remove leaves the child in place, silently", async () => {
    // The floor keeps the documented gap (the picker accumulates one
    // thatch-extraction entry per extraction): best-effort by contract, so
    // the degrade is silent and the rest of the child cleanup still runs.
    // The child journal row is the completion observable: journalChild
    // deletes it after the map cleanup and BEFORE sessionDelete, so
    // row-gone proves the cleanup ran - the settle idiom cannot (a throw
    // in finishExtractionChild would also leave remove at zero).
    const childJournaled = (): boolean => {
      const db = new Database(process.env.THATCH_DB_PATH!, { readonly: true });
      try {
        return db.query("SELECT 1 FROM runtime_state WHERE kind = 'child' AND session_id = ?").get("v2-test-child") != null;
      } finally {
        db.close();
      }
    };
    const context = makeContext();
    cleanup = (await setup(context as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_child_floor",
      input: { command: "git log" },
      status: "completed",
      result: { content: "abc123 real work" },
    });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_child_floor" },
    });
    await waitFor("extraction child created and journaled", () => sessionCreateCalls.length === 1 && childJournaled());
    await queueEvent({ type: "session.execution.succeeded", data: { sessionID: "v2-test-child" } });
    await waitFor("child cleanup completed", () => !childJournaled());
    expect(sessionRemoveCalls.length).toBe(0);
  });

  test("child-session events pass the directory filter on below-root launches", async () => {
    // The child is created in the project directory; when the instance
    // directory differs (opencode launched below the project root), the
    // child's events must still reach the runtime - its idle event is what
    // drives the extraction cleanup.
    expect(eventMatchesInstance(PROJECT_DIR, "v2-test-child", SESSION_DIR, new Set(["v2-test-child"]))).toBe(true);
    expect(eventMatchesInstance(SESSION_DIR, undefined, SESSION_DIR, new Set())).toBe(true);
    expect(eventMatchesInstance(PROJECT_DIR, "ses_other", SESSION_DIR, new Set(["v2-test-child"]))).toBe(false);
    expect(eventMatchesInstance(undefined, undefined, SESSION_DIR, new Set())).toBe(false);
  });
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
});
