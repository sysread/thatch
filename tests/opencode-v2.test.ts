import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../src/opencode/v2";
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
let contextHook: HookFn | undefined;

let addedTools: { name: string; description: string; input: unknown }[];
let sessionPromptCalls: any[];
const eventQueue: any[] = [];

function makeContext() {
  addedTools = [];
  sessionPromptCalls = [];
  promptHook = undefined;
  contextHook = undefined;
  return {
    location: { directory: SESSION_DIR, project: { directory: PROJECT_DIR, canonical: PROJECT_DIR } },
    tool: {
      transform: async (callback: (editor: any) => void): Promise<Registration> => {
        callback({
          add: (tool: any) => addedTools.push({ name: tool.name, description: tool.description, input: tool.input }),
        });
        return { dispose: () => {} };
      },
    },
    session: {
      hook: async (name: string, callback: HookFn): Promise<Registration> => {
        if (name === "prompt") promptHook = callback;
        if (name === "context") contextHook = callback;
        return { dispose: () => {} };
      },
      create: async () => ({ data: { id: "v2-test-child" } }),
      get: async () => ({ data: { title: "some title" } }),
      prompt: async (input: any) => {
        sessionPromptCalls.push(input);
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
    const system: string[] = [];
    await contextHook!({ system });
    expect(system.length).toBe(1);
    expect(system[0]).toContain("Persistence");
    expect(system[0]).toContain("thatch_memory_remember");
  });

  test("prompt hook appends nudge injections to the prompt text", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(promptHook).toBeDefined();
    const prompt = { text: "remember the thing we discussed about deployment" };
    await promptHook!({ sessionID: "ses_v2_a", messageID: "msg_1", prompt });
    // The runtime buffered no tool interactions, so no extraction nudge
    // fires; the recall path may or may not match. Assert only that the
    // user's text is preserved (the seeded part is not re-appended).
    expect(prompt.text.startsWith("remember the thing we discussed about deployment")).toBe(true);
  });

  test("event pump drops events from other directories and serves matching ones", async () => {
    const context = makeContext();
    cleanup = (await setup(context as any)) as () => Promise<void>;

    // Foreign-directory event: the pump must drop it (no session-start
    // prompt for its session).
    await queueEvent({
      type: "session.created",
      location: { directory: "/some/other/dir" },
      properties: { info: { id: "ses_foreign" } },
    });
    // Location-less event: dropped with it (v1's server-side filter shape).
    await queueEvent({ type: "session.created", properties: { info: { id: "ses_bare" } } });
    // Matching-directory event: the runtime's session-start reminder fires
    // through the capabilities (sessionGet, then promptSession).
    await queueEvent({
      type: "session.created",
      location: { directory: SESSION_DIR },
      properties: { info: { id: "ses_v2_new" } },
    });

    // Foreign/bare events produced no prompts; the matching one produced
    // exactly one (the session-start reminder, sync mode).
    await waitFor("session-start reminder for ses_v2_new", () => sessionPromptCalls.length === 1);
    expect(sessionPromptCalls.length).toBe(1);
    expect(sessionPromptCalls[0].sessionID).toBe("ses_v2_new");
  });

  test("prompt hook skips chat echoes (nudge-loop prevention on the v2 path)", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // An echo delivery re-entering the prompt hook (if v2 routes its own
    // synthetic deliveries back through it) must not trigger nudges - the
    // runtime's isChatEchoParts skip covers it, seeded through the same
    // parts shape the adapter builds.
    const prompt = { text: `[chat] al-go-rithm-00001 registered in the session directory` };
    await promptHook!({ sessionID: "ses_v2_echo", messageID: "msg_e", prompt });
    expect(prompt.text).toBe(`[chat] al-go-rithm-00001 registered in the session directory`);
  });

  test("cleanup is idempotent and disposes the runtime once", async () => {
    const context = makeContext();
    const dispose = (await setup(context as any)) as () => Promise<void>;
    await dispose();
    // A second call must not re-run disposal (double db.close would throw).
    await expect(dispose()).resolves.toBeUndefined();
  });
});
