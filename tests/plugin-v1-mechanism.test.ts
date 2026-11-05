// The v1-vehicle residue: tests whose driving shape ONLY the v1 adapter can
// produce, moved unchanged in substance from the plugin-*.test.ts files
// during the re-target onto the v2 harness (the drop-v1 plan). They keep
// using tests/mocks/plugin-harness.ts (the v1 SDK client mock booted through
// src/index's v1 `server`). They die in Phase B when the v1 adapter dies.
//
// Why each survivor is here (one-line marker on every test):
// - crafted output.parts: the v2 prompt hook builds output.parts from
//   prompt.text (a single non-synthetic part); a test cannot craft them.
// - the autocontinue hook: v2 has no equivalent (its compaction hook covers
//   the behavior).
// - client.session.list / the promptAsync-vs-prompt endpoint split /
//   command.execute.before for unregistered commands: no v2 surface.
// - the v1 hooks.event / hooks table shape assertions.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import {
  server,
  setupPluginHarness,
  teardownPluginHarness,
  tuiExecuteCommandCalls,
} from "./mocks/plugin-harness";

// This file boots the real plugin server (setup() rehydrates journals,
// sweeps, and the chat poller - ~2.3s wall on macOS). Bun's default
// per-test timeout is 5s with no margin for a loaded CI runner (the
// 2026-11-03 fleet-contention CI reds were exactly this shape). 90s =
// expected boot x ~40 headroom.
setDefaultTimeout(90_000);

let hooks: Awaited<ReturnType<typeof server>>;

beforeAll(async () => {
  hooks = await setupPluginHarness();
});

afterAll(() => {
  teardownPluginHarness();
});

// ---------------------------------------------------------------------------
// From plugin-entry.test.ts: v1 hooks-table shape assertions.
// ---------------------------------------------------------------------------

describe("v1 hook surface", () => {
  test("has compaction autocontinue hook", () => {
    // v1-vehicle residue: v2 has no autocontinue hook (its compaction hook covers the behavior) (dies with Phase B)
    expect(typeof hooks["experimental.compaction.autocontinue"]).toBe("function");
  });

  test("has event hook", () => {
    // v1-vehicle residue: the v1 hooks.event function has no v2 analog (the v2 pump is exercised by every queueEvent-driven test) (dies with Phase B)
    expect(typeof hooks.event).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// From plugin-extraction.test.ts: the crafted-parts legs of the
// "chat.message never nudges" guards.
// ---------------------------------------------------------------------------

describe("v1 crafted-parts nudge guards", () => {
  test("buffered interactions never surface as chat.message nudges on echo bubbles (echo-skip guard)", async () => {
    // v1-vehicle residue: a test cannot craft output.parts on v2 (the prompt hook builds them from prompt.text) (dies with Phase B)
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_echo_skip", callID: "ce9", args: { command: "ls" } },
      { title: "list files", output: "README.md", metadata: {} },
    );
    const echoOutput: any = {
      message: { id: "msg_echo" },
      parts: [{ type: "text", text: "[chat] to Landru: hello there friend" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_echo_skip", messageID: "msg_echo" } as any, echoOutput);
    expect(echoOutput.parts.length).toBe(1);
  });

  test("synthetic-only prompts and mixed multi-part messages both skip the (removed) extraction nudge", async () => {
    // v1-vehicle residue: a test cannot craft output.parts on v2 (the prompt hook builds them from prompt.text) (dies with Phase B)
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_synth", callID: "cs1", args: { command: "ls" } },
      { title: "list files", output: "README.md", metadata: {} },
    );
    const injected: any = {
      message: { id: "msg_inj" },
      parts: [{ type: "text", text: "Extraction complete.", synthetic: true }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_synth", messageID: "msg_inj" } as any, injected);
    expect(injected.parts.length).toBe(1);

    // A mixed message (synthetic part plus real user text) is user input
    // as far as the nudge machinery is concerned - and still carries no
    // extraction nudge.
    const mixed: any = {
      message: { id: "msg_mixed" },
      parts: [
        { type: "text", text: "attached context", synthetic: true },
        { type: "text", text: "and my actual question" },
      ],
    };
    await hooks["chat.message"]!({ sessionID: "ses_synth", messageID: "msg_mixed" } as any, mixed);
    expect(mixed.parts.length).toBe(2);
    expect(mixed.parts[1].text).not.toContain("thatch-fact-extractor");
  });
});

// ---------------------------------------------------------------------------
// From plugin-nudge-tiers.test.ts: the compaction guard tests whose message
// shape (a compaction-type output part) only the v1 adapter can produce, and
// the autocontinue hook.
// ---------------------------------------------------------------------------

describe("v1 compaction guard shapes", () => {
  test("chat.message skips nudges while session is compacting", async () => {
    // v1-vehicle residue: the compaction-summary message is identified by a compaction-type output part, which the v2 prompt hook cannot produce (dies with Phase B)
    await hooks["experimental.session.compacting"]!(
      { sessionID: "ses_guard" } as any,
      { context: [] as string[] },
    );

    const output: any = {
      message: { id: "msg_guard_1" },
      parts: [{ type: "compaction", auto: true, overflow: false }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard", messageID: "msg_guard_1" } as any, output);
    expect(output.parts.length).toBe(1);
  });

  test("autocontinue clears the flag and nudges resume", async () => {
    // v1-vehicle residue: v2 has no autocontinue hook (its compaction hook covers the behavior) (dies with Phase B)
    await hooks.tool!.thatch_prediction_update.execute({
      matcher: "untangling a gnarly database migration plan",
      prediction: "ask about prod scars and prior migrations before touching the schema",
      signal: "create",
      rationale: "user emphasized prod-history checks",
    } as any, {} as any);

    await hooks["experimental.compaction.autocontinue"]!({ sessionID: "ses_guard" } as any, { enabled: true } as any);

    const output: any = {
      message: { id: "msg_guard_2" },
      parts: [{ type: "text", text: "untangling a gnarly database migration plan" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard", messageID: "msg_guard_2" } as any, output);
    // The prediction nudge should fire (matcher seeded above).
    expect(output.parts.length).toBe(2);
    expect(output.parts[1].synthetic).toBe(true);
    expect(output.parts[1].text).toContain("User decision model");
  });

  test("extraction nudge is also suppressed during compaction", async () => {
    // v1-vehicle residue: the compaction-summary message is identified by a compaction-type output part, which the v2 prompt hook cannot produce (dies with Phase B)
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_guard_ext", callID: "c1", args: { command: "ls" } },
      { title: "list files", output: "file.txt", metadata: {} },
    );

    await hooks["experimental.session.compacting"]!(
      { sessionID: "ses_guard_ext" } as any,
      { context: [] as string[] },
    );

    const output: any = {
      message: { id: "msg_guard_ext" },
      parts: [{ type: "compaction", auto: true, overflow: false }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard_ext", messageID: "msg_guard_ext" } as any, output);
    expect(output.parts.length).toBe(1);

    // Clean up so the buffer doesn't leak into other tests.
    await hooks["experimental.compaction.autocontinue"]!({ sessionID: "ses_guard_ext" } as any, { enabled: true } as any);
  });

  test("compaction summary message still suppresses nudges (has compaction part)", async () => {
    // v1-vehicle residue: the compaction-summary message is identified by a compaction-type output part, which the v2 prompt hook cannot produce (dies with Phase B)
    await hooks["experimental.session.compacting"]!(
      { sessionID: "ses_guard_sum" } as any,
      { context: [] as string[] },
    );

    // A compaction-type part identifies the compaction summary generation message.
    const output: any = {
      message: { id: "msg_guard_sum" },
      parts: [{ type: "compaction", auto: true, overflow: false }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard_sum", messageID: "msg_guard_sum" } as any, output);
    // Suppressed — tools are blocked during summary generation.
    expect(output.parts.length).toBe(1);

    // Clean up.
    await hooks["experimental.compaction.autocontinue"]!({ sessionID: "ses_guard_sum" } as any, { enabled: true } as any);
  });
});

// ---------------------------------------------------------------------------
// From plugin-extraction-direct.test.ts: the sync/async child-dispatch split,
// observable only through the v1 client's two prompt endpoints.
// ---------------------------------------------------------------------------

describe("v1 child dispatch endpoints", () => {
  test("direct extraction: sync path uses prompt when bg env var unset", async () => {
    // v1-vehicle residue: the v1 client's promptAsync-vs-prompt endpoint split does not exist on v2 (both modes enqueue via session.prompt) (dies with Phase B)
    let promptCalled = false;
    let promptAsyncCalled = false;

    const recClient = {
      session: {
        prompt: async () => { promptCalled = true; },
        promptAsync: async () => { promptAsyncCalled = true; },
        create: async () => ({ data: { id: "child_sync" } }),
        delete: async () => {},
      },
      tui: {
        showToast: async () => {},
      },
    };

    // Preload (tests/clean-env.ts) already strips OPENCODE_* vars, so the
    // sync path is the default — no env manipulation needed.

    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_sync", callID: "s1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_sync", status: { type: "idle" } } } as any,
    });

    // Allow the fire-and-forget prompt to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(promptCalled).toBe(true);
    expect(promptAsyncCalled).toBe(false);

    testHooks.dispose?.();
  });
});

// ---------------------------------------------------------------------------
// From plugin-wrapup.test.ts: the v1 command.execute.before hook fires for
// every command name; v2 registers only the two wrap-up commands, so an
// unknown command cannot even be driven.
// ---------------------------------------------------------------------------

describe("v1 command hook shape", () => {
  // Local helpers over the shared v1 hooks (same shapes as the originals).
  const arm = (command: string, sessionID: string) =>
    hooks["command.execute.before"]!({ command, sessionID, arguments: "" }, { parts: [] });
  const idle = (sessionID: string) =>
    hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID, status: { type: "idle" } } } as any,
    });
  const callCompactTool = (sessionID: string) =>
    hooks.tool!.thatch_compact.execute({}, { sessionID } as any) as Promise<string>;

  test("unknown commands do not arm the wrap-up check", async () => {
    // v1-vehicle residue: v2 registers only thatch/compact and thatch/exit (there is no command.execute.before hook to drive an unknown command name through) (dies with Phase B)
    const before = tuiExecuteCommandCalls.length;
    await arm("some-other-command", "ses_wrapu");
    await callCompactTool("ses_wrapu");
    await idle("ses_wrapu");
    expect(tuiExecuteCommandCalls.length).toBe(before);
  });
});
