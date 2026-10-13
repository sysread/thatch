// The former plugin.test.ts "plugin entry" describe, split by topic. This
// file holds the hook wiring and shape tests (exports, tool registry, hook
// presence, transforms, chat-tool transcript echo) and the trailing
// skill-install / event-handler / delivery-guard wiring. The rest of the
// block lives in plugin-extraction.test.ts (interaction buffering + payload
// handshake), plugin-extraction-claims.test.ts (watcher journal reconcile +
// claim scoping), and plugin-extraction-direct.test.ts (direct-extraction
// child lifecycle).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  promptAsyncCalls,
  server,
  setupPluginHarness,
  teardownPluginHarness,
} from "./mocks/plugin-harness";

let hooks: Awaited<ReturnType<typeof server>>;

beforeAll(async () => {
  hooks = await setupPluginHarness();
});

afterAll(() => {
  teardownPluginHarness();
});

describe("plugin entry", () => {
  test("exports a server function", () => {
    expect(typeof server).toBe("function");
  });

  test("returns hooks with all expected tools", () => {
    expect(hooks.tool).toBeDefined();
    const names = Object.keys(hooks.tool!);
    expect(names.sort()).toEqual([
      "thatch_behavior_codify",
      "thatch_behavior_delete",
      "thatch_behavior_feedback",
      "thatch_behavior_list",
      "thatch_chat_broadcast",
      "thatch_chat_list",
      "thatch_chat_read",
      "thatch_chat_register",
      "thatch_chat_send",
      "thatch_chat_status",
      "thatch_chat_unregister",
      "thatch_config_get",
      "thatch_config_set",
      "thatch_dedup_mark_checked",
      "thatch_extraction_done",
      "thatch_find_duplicates",
      "thatch_get_extraction_payload",
      "thatch_get_session_info",
      "thatch_memory_forget",
      "thatch_memory_list",
      "thatch_memory_recall",
      "thatch_memory_remember",
      "thatch_memory_show",
      "thatch_notify_user",
      "thatch_prediction_delete",
      "thatch_prediction_list",
      "thatch_prediction_mark_checked",
      "thatch_prediction_query",
      "thatch_prediction_update",
      "thatch_session_get",
      "thatch_session_search",
      "thatch_store_list",
      "thatch_watch_branch_create",
      "thatch_watch_cancel",
      "thatch_watch_command_create",
      "thatch_watch_create",
      "thatch_watch_list",
    ]);
  });

  test("has system transform hook", () => {
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
  });

  test("has chat.message hook", () => {
    expect(typeof hooks["chat.message"]).toBe("function");
  });

  test("has compaction hook", () => {
    expect(typeof hooks["experimental.session.compacting"]).toBe("function");
  });

  test("has compaction autocontinue hook", () => {
    expect(typeof hooks["experimental.compaction.autocontinue"]).toBe("function");
  });

  test("has event hook", () => {
    expect(typeof hooks.event).toBe("function");
  });

  test("system transform appends to system array", async () => {
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({} as any, output);
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("Thatch provides persistent memory");
  });

  test("chat.message prepends nudge when extraction is empty", async () => {
    const output: any = { parts: [{ type: "text", text: "hello" }] };
    await hooks["chat.message"]!({} as any, output);
    expect(output.parts.length).toBe(1); // no nudge, buffer empty
  });

  test("compaction hook appends context and marks session as compacting", async () => {
    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_compact_1" } as any, output);
    expect(output.context.length).toBe(1);
    expect(output.context[0]).toContain("Thatch persistent memory");
    expect(output.context[0]).not.toContain("thatch_memory_recall");
  });

  test("each tool has description and execute", () => {
    for (const [name, t] of Object.entries(hooks.tool!)) {
      expect(t.description, `${name} missing description`).toBeTruthy();
      expect(typeof t.description).toBe("string");
      expect(typeof t.execute, `${name} missing execute`).toBe("function");
    }
  });

  test("each tool has args schema", () => {
    for (const [name, t] of Object.entries(hooks.tool!)) {
      expect(t.args, `${name} missing args`).toBeDefined();
    }
  });

  test("dispose hook is defined", () => {
    expect(typeof hooks.dispose).toBe("function");
  });

  test("has tool.execute.after hook", () => {
    expect(typeof hooks["tool.execute.after"]).toBe("function");
  });

  test("chat tool calls echo visible parts back into the transcript", async () => {
    const before = promptAsyncCalls.length;
    await hooks["tool.execute.after"]!(
      { tool: "thatch_chat_send", sessionID: "ses_echo", callID: "ce1", args: { to: "Landru", body: "hello there" } },
      { title: "chat send", output: "[sent] to Landru (ses_f6c9e9a0)\n\nThe recipient is nudged when its session is idle. If its host process is gone (stale in chat_list), the message waits unread - a dead session never reads it.", metadata: {} },
    );
    expect(promptAsyncCalls.length).toBe(before + 1);
    const call = promptAsyncCalls[promptAsyncCalls.length - 1];
    expect(call.path.id).toBe("ses_echo");
    // noReply stores the part without starting a model turn; non-synthetic
    // is what makes the TUI render it.
    expect(call.body.noReply).toBe(true);
    expect(call.body.parts[0].type).toBe("text");
    expect(call.body.parts[0].text).toBe("[chat] to Landru: hello there");
    expect(call.body.parts[0].synthetic).toBeUndefined();
  });

  test("failed chat sends and non-conversational chat tools do not echo", async () => {
    const before = promptAsyncCalls.length;
    await hooks["tool.execute.after"]!(
      { tool: "thatch_chat_send", sessionID: "ses_echo", callID: "ce2", args: { to: "ghost", body: "hi" } },
      { title: "chat send", output: `Not sent: No registered session named "ghost". Use chat_list to see who is available.`, metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_chat_list", sessionID: "ses_echo", callID: "ce3", args: {} },
      { title: "chat list", output: "[chat] 1 session registered", metadata: {} },
    );
    expect(promptAsyncCalls.length).toBe(before);
  });
});

describe("plugin entry", () => {
  test("installs skill files under the redirected config home", async () => {
    const { readFileSync } = await import("node:fs");
    const skillPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-fact-extractor", "SKILL.md",
    );
    expect(readFileSync(skillPath, "utf8")).toContain("thatch-fact-extractor");

    const primerPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-project-primer", "SKILL.md",
    );
    expect(readFileSync(primerPath, "utf8")).toContain("thatch-project-primer");

    // opencode installs both shared and opencode-only skills
    const reviewPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-review-pedantic", "SKILL.md",
    );
    expect(readFileSync(reviewPath, "utf8")).toContain("thatch-review-pedantic");

    const coordinatorPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-code-review", "SKILL.md",
    );
    expect(readFileSync(coordinatorPath, "utf8")).toContain("thatch-code-review");
  });

  test("event handler calls client.session.prompt on session.created", async () => {
    let promptCalled = false;
    let promptArgs: any = null;

    const mockClient = {
      session: {
        prompt: async (args: any) => {
          promptCalled = true;
          promptArgs = args;
        },
      },
    };

    const testHooks = await server({ client: mockClient, worktree: "/tmp/test" } as any);

    await testHooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "test-session-123" } },
      },
    } as any);

    expect(promptCalled).toBe(true);
    expect(promptArgs.path.id).toBe("test-session-123");
    expect(promptArgs.body.noReply).toBe(true);
    expect(promptArgs.body.parts[0].type).toBe("text");
    expect(promptArgs.body.parts[0].text).toContain("thatch");

    testHooks.dispose?.();
  });

  test("delivery guard wiring: a wake into a deleted directory is skipped with a debug line", async () => {
    // Wiring-level, not a direct guardDelivery call: this drives the
    // integrated path (server -> createRuntime -> guarded promptSession)
    // so a guard that is defined but never wired cannot pass here. The
    // function-level behavior lives in tests/delivery-guard.test.ts.
    const wakeDir = mkdtempSync(join(tmpdir(), "thatch-guard-gone-"));
    const guardDb = mkdtempSync(join(tmpdir(), "thatch-guard-db-"));
    const prevDbPath = process.env.THATCH_DB_PATH;
    const prevDebug = process.env.THATCH_DEBUG;
    process.env.THATCH_DB_PATH = join(guardDb, "test.db");
    // Only the delivery guard's tag passes the filter, so any matched line
    // in the log is the guard's and nothing else's.
    process.env.THATCH_DEBUG = "runtime:delivery";
    try {
      let promptCalled = false;
      const guardClient = {
        session: {
          prompt: async () => {
            promptCalled = true;
          },
        },
      };
      const testHooks = await server({ client: guardClient, worktree: wakeDir } as any);
      try {
        rmSync(wakeDir, { recursive: true });
        await testHooks.event!({
          event: {
            type: "session.created",
            properties: { info: { id: "ses-guard-gone" } },
          },
        } as any);

        // The wake must not run against the deleted directory: no prompt,
        // no throw, and the debug line names the session and the path.
        expect(promptCalled).toBe(false);
        const log = readFileSync(join(guardDb, "debug.log"), "utf8");
        expect(log).toContain("runtime:delivery");
        expect(log).toContain("ses-guard-gone");
        expect(log).toContain(wakeDir);
      } finally {
        await testHooks.dispose?.();
      }
    } finally {
      process.env.THATCH_DB_PATH = prevDbPath;
      process.env.THATCH_DEBUG = prevDebug;
    }
  });

  test("event handler ignores non-session.created events", async () => {
    let promptCalled = false;

    const mockClient = {
      session: {
        prompt: async () => {
          promptCalled = true;
        },
      },
    };

    const testHooks = await server({ client: mockClient, worktree: "/tmp/test" } as any);

    await testHooks.event!({
      event: {
        type: "session.updated",
        properties: {},
      },
    } as any);

    expect(promptCalled).toBe(false);

    testHooks.dispose?.();
  });
});
