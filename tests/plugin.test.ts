import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { ThatchDB } from "../src/db";

// Mock @huggingface/transformers so BgeEmbeddingModel can embed without
// downloading a model. Produces the same hash-based vectors as
// MockEmbeddingModel, stripping the QUERY_PREFIX so query and passage
// embeddings for the same text produce identical vectors.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
mock.module("@huggingface/transformers", () => ({
  // BgeEmbeddingModel's default factory sets env.cacheDir before building the
  // pipeline, so the mock must expose a writable env object.
  env: {},
  pipeline: async () => async (text: string, _opts: any) => {
    const clean = text.startsWith(QUERY_PREFIX) ? text.slice(QUERY_PREFIX.length) : text;
    let h = 0;
    for (let i = 0; i < clean.length; i++) {
      h = ((h << 5) - h) + clean.charCodeAt(i);
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

import {
  server,
  osProcessArgs,
  startupSessionId,
  startupSessionIdFromArgv,
  continuesLastSessionFromArgv,
  continuesLastSessionId,
} from "../src/index";
import {
  sessionStartReminder,
  recallNudge,
  claudeRecallNudge,
  claudeSessionStartReminder,
  claudeWriteNudge,
  extractionNudge,
  extractionDirectPrompt,
  type NudgeMatch,
} from "../src/prompts";

let hooks: Awaited<ReturnType<typeof server>>;
let dbDir: string;
// Records every promptAsync the plugin issues so transcript-echo tests can
// assert on delivery. Captured at call time (synchronously inside the mock)
// so assertions work immediately after a hook invocation.
const promptAsyncCalls: any[] = [];
// Records TUI actions the wrap-up command resolution triggers.
const tuiExecuteCommandCalls: any[] = [];
const tuiPublishCalls: any[] = [];
const tuiToastCalls: any[] = [];
// The message list the mock session.messages returns; wrap-up tests point
// this at canned assistant responses to simulate the greenlight check.
let wrapUpMessages: any[] = [];
// The real console.error, stashed by beforeAll so afterAll can restore it
// after the auto-register log filter is removed.
let fileConsoleError: ((...args: unknown[]) => void) | null = null;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-plugin-test-"));
  process.env.THATCH_DB_PATH = join(dbDir, "test.db");
  // Redirect skill installation away from the real ~/.config.
  process.env.XDG_CONFIG_HOME = join(dbDir, "config");
  // The shared mock client below has no session.get, so every chat.event
  // hook fires the auto-register degrade path in runtime.ts, which logs each
  // failure fire-and-forget. Such a log can land after the triggering test
  // has ended, so a per-test silence cannot trap it reliably. Filter the
  // known phrase for the whole file instead; every other error still logs.
  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.includes("chat auto-register failed")) return;
    realConsoleError(...args);
  };
  fileConsoleError = realConsoleError;
  // RECALL_THRESHOLD is a module-level constant (0.55 default), read when
  // runtime.ts is first imported. Setting the env var here can't change it,
  // but 0.55 works: the hash-based mock scores ~1.0 for identical texts and
  // near-orthogonal for different texts.
  const mockClient = {
    session: {
      prompt: async () => {},
      promptAsync: async (opts: any) => {
        promptAsyncCalls.push(opts);
      },
      create: async () => ({ data: { id: "test-child" } }),
      delete: async () => {},
      messages: async () => ({ data: wrapUpMessages }),
    },
    tui: {
      showToast: async (opts: any) => {
        tuiToastCalls.push(opts);
      },
      executeCommand: async (opts: any) => {
        tuiExecuteCommandCalls.push(opts);
        return { data: true };
      },
      publish: async (opts: any) => {
        tuiPublishCalls.push(opts);
        return { data: true };
      },
    },
  };
  hooks = await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree", directory: "/tmp/thatch-test-worktree" } as any);

  // Store a memory so the recall nudge has something to match. Using the
  // server's own tools ensures the embedding comes from the same (mocked)
  // BgeEmbeddingModel that chat.message will use for the query. The tool
  // embeds "# {label}\n\n{content}" — the recall nudge test prompt must
  // match that full text for the hash-based mock to produce identical vectors.
  await hooks.tool!.thatch_memory_remember.execute({
    label: "test-coverage",
    content: "test coverage metrics and gaps",
    store: "global",
  } as any, {} as any);
});

afterAll(() => {
  hooks.dispose?.();
  if (fileConsoleError) console.error = fileConsoleError;
  rmSync(dbDir, { recursive: true, force: true });
  delete process.env.THATCH_DB_PATH;
  delete process.env.XDG_CONFIG_HOME;
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

  test("chat transcript echoes skip the nudge machinery entirely", async () => {
    // Buffer an interaction so the extraction nudge would fire on any
    // ordinary message for this session - without the echo skip, the echo
    // bubble would get the nudge attached to a message no model turn reads.
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

    // The same session with the same pending buffer, but a real user
    // message: the nudge machinery still runs.
    const realOutput: any = {
      message: { id: "msg_real" },
      parts: [{ type: "text", text: "hello there friend" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_echo_skip", messageID: "msg_real" } as any, realOutput);
    expect(realOutput.parts.length).toBe(2);
  });

  test("buffered tool interactions surface as a payload nudge, scoped per session", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_a", callID: "c1", args: { command: "ls" } },
      { title: "list files", output: "README.md", metadata: {} },
    );

    // A different session sees no nudge.
    const otherOutput: any = { message: { id: "msg_0" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_b" } as any, otherOutput);
    expect(otherOutput.parts.length).toBe(0);

    // The originating session gets the nudge with the session ID and fetch tool.
    const output: any = { message: { id: "msg_1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_a", messageID: "msg_1" } as any, output);
    expect(output.parts.length).toBe(1);
    expect(output.parts[0].type).toBe("text");
    expect(output.parts[0].sessionID).toBe("ses_a");
    expect(output.parts[0].text).toContain("thatch-fact-extractor");
    expect(output.parts[0].text).toContain("ses_a");
    expect(output.parts[0].text).toContain("thatch_get_extraction_payload");
    expect(output.parts[0].text).not.toContain('"tool":"bash"');

    // The buffer is NOT drained — it persists until the agent calls
    // memory_remember. A second chat.message delivers the same nudge again
    // (now at escalation tier 1 since missedCount incremented).
    const output2: any = { message: { id: "msg_2" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_a" } as any, output2);
    expect(output2.parts.length).toBe(1);
    expect(output2.parts[0].text).toContain("thatch-fact-extractor");
    expect(output2.parts[0].text).toContain("ses_a");

    // After the agent writes a memory, the buffer is consumed.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_a", callID: "c1b", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );
    const output3: any = { message: { id: "msg_3" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_a" } as any, output3);
    expect(output3.parts.length).toBe(0);
  });

  test("thatch's own tools are not buffered for extraction", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_c", callID: "c2", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );
    const output: any = { message: { id: "msg_3" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_c" } as any, output);
    expect(output.parts.length).toBe(0);
  });

  test("skill, task, and subagent meta-tools are not buffered (feedback loop prevention)", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: "ses_d", callID: "c3", args: { name: "thatch-fact-extractor" } },
      { title: "load skill", output: "loaded", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "ses_d", callID: "c4", args: { description: "extract" } },
      { title: "dispatch", output: "done", metadata: {} },
    );
    // v2's dispatch tool is named subagent; buffering a dispatch would feed
    // the extraction loop with its own exhaust (nudge -> dispatch ->
    // buffered dispatch -> nudge).
    await hooks["tool.execute.after"]!(
      { tool: "subagent", sessionID: "ses_d", callID: "c5", args: { description: "extract" } },
      { title: "dispatch", output: "done", metadata: {} },
    );
    const output: any = { message: { id: "msg_4" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_d" } as any, output);
    expect(output.parts.length).toBe(0);
  });

  test("extraction nudge escalates with consecutive misses and resets on memory write", async () => {
    // First nudge: tier 0 (polite)
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_esc", callID: "e1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    const out1: any = { message: { id: "msg_e1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_esc", messageID: "msg_e1" } as any, out1);
    expect(out1.parts[0].text).toContain("Dispatch a task with background: true");
    expect(out1.parts[0].text).not.toContain("YOU HAVE NOT");

    // Second nudge without compliance: still tier 0 (missedCount was 0, now 1)
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_esc", callID: "e2", args: { command: "pwd" } },
      { title: "pwd", output: "/tmp", metadata: {} },
    );
    const out2: any = { message: { id: "msg_e2" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_esc", messageID: "msg_e2" } as any, out2);
    expect(out2.parts[0].text).toContain("Dispatch a task with background: true");

    // Third nudge without compliance: tier 1 (missedCount was 1, now 2)
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_esc", callID: "e3", args: { command: "echo" } },
      { title: "echo", output: "hi", metadata: {} },
    );
    const out3: any = { message: { id: "msg_e3" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_esc", messageID: "msg_e3" } as any, out3);
    expect(out3.parts[0].text).toContain("YOU HAVE NOT PROCESSED");

    // Agent writes a memory: counter resets
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_esc", callID: "e4", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    // Next nudge: back to tier 0
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_esc", callID: "e5", args: { command: "date" } },
      { title: "date", output: "2026-07-17", metadata: {} },
    );
    const out4: any = { message: { id: "msg_e5" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_esc", messageID: "msg_e5" } as any, out4);
    expect(out4.parts[0].text).toContain("Dispatch a task with background: true");
    expect(out4.parts[0].text).not.toContain("YOU HAVE NOT");
  });

  test("fix A: child memory_remember drains parent's pre-dispatch entries", async () => {
    // Step 1: Buffer tool interactions in the PARENT session BEFORE dispatch
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_parent_fixa", callID: "fa0", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );

    // Step 2: Simulate a sub-agent child session being created (dispatch).
    // The snapshot captures the parent's current buffer at this point.
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_child_fixa", parentID: "ses_parent_fixa" } } } as any,
    });

    // Parent should have a pending nudge
    const parentOut: any = { message: { id: "msg_fa0" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_parent_fixa", messageID: "msg_fa0" } as any, parentOut);
    expect(parentOut.parts.length).toBe(1);
    expect(parentOut.parts[0].text).toContain("Dispatch a task with background: true");

    // Step 3: Child session writes a memory (as a sub-agent would)
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_child_fixa", callID: "fa1", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    // Parent's pre-dispatch entries should be drained — no nudge on next chat.message
    const parentOut2: any = { message: { id: "msg_fa1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_parent_fixa", messageID: "msg_fa1" } as any, parentOut2);
    expect(parentOut2.parts.length).toBe(0);
  });

  test("fix A: child drain preserves interleaved-turn entries in parent buffer", async () => {
    // Buffer tool calls in parent BEFORE dispatch
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_parent_interleave", callID: "iv0", args: { command: "git status" } },
      { title: "status", output: "clean", metadata: {} },
    );

    // Dispatch sub-agent — snapshot captures the parent's current buffer
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_child_interleave", parentID: "ses_parent_interleave" } } } as any,
    });

    // While sub-agent runs, parent makes more tool calls (interleaved turn)
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_parent_interleave", callID: "iv1", args: { command: "git log" } },
      { title: "log", output: "history", metadata: {} },
    );

    // Sub-agent writes a memory — drains only snapshot entries
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_child_interleave", callID: "iv2", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    // Parent should still have a pending nudge for the interleaved entry
    const parentOut: any = { message: { id: "msg_iv1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_parent_interleave", messageID: "msg_iv1" } as any, parentOut);
    expect(parentOut.parts.length).toBe(1);
    expect(parentOut.parts[0].text).toContain("Dispatch a task with background: true");
  });

  test("accept/complete: extraction_done quiets the nudge without dropping entries", async () => {
    // Buffer tool interactions
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_fixc", callID: "fc1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );

    // Should have a pending nudge
    const out1: any = { message: { id: "msg_fc0" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_fixc", messageID: "msg_fc0" } as any, out1);
    expect(out1.parts.length).toBe(1);

    // Parent accepts the buffer after dispatching the extractor
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_fixc", callID: "fc2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );

    // Nudge quiets while the extractor works
    const out2: any = { message: { id: "msg_fc1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_fixc", messageID: "msg_fc1" } as any, out2);
    expect(out2.parts.length).toBe(0);

    // Extractor (child session) finishes without saving anything and goes
    // idle — that completes the accepted entries.
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_child_fixc", parentID: "ses_fixc" } } } as any,
    });
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_child_fixc", status: { type: "idle" } } } as any,
    });

    const out3: any = { message: { id: "msg_fc2" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_fixc", messageID: "msg_fc2" } as any, out3);
    expect(out3.parts.length).toBe(0);
  });

  test("accept/requeue: child session error returns entries to pending", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_requeue", callID: "rq1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_requeue", callID: "rq2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );

    // Extractor child errors out before writing any memory
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_child_requeue", parentID: "ses_requeue" } } } as any,
    });
    await hooks.event!({ event: {
      type: "session.error",
      properties: { sessionID: "ses_child_requeue", error: { name: "APIError", message: "boom" } } } as any,
    });

    // The nudge replays with the session ID — facts are not lost
    const out: any = { message: { id: "msg_rq1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_requeue", messageID: "msg_rq1" } as any, out);
    expect(out.parts.length).toBe(1);
    expect(out.parts[0].text).toContain("ses_requeue");
    expect(out.parts[0].text).toContain("thatch_get_extraction_payload");
  });

  test("accept/requeue: child session deleted before completing returns entries", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_delq", callID: "dq1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_delq", callID: "dq2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_child_delq", parentID: "ses_delq" } } } as any,
    });
    await hooks.event!({ event: {
      type: "session.deleted",
      properties: { info: { id: "ses_child_delq" } } } as any,
    });

    const out: any = { message: { id: "msg_dq1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_delq", messageID: "msg_dq1" } as any, out);
    expect(out.parts.length).toBe(1);
    expect(out.parts[0].text).toContain("ses_delq");
    expect(out.parts[0].text).toContain("thatch_get_extraction_payload");
  });

  test("accept/complete: child extraction_done completes the parent's accepted entries", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_ack", callID: "ak1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_ack", callID: "ak2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_child_ack", parentID: "ses_ack" } } } as any,
    });

    // Extractor finishes a no-save run by calling extraction_done itself
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_child_ack", callID: "ak3", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );

    const out: any = { message: { id: "msg_ak1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_ack", messageID: "msg_ak1" } as any, out);
    expect(out.parts.length).toBe(0);
  });

  test("accept/complete: child memory write completes accepted entries", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_mwc", callID: "mw1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_mwc", callID: "mw2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_child_mwc", parentID: "ses_mwc" } } } as any,
    });
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_child_mwc", callID: "mw3", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    const out: any = { message: { id: "msg_mw1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_mwc", messageID: "msg_mw1" } as any, out);
    expect(out.parts.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Direct extraction (opencode SDK path)
  // -----------------------------------------------------------------------
  //
  // When the parent session goes idle with pending tool interactions, the
  // plugin creates a child session and prompts it directly instead of
  // injecting a nudge. The extracting set suppresses the nudge path while
  // the child runs. The nudge path remains as a fallback if direct
  // extraction fails.

  test("direct extraction: parent idle triggers child creation + promptAsync", async () => {
    let createCalled = false;
    let createArgs: any = null;
    let promptAsyncCalled = false;
    let promptAsyncArgs: any = null;

    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async (args: any) => { promptAsyncCalled = true; promptAsyncArgs = args; },
        create: async (args: any) => { createCalled = true; createArgs = args; return { data: { id: "child_direct1" } }; },
        delete: async () => {},
      },
      tui: {
        showToast: async () => {},
      },
    };

    // The preload (tests/clean-env.ts) strips OPENCODE_* vars. Set the one
    // this test needs, then clean up.
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true";

    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    // Buffer a tool interaction in the parent
    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_direct1", callID: "d1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );

    // Parent goes idle — should trigger direct extraction
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_direct1", status: { type: "idle" } } } as any,
    });

    expect(createCalled).toBe(true);
    expect(createArgs.body.parentID).toBe("ses_direct1");
    expect(promptAsyncCalled).toBe(true);
    expect(promptAsyncArgs.path.id).toBe("child_direct1");
    expect(promptAsyncArgs.body.parts[0].text).toContain("thatch-fact-extractor");

    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;

    testHooks.dispose?.();
  });

  test("direct extraction: extracting set suppresses nudge in chat.message", async () => {
    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_direct2" } }),
        delete: async () => {},
      },
      tui: {
        showToast: async () => {},
      },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    // Buffer a tool interaction
    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_direct2", callID: "d2", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );

    // Trigger extraction via parent idle
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_direct2", status: { type: "idle" } } } as any,
    });

    // chat.message should NOT inject the extraction nudge (extracting is active).
    // It should fall through to recall/prediction, which with a short prompt
    // produces no nudge.
    const out: any = { message: { id: "msg_d2" }, parts: [{ type: "text", text: "ok" }] };
    await testHooks["chat.message"]!({ sessionID: "ses_direct2", messageID: "msg_d2" } as any, out);
    expect(out.parts.length).toBe(1); // only the original part, no nudge
    expect(out.parts[0].text).not.toContain("thatch-fact-extractor");

    testHooks.dispose?.();
  });

  test("direct extraction: child idle cleans up and deletes child session", async () => {
    let deleteCalled = false;
    let deleteArgs: any = null;

    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_direct3" } }),
        delete: async (args: any) => { deleteCalled = true; deleteArgs = args; },
      },
      tui: {
        showToast: async () => {},
      },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    // Buffer + trigger extraction
    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_direct3", callID: "d3", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_direct3", status: { type: "idle" } } } as any,
    });

    // Simulate the child session being created (session.created event)
    await testHooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "child_direct3", parentID: "ses_direct3" } } } as any,
    });

    // Child goes idle — should clean up and delete the child
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "child_direct3", status: { type: "idle" } } } as any,
    });

    expect(deleteCalled).toBe(true);
    expect(deleteArgs.path.id).toBe("child_direct3");

    // After cleanup, the extracting flag is cleared and the parent's
    // snapshot entries are drained from the buffer (no-save run fallback).
    // No nudge should fire — the entries are gone.
    const out: any = { message: { id: "msg_d3" }, parts: [{ type: "text", text: "hello world testing" }] };
    await testHooks["chat.message"]!({ sessionID: "ses_direct3", messageID: "msg_d3" } as any, out);
    expect(out.parts.length).toBe(1); // no nudge, buffer drained on child idle

    testHooks.dispose?.();
  });

  test("direct extraction: child error clears extracting, nudge fires as fallback", async () => {
    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_direct4" } }),
        delete: async () => {},
      },
      tui: {
        showToast: async () => {},
      },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_direct4", callID: "d4", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_direct4", status: { type: "idle" } } } as any,
    });
    await testHooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "child_direct4", parentID: "ses_direct4" } } } as any,
    });

    // Child errors out
    await testHooks.event!({ event: {
      type: "session.error",
      properties: { sessionID: "child_direct4", error: { name: "APIError", message: "boom" } } } as any,
    });

    // extracting flag cleared — nudge should fire as fallback
    const out: any = { message: { id: "msg_d4" }, parts: [{ type: "text", text: "hello world testing" }] };
    await testHooks["chat.message"]!({ sessionID: "ses_direct4", messageID: "msg_d4" } as any, out);
    expect(out.parts.length).toBe(2);
    expect(out.parts[1].text).toContain("thatch-fact-extractor");

    testHooks.dispose?.();
  });

  test("direct extraction: child memory_remember drains parent buffer via snapshot", async () => {
    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_direct5" } }),
        delete: async () => {},
      },
      tui: {
        showToast: async () => {},
      },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    // Buffer tool interactions in parent
    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_direct5", callID: "d5a", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );

    // Parent idle triggers extraction
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_direct5", status: { type: "idle" } } } as any,
    });

    // session.created fires for the child — snapshot taken
    await testHooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "child_direct5", parentID: "ses_direct5" } } } as any,
    });

    // Child writes a memory — drains parent's snapshot entries
    await testHooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "child_direct5", callID: "d5b", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    // Parent buffer should be drained — no nudge on next chat.message
    const out: any = { message: { id: "msg_d5" }, parts: [{ type: "text", text: "hello world testing" }] };
    await testHooks["chat.message"]!({ sessionID: "ses_direct5", messageID: "msg_d5" } as any, out);
    expect(out.parts.length).toBe(1); // no nudge, buffer drained

    testHooks.dispose?.();
  });

  test("direct extraction: sync path uses prompt when bg env var unset", async () => {
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

  test("direct extraction: no extraction triggered when buffer is empty", async () => {
    let createCalled = false;

    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => { createCalled = true; return { data: { id: "child_empty" } }; },
        delete: async () => {},
      },
      tui: {
        showToast: async () => {},
      },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    // Parent goes idle with no pending interactions
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_empty", status: { type: "idle" } } } as any,
    });

    expect(createCalled).toBe(false);

    testHooks.dispose?.();
  });

  test("HIGH fix: interleaved entries survive when child writes memory then goes idle", async () => {
    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_interleave_fix" } }),
        delete: async () => {},
      },
      tui: { showToast: async () => {} },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    // Buffer 3 entries in parent, trigger extraction
    for (let i = 0; i < 3; i++) {
      await testHooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "ses_interleave_fix", callID: `pre-${i}`, args: { command: `cmd-${i}` } },
        { title: `title-${i}`, output: `out-${i}`, metadata: {} },
      );
    }
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_interleave_fix", status: { type: "idle" } } } as any,
    });
    await testHooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "child_interleave_fix", parentID: "ses_interleave_fix" } } } as any,
    });

    // Simulate interleaved turn: 2 new entries arrive while child runs
    for (let i = 0; i < 2; i++) {
      await testHooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "ses_interleave_fix", callID: `post-${i}`, args: { command: `cmd2-${i}` } },
        { title: `title2-${i}`, output: `out2-${i}`, metadata: {} },
      );
    }

    // Child writes a memory — drains snapshot (3 pre-dispatch entries),
    // deletes parentSnapshots entry
    await testHooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "child_interleave_fix", callID: "mem", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    // Child goes idle — must NOT drain the entire buffer (interleaved
    // entries should survive for the next extraction cycle)
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "child_interleave_fix", status: { type: "idle" } } } as any,
    });

    // The 2 interleaved entries should still be pending — nudge fires
    const out: any = { message: { id: "msg_iv" }, parts: [{ type: "text", text: "hello world testing" }] };
    await testHooks["chat.message"]!({ sessionID: "ses_interleave_fix", messageID: "msg_iv" } as any, out);
    expect(out.parts.length).toBe(2);
    expect(out.parts[1].text).toContain("thatch-fact-extractor");

    testHooks.dispose?.();
  });

  test("HIGH fix: non-extraction sub-agent idle does not drain buffer or delete session", async () => {
    let deleteCalled = false;

    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "should-not-delete" } }),
        delete: async () => { deleteCalled = true; },
      },
      tui: { showToast: async () => {} },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    // Buffer entries in parent
    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_task_parent", callID: "tk1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );

    // Simulate a task-dispatched sub-agent (NOT created by triggerExtraction)
    await testHooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_task_child", parentID: "ses_task_parent" } } } as any,
    });

    // Sub-agent goes idle — should NOT drain buffer or delete session
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_task_child", status: { type: "idle" } } } as any,
    });

    expect(deleteCalled).toBe(false);

    // Buffer should still have entries — nudge should fire
    const out: any = { message: { id: "msg_task" }, parts: [{ type: "text", text: "hello world testing" }] };
    await testHooks["chat.message"]!({ sessionID: "ses_task_parent", messageID: "msg_task" } as any, out);
    expect(out.parts.length).toBe(2);
    expect(out.parts[1].text).toContain("thatch-fact-extractor");

    testHooks.dispose?.();
  });

  test("toast: shows metrics on child idle after memory writes", async () => {
    let toastCalled = false;
    let toastArgs: any = null;

    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_toast1" } }),
        delete: async () => {},
      },
      tui: {
        showToast: async (args: any) => { toastCalled = true; toastArgs = args; },
      },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    // Buffer + trigger extraction
    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_toast1", callID: "t1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_toast1", status: { type: "idle" } } } as any,
    });
    await testHooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "child_toast1", parentID: "ses_toast1" } } } as any,
    });

    // Child writes 2 new memories and 1 updated
    await testHooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "child_toast1", callID: "t2", args: { label: "a" } },
      { title: "save", output: "[saved]", metadata: {} },
    );
    await testHooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "child_toast1", callID: "t3", args: { label: "b" } },
      { title: "save", output: "[saved]", metadata: {} },
    );
    await testHooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "child_toast1", callID: "t4", args: { label: "a", overwrite: true } },
      { title: "save", output: "[saved]", metadata: {} },
    );

    // Child goes idle — toast should fire with metrics
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "child_toast1", status: { type: "idle" } } } as any,
    });

    expect(toastCalled).toBe(true);
    expect(toastArgs.body.message).toContain("new: 2");
    expect(toastArgs.body.message).toContain("updated: 1");
    expect(toastArgs.body.variant).toBe("success");

    testHooks.dispose?.();
  });

  test("toast: no toast on no-save extraction run", async () => {
    let toastCalled = false;

    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_toast2" } }),
        delete: async () => {},
      },
      tui: {
        showToast: async () => { toastCalled = true; },
      },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_toast2", callID: "t5", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_toast2", status: { type: "idle" } } } as any,
    });
    await testHooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "child_toast2", parentID: "ses_toast2" } } } as any,
    });

    // Child goes idle without writing any memories — no toast should fire.
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "child_toast2", status: { type: "idle" } } } as any,
    });

    expect(toastCalled).toBe(false);

    testHooks.dispose?.();
  });

  test("toast: tracks deletions in child sessions", async () => {
    let toastArgs: any = null;

    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_toast3" } }),
        delete: async () => {},
      },
      tui: {
        showToast: async (args: any) => { toastArgs = args; },
      },
    };
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_toast3", callID: "t6", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_toast3", status: { type: "idle" } } } as any,
    });
    await testHooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "child_toast3", parentID: "ses_toast3" } } } as any,
    });

    // Child writes 1 new memory and deletes 1
    await testHooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "child_toast3", callID: "t7", args: { label: "c" } },
      { title: "save", output: "[saved]", metadata: {} },
    );
    await testHooks["tool.execute.after"]!(
      { tool: "thatch_memory_forget", sessionID: "child_toast3", callID: "t8", args: { label: "old" } },
      { title: "forget", output: "[forgotten]", metadata: {} },
    );

    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "child_toast3", status: { type: "idle" } } } as any,
    });

    expect(toastArgs.body.message).toContain("new: 1");
    expect(toastArgs.body.message).toContain("deleted: 1");
    expect(toastArgs.body.variant).toBe("success");

    testHooks.dispose?.();
  });

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

// ---------------------------------------------------------------------------
// sessionStartReminder
// ---------------------------------------------------------------------------

describe("sessionStartReminder", () => {
  test("includes store name and recall instructions", () => {
    const reminder = sessionStartReminder("test-owner/test-repo");

    expect(reminder).toContain("[thatch]");
    expect(reminder).toContain("test-owner/test-repo");
    expect(reminder).toContain("thatch_memory_recall");
    expect(reminder).toContain("user preferences and personality");
    expect(reminder).toContain("project architecture and conventions");
    expect(reminder).toContain("thatch_store_list");
    expect(reminder).toContain("thatch_memory_list");
  });
});

// ---------------------------------------------------------------------------
// recallNudge / claudeRecallNudge
// ---------------------------------------------------------------------------

describe("recallNudge (opencode)", () => {
  test("single match uses singular form", () => {
    const matches: NudgeMatch[] = [{ label: "Architecture", score: 0.72 }];
    const nudge = recallNudge(matches);
    expect(nudge).toContain("1 memory relates to this prompt");
    expect(nudge).toContain('"Architecture"');
    expect(nudge).toContain("thatch_memory_recall");
  });

  test("multiple matches use plural and show up to 2 labels", () => {
    const matches: NudgeMatch[] = [
      { label: "Architecture", score: 0.8 },
      { label: "Module map", score: 0.7 },
      { label: "Conventions", score: 0.65 },
    ];
    const nudge = recallNudge(matches);
    expect(nudge).toContain("3 memories relate to this prompt");
    expect(nudge).toContain('"Architecture"');
    expect(nudge).toContain('"Module map"');
    expect(nudge).toContain("etc.");
    expect(nudge).not.toContain('"Conventions"');
  });
});

describe("claudeRecallNudge (Claude Code / Cursor)", () => {
  test("uses bare tool name without thatch_ prefix", () => {
    const matches: NudgeMatch[] = [{ label: "Architecture", score: 0.72 }];
    const nudge = claudeRecallNudge(matches);
    expect(nudge).toContain("memory_recall");
    expect(nudge).not.toContain("thatch_memory_recall");
  });
});

// ---------------------------------------------------------------------------
// claudeSessionStartReminder / claudeWriteNudge
// ---------------------------------------------------------------------------

describe("claudeSessionStartReminder", () => {
  test("includes repo name and bare tool names (no thatch_ prefix)", () => {
    const reminder = claudeSessionStartReminder("owner/repo");
    expect(reminder).toContain("[thatch]");
    expect(reminder).toContain("owner/repo");
    expect(reminder).toContain("store_list");
    expect(reminder).toContain("memory_list");
    expect(reminder).toContain("memory_recall");
    expect(reminder).not.toContain("thatch_store_list");
    expect(reminder).not.toContain("thatch_memory_list");
    expect(reminder).not.toContain("thatch_memory_recall");
  });

  test("without hygiene returns just the base text", () => {
    const reminder = claudeSessionStartReminder("owner/repo");
    expect(reminder).not.toContain("[thatch hygiene]");
  });

  test("with null hygiene returns just the base text", () => {
    const reminder = claudeSessionStartReminder("owner/repo", null);
    expect(reminder).not.toContain("[thatch hygiene]");
  });

  test("with hygiene appends the hygiene block with bare tool names", () => {
    const reminder = claudeSessionStartReminder("owner/repo", "Store x: 2 duplicate-candidate pairs");
    expect(reminder).toContain("[thatch hygiene]");
    expect(reminder).toContain("Store x: 2 duplicate-candidate pairs");
    expect(reminder).toContain("find_duplicates");
    expect(reminder).toContain("memory_show");
    expect(reminder).not.toContain("thatch_find_duplicates");
    expect(reminder).not.toContain("thatch_memory_show");
  });
});

describe("claudeWriteNudge", () => {
  test("returns the after-responding check prompt", () => {
    const nudge = claudeWriteNudge();
    expect(nudge).toContain("[thatch]");
    expect(nudge).toContain("After responding");
    expect(nudge).toContain("save to thatch");
  });
});

describe("extractionNudge escalation", () => {
  const sessionID = "sess-abc";
  const tool = "thatch_memory_remember";

  test("tier 0 (missedCount 0-1): leads with verb, mentions background dispatch", () => {
    const nudge = extractionNudge(3, 0, tool, sessionID);
    expect(nudge).toContain("Dispatch a task with background: true");
    expect(nudge).toContain("subagent_type");
    expect(nudge).toContain("thatch_extraction_done");
    expect(nudge).toContain("not user input");
    expect(nudge).toContain("continue waiting");
    expect(nudge).not.toContain("YOU HAVE NOT");
    expect(nudge).not.toContain("IGNORING");
  });

  test("tier 0 includes session ID and fetch tool name, not payload", () => {
    const nudge = extractionNudge(3, 0, tool, sessionID);
    expect(nudge).toContain(sessionID);
    expect(nudge).toContain("thatch_get_extraction_payload");
    expect(nudge).not.toContain('"interactions"');
    expect(nudge).not.toContain('"projectStore"');
  });

  test("tier 0 MCP path: uses generic sub-agent wording, not background: true", () => {
    const nudge = extractionNudge(3, 0, "mcp__thatch__memory_remember", sessionID);
    expect(nudge).toContain("Spawn a background sub-agent");
    expect(nudge).not.toContain("background: true");
    expect(nudge).not.toContain("subagent_type");
    expect(nudge).toContain("mcp__thatch__extraction_done");
    expect(nudge).toContain("mcp__thatch__get_extraction_payload");
  });

  test("tier 1 (missedCount 2): directive prefix, no shouting", () => {
    const nudge = extractionNudge(3, 2, tool, sessionID);
    expect(nudge).toContain("YOU HAVE NOT PROCESSED");
    expect(nudge).not.toContain("IGNORING");
  });

  test("tier 2 (missedCount 3+): all caps, harsh", () => {
    const nudge = extractionNudge(3, 3, tool, sessionID);
    expect(nudge).toContain("IGNORING EXTRACTION INSTRUCTIONS");
    expect(nudge).toContain("INSTALLED THIS PLUGIN FOR A REASON");
    expect(nudge.toLowerCase()).toContain("subagent_type");
  });

  test("tier 2 escalates further with higher counts", () => {
    const nudge = extractionNudge(5, 10, tool, sessionID);
    expect(nudge).toContain("IGNORING");
  });

  test("all tiers include the session ID (case-insensitive for ALL-CAPS tier)", () => {
    for (const missed of [0, 2, 3]) {
      const nudge = extractionNudge(1, missed, tool, sessionID);
      expect(nudge.toLowerCase()).toContain(sessionID.toLowerCase());
    }
  });

  test("no tier includes the raw JSON payload", () => {
    for (const missed of [0, 2, 3]) {
      const nudge = extractionNudge(1, missed, tool, sessionID);
      expect(nudge).not.toContain('"interactions"');
      expect(nudge).not.toContain('"projectStore"');
      expect(nudge).not.toContain('"globalStore"');
    }
  });
});

describe("extractionDirectPrompt", () => {
  const sessionID = "sess-direct";

  test("tells the model to run the skill directly, no task dispatch", () => {
    const prompt = extractionDirectPrompt(3, sessionID);
    expect(prompt).toContain("thatch-fact-extractor");
    expect(prompt).toContain("thatch_memory_remember");
    expect(prompt).toContain("thatch_extraction_done");
    expect(prompt).not.toContain("Dispatch a task");
    expect(prompt).not.toContain("background: true");
  });

  test("includes the session ID and fetch tool name", () => {
    const prompt = extractionDirectPrompt(1, sessionID);
    expect(prompt).toContain(sessionID);
    expect(prompt).toContain("thatch_get_extraction_payload");
  });

  test("does not include the raw JSON payload", () => {
    const prompt = extractionDirectPrompt(1, sessionID);
    expect(prompt).not.toContain('"interactions"');
    expect(prompt).not.toContain('"projectStore"');
  });

  test("singular form for one interaction", () => {
    const prompt = extractionDirectPrompt(1, sessionID);
    expect(prompt).toContain("1 queued tool interaction.");
    expect(prompt).not.toContain("1 queued tool interactions");
  });

  test("plural form for multiple interactions", () => {
    const prompt = extractionDirectPrompt(5, sessionID);
    expect(prompt).toContain("5 queued tool interactions");
  });
});

// ---------------------------------------------------------------------------
// Recall nudge (prompt-aware, via chat.message hook)
// ---------------------------------------------------------------------------

describe("recall nudge via chat.message", () => {
  test("surfaces a recall nudge when prompt matches a stored memory", async () => {
    // The tool embeds "# {label}\n\n{content}", so the prompt must match
    // that full text for the hash-based mock to produce a matching vector.
    const output: any = {
      message: { id: "msg_recall_1" },
      parts: [{ type: "text", text: "# test-coverage\n\ntest coverage metrics and gaps" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_recall", messageID: "msg_recall_1" } as any, output);
    expect(output.parts.length).toBe(2);
    expect(output.parts[1].type).toBe("text");
    expect(output.parts[1].synthetic).toBe(true);
    expect(output.parts[1].text).toContain("test-coverage");
    expect(output.parts[1].text).toContain("thatch_memory_recall");
  });

  test("no nudge when prompt does not match any memory", async () => {
    const output: any = {
      message: { id: "msg_recall_2" },
      parts: [{ type: "text", text: "completely unrelated cooking recipe ideas" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_no_match", messageID: "msg_recall_2" } as any, output);
    expect(output.parts.length).toBe(1);
  });

  test("no nudge for short prompts even if content would match", async () => {
    const output: any = {
      message: { id: "msg_recall_3" },
      parts: [{ type: "text", text: "ok" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_short", messageID: "msg_recall_3" } as any, output);
    expect(output.parts.length).toBe(1);
  });

  test("extraction nudge takes priority over recall nudge", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_priority", callID: "c1", args: { command: "ls" } },
      { title: "list files", output: "file.txt", metadata: {} },
    );

    const output: any = {
      message: { id: "msg_priority" },
      parts: [{ type: "text", text: "test coverage metrics and gaps" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_priority", messageID: "msg_priority" } as any, output);
    expect(output.parts.length).toBe(2);
    expect(output.parts[1].synthetic).toBe(true);
    expect(output.parts[1].text).toContain("thatch-fact-extractor");
    expect(output.parts[1].text).not.toContain("test-coverage");
  });
});

// ---------------------------------------------------------------------------
// Prediction auto-fire (prompt-aware, via chat.message hook)
// ---------------------------------------------------------------------------

describe("prediction auto-fire via chat.message", () => {
  test("surfaces a prediction nudge when prompt matches a stored matcher", async () => {
    // Seed a prediction via the server's own tool so embeddings come from
    // the mocked BgeEmbeddingModel. The matcher text is the raw context;
    // the chat.message hook embeds the user's prompt with queryEmbed
    // (QUERY_PREFIX stripped by the mock), so identical text hits cosine ~1.0.
    await hooks.tool!.thatch_prediction_update.execute({
      matcher: "untangling a gnarly database migration plan",
      prediction: "ask about prod scars and prior migrations before touching the schema",
      signal: "create",
      rationale: "user emphasized prod-history checks",
    } as any, {} as any);

    const output: any = {
      message: { id: "msg_pred_1" },
      parts: [{ type: "text", text: "untangling a gnarly database migration plan" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_pred_1", messageID: "msg_pred_1" } as any, output);
    expect(output.parts.length).toBeGreaterThanOrEqual(2);
    const predPart = output.parts.find((p: any) => p.text?.includes("User decision model"));
    expect(predPart).toBeDefined();
    expect(predPart.synthetic).toBe(true);
    expect(predPart.text).toContain("[thatch]");
    expect(predPart.text).toContain("you may prefer"); // 0-evidence verb
  });

  test("no prediction nudge when prompt matches no matcher above threshold", async () => {
    const output: any = {
      message: { id: "msg_pred_2" },
      parts: [{ type: "text", text: "completely unrelated cooking recipe ideas for dinner" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_pred_2", messageID: "msg_pred_2" } as any, output);
    const predPart = output.parts.find((p: any) => p.text?.includes("User decision model"));
    expect(predPart).toBeUndefined();
  });

  test("prediction nudge and recall nudge fire independently", async () => {
    // Seed a prediction whose matcher exactly matches the memory's stored
    // text format so both nudges fire from one prompt. The memory was
    // seeded via the thatch_memory_remember tool (which embeds
    // "# {label}\n\n{content}"). Use that same text as the matcher so
    // findMatchers hits cosine ~1.0 with the same prompt text.
    await hooks.tool!.thatch_prediction_update.execute({
      matcher: "# test-coverage\n\ntest coverage metrics and gaps",
      prediction: "prioritize coverage in CI before merging",
      signal: "create",
      rationale: "user said coverage matters",
    } as any, {} as any);

    // Use a fresh sessionID so the compaction guard doesn't suppress.
    const output: any = {
      message: { id: "msg_pred_combined" },
      parts: [{ type: "text", text: "# test-coverage\n\ntest coverage metrics and gaps" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_pred_combined", messageID: "msg_pred_combined" } as any, output);
    // Both the recall nudge (memory match) and the prediction nudge
    // (matcher match) should fire as independent synthetic parts.
    expect(output.parts.length).toBeGreaterThanOrEqual(3);
    const recallPart = output.parts.find((p: any) => p.text?.includes("thatch_memory_recall"));
    const predPart = output.parts.find((p: any) => p.text?.includes("User decision model"));
    expect(recallPart).toBeDefined();
    expect(predPart).toBeDefined();
  });
});

describe("behavior auto-fire via chat.message", () => {
  test("surfaces a behavior nudge when prompt matches a stored behavior matcher", async () => {
    // Seed a behavior via the server's own tool so embeddings come from
    // the mocked BgeEmbeddingModel. Same pattern as the prediction auto-fire test.
    await hooks.tool!.thatch_behavior_codify.execute({
      situation: "about to import a new library into a project",
      behavior: "check the whole codebase for an existing import of that library first",
      rationale: "avoiding duplicate dependency imports",
    } as any, {} as any);

    const output: any = {
      message: { id: "msg_behavior_1" },
      parts: [{ type: "text", text: "about to import a new library into a project" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_behavior_1", messageID: "msg_behavior_1" } as any, output);
    expect(output.parts.length).toBeGreaterThanOrEqual(2);
    const behaviorPart = output.parts.find((p: any) => p.text?.includes("Situational behaviors"));
    expect(behaviorPart).toBeDefined();
    expect(behaviorPart.synthetic).toBe(true);
    expect(behaviorPart.text).toContain("[thatch]");
    expect(behaviorPart.text).toContain("consider"); // 0-evidence verb
  });

  test("no behavior nudge when prompt matches no behavior matcher above threshold", async () => {
    const output: any = {
      message: { id: "msg_behavior_2" },
      parts: [{ type: "text", text: "completely unrelated topic about cooking pasta from scratch" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_behavior_2", messageID: "msg_behavior_2" } as any, output);
    const behaviorPart = output.parts.find((p: any) => p.text?.includes("Situational behaviors"));
    expect(behaviorPart).toBeUndefined();
  });
});

describe("compaction guard for chat.message", () => {
  test("chat.message skips nudges while session is compacting", async () => {
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
    await hooks["experimental.compaction.autocontinue"]!({ sessionID: "ses_guard" } as any, { enabled: true } as any);

    const output: any = {
      message: { id: "msg_guard_2" },
      parts: [{ type: "text", text: "untangling a gnarly database migration plan" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard", messageID: "msg_guard_2" } as any, output);
    // The prediction nudge should fire (matcher seeded in earlier test).
    expect(output.parts.length).toBe(2);
    expect(output.parts[1].synthetic).toBe(true);
    expect(output.parts[1].text).toContain("User decision model");
  });

  test("extraction nudge is also suppressed during compaction", async () => {
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

  test("session.compacted event clears the compacting flag (belt-and-suspenders)", async () => {
    await hooks["experimental.session.compacting"]!(
      { sessionID: "ses_guard_evt" } as any,
      { context: [] as string[] },
    );

    // Simulate compaction success via the event hook (not autocontinue).
    await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "ses_guard_evt" } } } as any);

    const output: any = {
      message: { id: "msg_guard_evt" },
      parts: [{ type: "text", text: "untangling a gnarly database migration plan" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard_evt", messageID: "msg_guard_evt" } as any, output);
    // Flag was cleared by the event, so nudges should fire.
    expect(output.parts.length).toBe(2);
    expect(output.parts[1].synthetic).toBe(true);
  });

  test("compaction failure: non-compaction chat.message clears stale flag and resumes nudges", async () => {
    await hooks["experimental.session.compacting"]!(
      { sessionID: "ses_guard_fail" } as any,
      { context: [] as string[] },
    );

    // Simulate compaction failure: no autocontinue, no session.compacted event.
    // The next user message arrives with regular text parts (no compaction part).
    const output: any = {
      message: { id: "msg_guard_fail" },
      parts: [{ type: "text", text: "untangling a gnarly database migration plan" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard_fail", messageID: "msg_guard_fail" } as any, output);
    // The stale flag was cleared because this is not a compaction message.
    // Nudges should fire (prediction nudge from seeded matcher).
    expect(output.parts.length).toBe(2);
    expect(output.parts[1].synthetic).toBe(true);
    expect(output.parts[1].text).toContain("User decision model");
  });

  test("compaction summary message still suppresses nudges (has compaction part)", async () => {
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

describe("chat auto-registration (idle, prompt, startup)", () => {
  // The auto-register IIFE fetches the live title via client.session.get;
  // these tests vary only that title (and the settle beat for the
  // fire-and-forget IIFE), so a factory keeps each test's variable explicit.
  let arTitle = "New session - 2026-09-13T10:00:00Z";
  const toastCalls: any[] = [];
  const autoRegisterClient = () => ({
    session: {
      prompt: async () => {},
      promptAsync: async () => {},
      create: async () => ({ data: { id: "child_ar" } }),
      delete: async () => {},
      get: async () => ({ data: { title: arTitle } }),
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async (opts: any) => { toastCalls.push(opts); } },
  });
  // The IIFE is fire-and-forget; give the microtask queue a beat.
  const settle = () => new Promise((r) => setTimeout(r, 20));

  test("first idle registers a top-level session with a pool-slug name; a later idle converges the topic", async () => {
    const arHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-ar" } as any);

    // First idle: placeholder title -> registers with a pool-slug base and
    // no topic.
    await arHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_ar1", status: { type: "idle" } } } as any,
    });
    await settle();
    const arDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    const row1 = arDb.listChatSessions().find((r) => r.session_id === "ses_ar1");
    expect(row1).toBeDefined();
    expect(row1!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
    expect(row1!.topic).toBeNull();
    // First registration toasts; it must not say anything on later idles.
    const reg = toastCalls.find((t) => t.body.message.includes("registered in chat as"));
    expect(reg).toBeDefined();

    // The auto-titler lands a real title; the next idle must converge the
    // topic (and keep the name - names never re-slug).
    arTitle = "Fix the auth bug";
    await arHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_ar1", status: { type: "idle" } } } as any,
    });
    await settle();
    const row2 = arDb.listChatSessions().find((r) => r.session_id === "ses_ar1")!;
    expect(row2.name).toBe(row1!.name);
    expect(row2.topic).toBe("Fix the auth bug");

    // chat_unregister tombstones; the NEXT idle must not re-register.
    arDb.unregisterChatSession("ses_ar1");
    expect(arDb.hasChatLeaveTombstone("ses_ar1")).toBe(true);
    await arHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_ar1", status: { type: "idle" } } } as any,
    });
    await settle();
    expect(arDb.listChatSessions().find((r) => r.session_id === "ses_ar1")).toBeUndefined();
    expect(arDb.hasChatLeaveTombstone("ses_ar1")).toBe(true);
    arDb.close();

    arHooks.dispose?.();
  });

  test("osProcessArgs reads this process's real command line", () => {
    // The plugin loads in a worker thread whose argv is just the worker
    // script - the real CLI flags are only visible on the OS-level command
    // line for our own pid. With the real readers, the helper must return
    // that command line here (the bun test invocation), which carries no
    // session flag.
    const args = osProcessArgs();
    expect(args.length).toBeGreaterThan(0);
    expect(startupSessionIdFromArgv(args)).toBeNull();
  });

  test("osProcessArgs: /proc cmdline is NUL-split; ps is the fallback; failures yield []", () => {
    const noProc = () => {
      throw new Error("ENOENT");
    };
    // Linux: NUL-separated, trailing NUL dropped, ps never consulted.
    expect(
      osProcessArgs({ readFile: () => "opencode\0-s\0ses_linux\0", ps: () => { throw new Error("must not run"); } }),
    ).toEqual(["opencode", "-s", "ses_linux"]);
    // macOS: no /proc, ps output is whitespace-split.
    expect(osProcessArgs({ readFile: noProc, ps: () => ({ exitCode: 0, stdout: "  opencode -s ses_mac\n" }) }, 4242)).toEqual([
      "opencode", "-s", "ses_mac",
    ]);
    // ps failing (nonzero exit, or throwing when the binary is missing)
    // reads as "no command line", never as an exception at plugin init.
    expect(osProcessArgs({ readFile: noProc, ps: () => ({ exitCode: 1, stdout: "" }) })).toEqual([]);
    expect(osProcessArgs({ readFile: noProc, ps: () => { throw new Error("spawn failed"); } })).toEqual([]);
    // ps receives the pid it was asked about.
    let asked = -1;
    osProcessArgs({ readFile: noProc, ps: (pid) => { asked = pid; return { exitCode: 0, stdout: "" }; } }, 777);
    expect(asked).toBe(777);
  });

  test("startupSessionId prefers thread-local argv, then the OS command line", () => {
    // The real harness path: the worker's argv has no -s, the OS command
    // line does. Under test the thread argv is bun's, so the OS list wins.
    expect(startupSessionId(["opencode", "-s", "ses_from_os"])).toBe("ses_from_os");
    expect(startupSessionId([])).toBeNull();
    const argvSave = process.argv;
    process.argv = [...argvSave, "--session=ses_thread"];
    try {
      expect(startupSessionId(["opencode", "-s", "ses_from_os"])).toBe("ses_thread");
    } finally {
      process.argv = argvSave;
    }
  });

  test("continuesLastSessionFromArgv parses -c/--continue; continuesLastSessionId picks the newest top-level session", () => {
    expect(continuesLastSessionFromArgv(["opencode", "-c"])).toBe(true);
    expect(continuesLastSessionFromArgv(["opencode", "--continue"])).toBe(true);
    expect(continuesLastSessionFromArgv(["opencode", "--continue=true"])).toBe(true);
    expect(continuesLastSessionFromArgv(["opencode", "--continue=false"])).toBe(false);
    expect(continuesLastSessionFromArgv(["opencode"])).toBe(false);
    expect(continuesLastSessionFromArgv(["opencode", "-s", "ses_x"])).toBe(false);

    // Newest time.updated wins; children (parentID set) are never picked -
    // the TUI's own -c resolution skips them.
    const sessions = [
      { id: "ses_old_top", time: { updated: 100 } },
      { id: "ses_child", parentID: "ses_old_top", time: { updated: 300 } },
      { id: "ses_new_top", time: { updated: 200 } },
    ];
    expect(continuesLastSessionId(sessions)).toBe("ses_new_top");
    expect(continuesLastSessionId([])).toBeNull();
    expect(continuesLastSessionId([{ id: "s1", parentID: "p" }])).toBeNull();
  });

  test("chat.autoRegister: false suppresses auto-registration but not chat_register", async () => {
    arTitle = "Real Title Here";
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    saveConfig({ chat: { autoRegister: false } });
    try {
      const arHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-ar2" } as any);

      await arHooks.event!({ event: {
        type: "session.status",
        properties: { sessionID: "ses_ar2", status: { type: "idle" } } } as any,
      });
      await settle();
      const arDb2 = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(arDb2.listChatSessions().find((r) => r.session_id === "ses_ar2")).toBeUndefined();
      arDb2.close();

      arHooks.dispose?.();
    } finally {
      // The config file is shared across this suite's tests (one dbDir):
      // restore the default (no file) even on failure, so later tests
      // auto-register again.
      rmSync(configPath);
    }
  });

  test("-s resume reclaims the row, refreshes its heartbeat, delivers asleep-mail", async () => {
    // A session continued via `opencode -s <id>`: its row exists from a
    // PREVIOUS harness (heartbeat long lapsed) with mail that queued while
    // it was down. Startup registration must reclaim the row (same name -
    // names are owned by the session id), refresh its heartbeat, and wake
    // it with the asleep-mail at init.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_resume", "thatch-resume", "Continued session", "opencode");
    seedDb.registerChatSession("ses_rsnd", "thatch-resume", null, "opencode", "resender");
    seedDb.sendChatMessage("ses_rsnd", "ses_resume", "while you were asleep");
    seedDb.close();
    new Database(process.env.THATCH_DB_PATH!).run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_resume'");

    const promptAsyncs: any[] = [];
    const resumeClient = {
      ...autoRegisterClient(),
      session: {
        ...autoRegisterClient().session,
        get: async () => ({ data: { title: "Continued session" } }),
        promptAsync: async (args: any) => {
          promptAsyncs.push(args);
        },
      },
    };
    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_resume"];
    let resumeHooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      resumeHooks = await server({ client: resumeClient, worktree: "/tmp/thatch-resume" } as any);
      await settle();
      const row = new ThatchDB(process.env.THATCH_DB_PATH!).listChatSessions().find((r) => r.session_id === "ses_resume");
      expect(row).toBeDefined();
      // Same row, SAME NAME (owned by the session id), heartbeat fresh again.
      expect(row!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
      expect(Date.now() - Date.parse(row!.last_seen)).toBeLessThan(60_000);
      expect(row!.topic).toBe("Continued session");
      // The asleep-mail woke it at init.
      const wake = promptAsyncs.find((p) => p.path.id === "ses_resume");
      expect(wake).toBeDefined();
      expect(JSON.stringify(wake.body)).toContain("1 unread message from resender-00001");
      const stamp = new Database(process.env.THATCH_DB_PATH!)
        .query("SELECT delivered_at FROM chat_messages WHERE to_session = 'ses_resume'")
        .get() as any;
      expect(stamp?.delivered_at).not.toBeNull();
      // The reclaim announcement waits for the first prompt - the TUI is
      // not connected at init, so an immediate toast would drop silently.
      expect(toastCalls.some((t) => t.body.message.includes("rejoined chat as"))).toBe(false);
      await resumeHooks["chat.message"]!({ sessionID: "ses_resume", messageID: "msg_resume" } as any, promptOutput("msg_resume"));
      const rejoin = toastCalls.find((t) => t.body.message.includes("rejoined chat as"));
      expect(rejoin).toBeDefined();
      expect(rejoin!.body.message).toContain(row!.name);
    } finally {
      process.argv = argvSave;
      resumeHooks?.dispose?.();
    }
  });

  test("-s startup registration honors chat.autoRegister: false", async () => {
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    saveConfig({ chat: { autoRegister: false } });
    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_noauto"];
    let hooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      hooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-noauto" } as any);
      await settle();
      const db = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(db.listChatSessions().find((r) => r.session_id === "ses_noauto")).toBeUndefined();
      db.close();
    } finally {
      process.argv = argvSave;
      hooks?.dispose?.();
      rmSync(configPath);
    }
  });

  test("-s startup registration honors a leave tombstone", async () => {
    // The session left explicitly (chat_unregister or TUI delete) in a
    // previous harness; resuming it must not drag it back into the
    // directory. Only an explicit chat_register clears the tombstone.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_left", "thatch-left", null, "opencode", "leaver");
    seedDb.unregisterChatSession("ses_left");
    expect(seedDb.hasChatLeaveTombstone("ses_left")).toBe(true);
    seedDb.close();
    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_left"];
    let hooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      hooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-left" } as any);
      await settle();
      const db = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(db.listChatSessions().find((r) => r.session_id === "ses_left")).toBeUndefined();
      expect(db.hasChatLeaveTombstone("ses_left")).toBe(true);
      db.close();
    } finally {
      process.argv = argvSave;
      hooks?.dispose?.();
    }
  });

  test("-c resume reclaims the most recent top-level session at startup", async () => {
    // `opencode -c` continues the most recent top-level session in this
    // directory. The plugin resolves the same target through the SDK at
    // init, so the row's heartbeat is fresh and the poller hosts it before
    // the user's first prompt - the roster shows it Active immediately.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_cont", "thatch-continue", "Continued last", "opencode");
    seedDb.close();
    new Database(process.env.THATCH_DB_PATH!).run(
      "UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_cont'",
    );

    const contClient = {
      ...autoRegisterClient(),
      session: {
        ...autoRegisterClient().session,
        // Directory-scoped list; the child is newer but must never be
        // picked (children are not top-level sessions).
        list: async () => ({
          data: [
            { id: "ses_cont_child", parentID: "ses_cont", time: { updated: 300 } },
            { id: "ses_cont", time: { updated: 200 } },
          ],
        }),
        get: async () => ({ data: { title: "Continued last" } }),
      },
    };
    const argvSave = process.argv;
    process.argv = [...argvSave, "-c"];
    let contHooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      contHooks = await server({ client: contClient, worktree: "/tmp/thatch-cont" } as any);
      await settle();
      const row = new ThatchDB(process.env.THATCH_DB_PATH!)
        .listChatSessions()
        .find((r) => r.session_id === "ses_cont");
      expect(row).toBeDefined();
      // Same row, same never-reused name shape, heartbeat fresh again,
      // topic converged from the title fetch.
      expect(row!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
      expect(Date.now() - Date.parse(row!.last_seen)).toBeLessThan(60_000);
      expect(row!.topic).toBe("Continued last");
      // The child session must not have been registered instead.
      const childRow = new ThatchDB(process.env.THATCH_DB_PATH!)
        .listChatSessions()
        .find((r) => r.session_id === "ses_cont_child");
      expect(childRow).toBeUndefined();
    } finally {
      process.argv = argvSave;
      contHooks?.dispose?.();
    }
  });

  test("-c startup registration honors a leave tombstone and chat.autoRegister: false", async () => {
    // Tombstone case: seed a left session; -c resolves it but must not
    // re-register it. The client's list mock resolves it as the continue
    // target, so the tombstone (not a missing list) is what blocks.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_cont_left", "thatch-continue", null, "opencode", "leaver");
    seedDb.unregisterChatSession("ses_cont_left");
    seedDb.close();

    const contLeftClient = {
      ...autoRegisterClient(),
      session: {
        ...autoRegisterClient().session,
        list: async () => ({ data: [{ id: "ses_cont_left", time: { updated: 1 } }] }),
      },
    };
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    const argvSave = process.argv;
    let hooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      process.argv = [...argvSave, "-c"];
      hooks = await server({ client: contLeftClient, worktree: "/tmp/thatch-cont-left" } as any);
      await settle();
      const db = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(db.listChatSessions().find((r) => r.session_id === "ses_cont_left")).toBeUndefined();
      expect(db.hasChatLeaveTombstone("ses_cont_left")).toBe(true);
      db.close();
      hooks.dispose?.();
      hooks = undefined;

      // autoRegister: false case: a -c restart must not register either.
      saveConfig({ chat: { autoRegister: false } });
      hooks = await server({ client: contLeftClient, worktree: "/tmp/thatch-cont-noauto" } as any);
      await settle();
      const db2 = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(db2.listChatSessions().find((r) => r.session_id === "ses_cont_left")).toBeUndefined();
      db2.close();
    } finally {
      process.argv = argvSave;
      hooks?.dispose?.();
      rmSync(configPath);
    }
  });

  // Reuses the client factory and toast sink (above): the prompt path
  // registers with the same pool-name model and the same quiet toast.
  const promptOutput = (id: string, text = "hello, what is your chat name?"): any => ({
    message: { id },
    parts: [{ type: "text", text }],
  });

  test("chat.message registers an unregistered top-level session before the model runs", async () => {
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr" } as any);
    try {
      const regToastsBefore = toastCalls.filter((t) => t.body.message.includes("registered in chat as")).length;
      await prHooks["chat.message"]!({ sessionID: "ses_pr1", messageID: "msg_pr1" } as any, promptOutput("msg_pr1"));
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      const row = prDb.listChatSessions().find((r) => r.session_id === "ses_pr1");
      expect(row).toBeDefined();
      expect(row!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
      // Placeholder title at prompt time - the topic converges on idle.
      expect(row!.topic).toBeNull();

      // Second prompt: touch, not a second registration - one toast total.
      await prHooks["chat.message"]!({ sessionID: "ses_pr1", messageID: "msg_pr2" } as any, promptOutput("msg_pr2", "second prompt"));
      const regToasts = toastCalls.filter((t) => t.body.message.includes("registered in chat as"));
      expect(regToasts.length).toBe(regToastsBefore + 1);
      prDb.close();
    } finally {
      prHooks.dispose?.();
    }
  });

  test("chat.message does not register a sub-agent child session", async () => {
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr-child" } as any);
    try {
      await prHooks.event!({ event: {
        type: "session.created",
        properties: { info: { id: "ses_pr_child", parentID: "ses_pr_parent" } } } as any,
      });
      await prHooks["chat.message"]!({ sessionID: "ses_pr_child", messageID: "msg_child" } as any, promptOutput("msg_child", "child prompt"));
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_pr_child")).toBeUndefined();
      prDb.close();
    } finally {
      prHooks.dispose?.();
    }
  });

  test("chat.message honors a leave tombstone", async () => {
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr-left" } as any);
    try {
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      prDb.registerChatSession("ses_pr_left", "thatch-pr", null, "opencode", "leaver");
      prDb.unregisterChatSession("ses_pr_left");
      await prHooks["chat.message"]!({ sessionID: "ses_pr_left", messageID: "msg_left" } as any, promptOutput("msg_left"));
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_pr_left")).toBeUndefined();
      expect(prDb.hasChatLeaveTombstone("ses_pr_left")).toBe(true);
      prDb.close();
    } finally {
      prHooks.dispose?.();
    }
  });

  test("chat.message registration honors chat.autoRegister: false", async () => {
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    saveConfig({ chat: { autoRegister: false } });
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr-noauto" } as any);
    try {
      await prHooks["chat.message"]!({ sessionID: "ses_pr_noauto", messageID: "msg_noauto" } as any, promptOutput("msg_noauto"));
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_pr_noauto")).toBeUndefined();
      prDb.close();
    } finally {
      prHooks.dispose?.();
      rmSync(configPath);
    }
  });
});

describe("session.deleted tombstones auto-registration", () => {
  test("a deleted session's late auto-register IIFE cannot resurrect the row", async () => {
    // Register via a first idle, then delete the session in the TUI: the
    // session.deleted handler must tombstone, so a late/second idle event
    // cannot silently re-register a dead session.
    const dlClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_dl" } }),
        delete: async () => {},
        get: async () => ({ data: { title: "Doomed Session" } }),
        status: async () => ({ data: {} }),
      },
      tui: { showToast: async () => {} },
    };
    const dlHooks = await server({ client: dlClient, worktree: "/tmp/thatch-dl" } as any);

    await dlHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_dl1", status: { type: "idle" } } } as any,
    });
    await new Promise((r) => setTimeout(r, 20));
    const dlDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    expect(dlDb.listChatSessions().find((r) => r.session_id === "ses_dl1")).toBeDefined();

    // User deletes the session in the TUI.
    await dlHooks.event!({ event: {
      type: "session.deleted",
      properties: { info: { id: "ses_dl1" } } } as any,
    });
    expect(dlDb.listChatSessions().find((r) => r.session_id === "ses_dl1")).toBeUndefined();
    expect(dlDb.hasChatLeaveTombstone("ses_dl1")).toBe(true);

    // A straggler idle event (the in-flight IIFE's race window, or a late
    // duplicate) must not resurrect the row.
    await dlHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_dl1", status: { type: "idle" } } } as any,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(dlDb.listChatSessions().find((r) => r.session_id === "ses_dl1")).toBeUndefined();
    dlDb.close();
    dlHooks.dispose?.();
  });
});

describe("wrap-up commands (/thatch/compact, /thatch/exit)", () => {
  // Drives the full flow: the command marks the session, the model's
  // response lands as the last assistant message, and the idle event
  // resolves the pending wrap-up.
  const runWrapUp = async (command: string, sessionID: string, lastAssistantText: string) => {
    wrapUpMessages = [
      { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "do the thing" }] },
      {
        info: { id: "msg_u2", role: "assistant" },
        parts: [{ type: "text", text: lastAssistantText }],
      },
    ];
    await hooks["command.execute.before"]!({ command, sessionID, arguments: "" }, { parts: [] });
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID, status: { type: "idle" } } } as any,
    });
  };

  test("compact greenlight triggers the TUI compact action", async () => {
    const before = tuiExecuteCommandCalls.length;
    await runWrapUp("thatch/compact", "ses_wrapc", "All clear.\nTHATCH_COMPACT_READY");
    expect(tuiExecuteCommandCalls.slice(before)).toEqual([
      { body: { command: "session_compact" } },
    ]);
    expect(tuiPublishCalls).toHaveLength(0);
  });

  test("exit greenlight publishes the app.exit TUI command", async () => {
    const before = tuiPublishCalls.length;
    await runWrapUp("thatch/exit", "ses_wrape", "Nothing pending.\nTHATCH_EXIT_READY");
    expect(tuiPublishCalls.slice(before)).toEqual([
      { body: { type: "tui.command.execute", properties: { command: "app.exit" } } },
    ]);
    expect(tuiExecuteCommandCalls).toHaveLength(1); // only the compact test's
  });

  test("missing token blocks with a warning toast and triggers nothing", async () => {
    const before = { cmd: tuiExecuteCommandCalls.length, pub: tuiPublishCalls.length, toast: tuiToastCalls.length };
    await runWrapUp("thatch/compact", "ses_wrapb", "Outstanding: fix the failing test first.");
    expect(tuiExecuteCommandCalls.length).toBe(before.cmd);
    expect(tuiPublishCalls.length).toBe(before.pub);
    expect(tuiToastCalls.length).toBe(before.toast + 1);
    expect(tuiToastCalls[tuiToastCalls.length - 1].body.variant).toBe("warning");
    expect(tuiToastCalls[tuiToastCalls.length - 1].body.message).toContain("/thatch/compact");
  });

  test("token must be trailing - mid-text mentions do not greenlight", async () => {
    const before = tuiExecuteCommandCalls.length;
    await runWrapUp(
      "thatch/compact",
      "ses_wrapm",
      "As instructed, the token is THATCH_COMPACT_READY. But one todo is still open, so I have not appended it as my last line.",
    );
    expect(tuiExecuteCommandCalls.length).toBe(before);
  });

  test("message fetch failure blocks instead of triggering", async () => {
    wrapUpMessages = []; // empty: no assistant message -> no token -> blocked
    await hooks["command.execute.before"]!(
      { command: "thatch/exit", sessionID: "ses_wrapf", arguments: "" },
      { parts: [] },
    );
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_wrapf", status: { type: "idle" } } } as any,
    });
    expect(tuiPublishCalls).toHaveLength(1); // still only the exit test's
  });

  test("unknown commands do not arm the wrap-up check", async () => {
    const before = tuiExecuteCommandCalls.length;
    await runWrapUp("some-other-command", "ses_wrapu", "done\nTHATCH_COMPACT_READY");
    expect(tuiExecuteCommandCalls.length).toBe(before);
  });

  test("exit greenlight unregisters the session from the chat directory", async () => {
    const before = new ThatchDB(process.env.THATCH_DB_PATH!);
    before.registerChatSession("ses_wrapeu", "p", null, "opencode", "gammawrap");
    before.close();
    await runWrapUp("thatch/exit", "ses_wrapeu", "All clear.\nTHATCH_EXIT_READY");
    const after = new ThatchDB(process.env.THATCH_DB_PATH!);
    expect(after.listChatSessions().find((r) => r.session_id === "ses_wrapeu")).toBeUndefined();
    after.close();
  });

  test("compact greenlight does not unregister the session", async () => {
    const before = new ThatchDB(process.env.THATCH_DB_PATH!);
    before.registerChatSession("ses_wrapnu", "p", null, "opencode", "deltawrap");
    before.close();
    await runWrapUp("thatch/compact", "ses_wrapnu", "All clear.\nTHATCH_COMPACT_READY");
    const after = new ThatchDB(process.env.THATCH_DB_PATH!);
    // Compaction continues the session, so the directory row must survive.
    expect(after.listChatSessions().find((r) => r.session_id === "ses_wrapnu")).toBeDefined();
    after.close();
  });

  test("session.deleted clears a pending wrap-up", async () => {
    const before = tuiExecuteCommandCalls.length;
    await hooks["command.execute.before"]!(
      { command: "thatch/compact", sessionID: "ses_wrapd", arguments: "" },
      { parts: [] },
    );
    wrapUpMessages = [
      { info: { id: "msg_ud", role: "assistant" }, parts: [{ type: "text", text: "THATCH_COMPACT_READY" }] },
    ];
    await hooks.event!({ event: {
      type: "session.deleted",
      properties: { info: { id: "ses_wrapd" } } } as any,
    });
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_wrapd", status: { type: "idle" } } } as any,
    });
    // The cleared wrap-up must not have fired a compact trigger of its own.
    expect(tuiExecuteCommandCalls.length).toBe(before);
  });
});

describe("installOpencodeCommands", () => {
  test("writes the wrap-up and action command files and is idempotent", async () => {
    const { installOpencodeCommands } = await import("../src/commands");
    const home = mkdtempSync(join(tmpdir(), "thatch-cmds-"));
    try {
      const first = installOpencodeCommands(home);
      const names = first.map((p) => p.split("/").pop()!.replace(/\.md$/, "")).sort();
      expect(names).toEqual(["compact", "defrag", "exit", "extract", "hygiene", "reflect"]);
      const compact = readFileSync(join(first[0]!), "utf8");
      expect(compact).toContain("description:");
      expect(compact).toContain("THATCH_COMPACT_READY");
      // Re-run: everything current, nothing rewritten.
      expect(installOpencodeCommands(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rewrites when on-disk content diverges (template update self-heal)", async () => {
    const { installOpencodeCommands } = await import("../src/commands");
    const home = mkdtempSync(join(tmpdir(), "thatch-cmds2-"));
    try {
      const dir = join(home, "opencode", "command", "thatch");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "compact.md"), "stale content");
      const written = installOpencodeCommands(home);
      // compact.md was stale (rewritten); everything else was missing (created).
      expect(written).toContain(join(dir, "compact.md"));
      expect(written).toContain(join(dir, "defrag.md"));
      expect(readFileSync(join(dir, "compact.md"), "utf8")).toContain("THATCH_COMPACT_READY");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wrap-up command bodies label the sections: user text first, then the checklist", async () => {
    // opencode replaces $ARGUMENTS with the text typed after the command
    // (/thatch/exit thanks! -> "thanks!" in the User Message section), and
    // with no argument the section renders empty. The header labels are
    // load-bearing: without them the user's text dangles after the
    // checklist and reads like a sign-off addressed at the instructions.
    const { opencodeCommandDefs } = await import("../src/commands");
    const wrapUps = opencodeCommandDefs().filter((d) => d.name === "compact" || d.name === "exit");
    for (const def of wrapUps) {
      const body = def.content.slice(def.content.indexOf("---", 3) + 3);
      expect(body.trimStart()).toMatch(/^# User Message\n\n\$ARGUMENTS\n\n\(That section carries/);
      expect(body).toContain(`# Pre-${def.name === "compact" ? "compact" : "exit"} wrap-up`);
      expect(body).toContain("treat the user message as n/a");
    }
    const exit = opencodeCommandDefs().find((d) => d.name === "exit")!;
    expect(exit.content).toContain("chat_unregister");
  });
});

describe("action commands", () => {
  test("each action file carries its core body and the user message section", async () => {
    const { opencodeCommandDefs, actionDefs } = await import("../src/commands");
    const defs = opencodeCommandDefs().filter((d) => !["compact", "exit"].includes(d.name));
    const actions = actionDefs((n) => `thatch_${n}`);
    expect(defs.map((d) => d.name)).toEqual(actions.map((a) => a.name));
    for (const def of defs) {
      expect(def.content).toContain("description:");
      expect(def.content).toContain("$ARGUMENTS");
      // The core body must survive rendering verbatim, so a wording change
      // in prompts.ts cannot silently miss the command file.
      const action = actions.find((a) => a.name === def.name)!;
      expect(def.content).toContain(action.body);
    }
  });

  test("extract action fetches by explicit session id learned from get_session_info", async () => {
    const { opencodeCommandDefs } = await import("../src/commands");
    const extract = opencodeCommandDefs().find((d) => d.name === "extract")!;
    expect(extract.content).toContain("thatch_get_session_info");
    expect(extract.content).toContain('session_id \\"SESSION_ID\\"');
    expect(extract.content).toContain("thatch_extraction_done");
  });

  test("Claude Code command set drops wrap-ups and the opencode-only extract action", async () => {
    const { claudeCommandDefs } = await import("../src/commands");
    const names = claudeCommandDefs().map((d) => d.name).sort();
    expect(names).toEqual(["defrag", "hygiene", "reflect"]);
    for (const def of claudeCommandDefs()) {
      // Tool spelling follows the host. Hygiene drives the thatch CLI and
      // names no memory tools, so it is exempt from the MCP spelling check.
      if (def.name !== "hygiene") {
        expect(def.content).toMatch(/mcp__thatch__/);
        expect(def.content).not.toContain("thatch_find_duplicates");
      }
    }
  });

  test("installClaudeCommands writes under commands/thatch and is idempotent", async () => {
    const { installClaudeCommands } = await import("../src/commands");
    const claudeDir = mkdtempSync(join(tmpdir(), "thatch-claude-cmds-"));
    try {
      const first = installClaudeCommands(claudeDir);
      expect(first).toHaveLength(3);
      expect(first[0]).toContain(join("commands", "thatch"));
      expect(installClaudeCommands(claudeDir)).toEqual([]);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test("host command sets are the same actions minus documented exclusions", async () => {
    const { opencodeCommandDefs, claudeCommandDefs } = await import("../src/commands");
    const { compilePrompts } = await import("../src/mcp");
    const opencodeNames = opencodeCommandDefs().map((d) => d.name).sort();
    const claudeNames = claudeCommandDefs().map((d) => d.name).sort();
    const promptNames = [...compilePrompts().keys()].sort();
    // Claude Code gets the shared actions only; opencode adds the wrap-ups
    // (needs plugin arming) and extract (needs session identity).
    expect(opencodeNames.sort()).toEqual([...claudeNames, "compact", "exit", "extract"].sort());
    // MCP prompts match Claude Code's set: same shared actions, same bodies.
    expect(promptNames).toEqual(claudeNames);
  });
});
