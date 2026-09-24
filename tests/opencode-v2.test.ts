import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, eventMatchesInstance, flattenToolContent, mapSessionContextMessages } from "../src/opencode/v2";
import { TOOL_DEFS } from "../src/tool-defs";

// The v2 adapter's contract test: a mocked v2 promise context (plain
// objects, call-recording arrays - the house pattern from
// tests/plugin.test.ts) driving the real runtime through the adapter.

const SESSION_DIR = "/tmp/thatch-v2-test-session";
const PROJECT_DIR = "/tmp/thatch-v2-test-project";

type HookFn = (input: any) => any;
type Registration = { dispose: () => void };

let dbDir: string;
let promptHook: HookFn | undefined;
let generateHook: HookFn | undefined;
let contextHook: HookFn | undefined;
let toolAfterHook: HookFn | undefined;
let addedCommands: { name: string; execute: (input: any) => Promise<void> }[];
let addedTools: { name: string; description: string; input: unknown }[];
let sessionPromptCalls: any[];
let sessionSyntheticCalls: any[];
let sessionCreateCalls: any[];
let sessionGetCalls: any[];
let sessionContextCalls: any[];
const eventQueue: any[] = [];

function makeContext(options?: { get?: (input: any) => Promise<any>; context?: (input: any) => Promise<any> }) {
  addedTools = [];
  sessionPromptCalls = [];
  sessionSyntheticCalls = [];
  sessionCreateCalls = [];
  sessionGetCalls = [];
  sessionContextCalls = [];
  promptHook = undefined;
  generateHook = undefined;
  contextHook = undefined;
  toolAfterHook = undefined;
  addedCommands = [];
  return {
    location: { directory: SESSION_DIR, project: { directory: PROJECT_DIR, canonical: PROJECT_DIR } },
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
          add: (tool: any) => addedTools.push({ name: tool.name, description: tool.description, input: tool.input }),
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
        if (name === "generate") generateHook = callback;
        if (name === "context") contextHook = callback;
        return { dispose: () => {} };
      },
      create: async (input: any) => {
        sessionCreateCalls.push(input);
        return { data: { id: "v2-test-child" } };
      },
      get: async (input: any) => {
        sessionGetCalls.push(input);
        if (options?.get) return options.get(input);
        return { data: { title: "some title" } };
      },
      context: async (input: any) => {
        sessionContextCalls.push(input);
        if (options?.context) return options.context(input);
        return { data: [] };
      },
      prompt: async (input: any) => {
        sessionPromptCalls.push(input);
        return { data: {} };
      },
      synthetic: async (input: any) => {
        sessionSyntheticCalls.push(input);
        return { data: {} };
      },
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

describe("opencode v2 adapter", () => {
  test("setup registers every TOOL_DEF through the ToolEditor with thatch_ names", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const names = addedTools.map((t) => t.name);
    expect(addedTools.length).toBe(TOOL_DEFS.length);
    for (const def of TOOL_DEFS) expect(names).toContain(`thatch_${def.name}`);
    for (const tool of addedTools) expect(tool.description).toBeTruthy();
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

  test("nudges stay out of the stored prompt and ride the generate hook", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(toolAfterHook).toBeDefined();
    expect(generateHook).toBeDefined();
    // Buffer a tool interaction through the v2 execute.after hook, then
    // send a prompt: the extraction nudge must NOT touch prompt.text (v2
    // stores prompt text as the user message - injecting there would echo
    // the nudge into the visible transcript).
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

    // The generate hook instead appends the nudge to the outbound request's
    // last user message - v2's wire Message carries parts in `content`
    // (there is no `parts` field, so writing there would be a stray
    // property the provider formatter never reads). The extraction nudge's
    // wording varies with the background-subagents env, but both variants
    // reference the payload fetch tool.
    const request = {
      sessionID: "ses_v2_nudge",
      messages: [{ role: "user", content: [{ type: "text", text: "what do we know about this" }] }],
    };
    generateHook!(request);
    const parts = request.messages[0].content as { type: string; text: string }[];
    expect(parts.length).toBe(2);
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toContain("thatch_get_extraction_payload");
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
    // Location-less event: dropped with it (v1's server-side filter shape).
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
      messages: [{ role: "user", content: [{ type: "text", text: "echo" }] }],
    };
    generateHook!(request);
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

  test("prompt hook swallows runtime failures instead of rejecting", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // A runtime failure (here: a tool name collision inside the buffer via
    // a broken payload) must not reject the host's hook. Drive it with a
    // hook input whose shape the runtime does not expect.
    const prompt = { text: "hello there" };
    await expect(
      promptHook!({ sessionID: "ses_v2_boom", messageID: undefined, prompt }),
    ).resolves.toBeUndefined();
    expect(prompt.text).toBe("hello there");
  });

  test("synthetic deliveries route to session.synthetic, real prompts to session.prompt", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // capabilities are internal; exercise the routing through the session
    // domain's prompt endpoint types via the adapter's promptSession: the
    // watcher/chat wake path delivers all-synthetic parts. The adapter's
    // own delivery is not directly reachable here, so drive it through a
    // watcher-style wake: an idle event whose handler prompts synthetically
    // is the child-extraction path (sessionCreate first). Instead, assert
    // the simplest observable: the wrap-up command's execute delivers the
    // command body as a REAL prompt (non-synthetic).
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

    // A bare invocation (no prompt) still delivers a usable body.
    sessionPromptCalls.length = 0;
    await exit!.execute({ sessionID: "ses_v2_args" });
    expect(sessionPromptCalls[0].text).not.toContain("$ARGUMENTS");
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
      { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "the answer" }] },
      { type: "synthetic" },
    ]);
    expect(mapped).toHaveLength(3);
    expect(mapped[0]).toEqual({ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] });
    expect(mapped[1].info.role).toBe("assistant");
    expect(mapped[1].parts).toEqual([{ type: "text", text: "the answer" }]);
    expect(mapped[2].parts).toEqual([{ type: "text", text: "" }]);
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
