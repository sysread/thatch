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

  test("buffered interactions never surface as chat.message nudges (extraction is plugin-driven)", async () => {
    // There is deliberately NO model-facing extraction nudge on opencode:
    // the model-driven handshake raced its own state machine (the September
    // 2026 dispatch-loop report). Buffered interactions are extracted by the
    // plugin's own child session at idle; chat.message must stay clean.
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

    // A real user message with the same pending buffer: still no nudge.
    const realOutput: any = {
      message: { id: "msg_real" },
      parts: [{ type: "text", text: "hello there friend" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_echo_skip", messageID: "msg_real" } as any, realOutput);
    expect(realOutput.parts.length).toBe(1);

    // The buffer was not dropped - the payload provider still serves it.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_echo_skip" },
      { sessionID: "ses_extractor" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("README.md");
  });

  test("synthetic-only prompts and real messages both skip the (removed) extraction nudge", async () => {
    // A background-task completion is delivered as a prompt whose parts are
    // all synthetic. The synthetic-skip guard survives for the recall
    // nudge; extraction no longer nudges at all, so either way no extraction
    // text may appear.
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

    const real: any = {
      message: { id: "msg_real" },
      parts: [{ type: "text", text: "what is next?" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_synth", messageID: "msg_real" } as any, real);
    expect(real.parts.length).toBe(1);
    expect(real.parts[0].text).not.toContain("thatch-fact-extractor");

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

  test("buffered tool interactions are served by the payload provider, scoped per session", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_a", callID: "c1", args: { command: "ls" } },
      { title: "list files", output: "README.md", metadata: {} },
    );

    // A different session sees nothing.
    const other = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_b" },
      { sessionID: "ses_b" },
    );
    expect(typeof other === "string" ? other : JSON.stringify(other)).not.toContain("README.md");

    // The originating session's buffer is served - session ID in the
    // payload context, interactions inside, no nudge was ever injected.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_a" },
      { sessionID: "ses_ext_a" },
    );
    const text = typeof served === "string" ? served : JSON.stringify(served);
    expect(text).toContain("README.md");
    expect(text).toContain("projectStore");

    // The buffer is NOT drained by the fetch alone - the fetch records a
    // CLAIM for the fetcher, and a second fetcher still sees the entries
    // until that fetcher's completion signal arrives.
    const served2 = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_a" },
      { sessionID: "ses_ext_b" },
    );
    expect(typeof served2 === "string" ? served2 : JSON.stringify(served2)).toContain("README.md");

    // The extractor (ses_ext_a) completes with the parent's session id:
    // its claimed delivery is consumed.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_ext_a", callID: "c1c", args: { session_id: "ses_a" } },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_a" },
      { sessionID: "ses_ext_c" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("README.md");
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

  test("skill, task, and subagent meta-tools are not buffered (feedback loop prevention)", async () => {    await hooks["tool.execute.after"]!(
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

  test("DEFECT 1: a no-claim child ack does not drop the accepted set", async () => {
    // The accept-before-fetch interaction loss: a child extraction_done
    // that arrives BEFORE the child fetched (or mis-targeted) had no
    // claim, and the old whole-set fallback completed the parent's ENTIRE
    // accepted queue - wiping the delivery the real extractor was about to
    // claim, silently, every round. A no-claim ack proves nothing was
    // processed, so it must be a no-op: entries stay held for the real
    // extractor, and requeueStaleAccepted bounds any orphan linger.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_p", callID: "p1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    // Parent acks (accept): entries move to the holding area.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_p", callID: "p2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    // A child acks WITHOUT fetching first (payload call errored, or a
    // mis-ordered run). No claim exists for it.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_ext_early", callID: "e0", args: { session_id: "ses_p" } },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );

    // The accepted set SURVIVES the no-claim ack - the real extractor can
    // still claim and process it.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_p" },
      { sessionID: "ses_ext" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");

    // The real extractor finishes and acks with the parent's session id:
    // ITS claimed delivery completes (the fetch above recorded the claim).
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_ext", callID: "e1", args: { session_id: "ses_p" } },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_p" },
      { sessionID: "ses_other" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("file.txt");
  });

  test("task child memory write does not drain the parent's buffer", async () => {
    // A task-dispatched sub-agent saving its OWN findings is not evidence
    // that the parent's buffer was extracted: the child never fetched a
    // payload. The old whole-child drain silently dropped the parent's
    // pre-dispatch entries without extraction once v2 linked all children
    // to their parents - the drain is now extraction-child only.
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

    // Step 3: Child session writes a memory (as a sub-agent would)
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_child_fixa", callID: "fa1", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    // Parent's pre-dispatch entries SURVIVE the task child's memory write -
    // the payload provider still serves them for extraction.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_parent_fixa" },
      { sessionID: "ses_ext_fixa" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");
  });

  test("task child memory write preserves interleaved entries too", async () => {
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

    // Sub-agent writes a memory — a task-kind child drains NOTHING: the
    // pre-dispatch AND interleaved entries both survive.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_child_interleave", callID: "iv2", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    // The parent's entries (both pre-dispatch and interleaved) are still
    // served for extraction.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_parent_interleave" },
      { sessionID: "ses_ext_iv" },
    );
    const text = typeof served === "string" ? served : JSON.stringify(served);
    expect(text).toContain("clean");
    expect(text).toContain("history");
  });

  test("parent ack holds entries; a claim-less child idle leaves them held (no wipe)", async () => {
    // The parent-accept role: entries move to the holding area (no model-
    // facing nudge exists to quiet any more, but the accept is harmless),
    // and NOTHING drops them until a fetcher's claim is completed - not
    // even the child's idle signal.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_fixc", callID: "fc1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );

    // Parent accepts the buffer after dispatching the extractor
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_fixc", callID: "fc2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );

    // Extractor (child session) finishes without fetching or saving and
    // goes idle - a no-claim idle is a no-op, never a wipe.
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_child_fixc", parentID: "ses_fixc" } } } as any,
    });
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_child_fixc", status: { type: "idle" } } } as any,
    });

    // The held entries are still served - requeueStaleAccepted will return
    // them to pending for re-extraction; nothing was lost.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_fixc" },
      { sessionID: "ses_ext_fixc" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");
  });

  test("accept/requeue: child session error returns entries to pending (re-extractable)", async () => {
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

    // The requeued entries are still served — facts are not lost
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_requeue" },
      { sessionID: "ses_ext_rq" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");
  });

  test("accept/requeue: task child deleted before completing leaves entries held", async () => {
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

    // A task-kind child is deleted ROUTINELY (after finishing, or by the
    // harness). Its deletion must not requeue the parent's accepted set -
    // that would yank an in-flight extractor's claim back to pending. The
    // claim-less task child holds nothing; requeueStaleAccepted bounds any
    // orphan linger. Either way the entries are served, never dropped.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_delq" },
      { sessionID: "ses_ext_dq" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");
  });

  test("accept/complete: child fetch + extraction_done completes the parent's accepted entries", async () => {
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

    // The child fetches its payload (recording the claim)...
    await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_ack" },
      { sessionID: "ses_child_ack" },
    );
    // ...and finishes a no-save run by calling extraction_done itself
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_child_ack", callID: "ak3", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );

    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_ack" },
      { sessionID: "ses_ext_ak" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("file.txt");
  });

  test("accept/complete: child fetch + memory write completes accepted entries", async () => {
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
    // The child fetches its payload (recording the claim), then proves it
    // processed the delivery by writing a memory - the write completes the
    // claim.
    await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_mwc" },
      { sessionID: "ses_child_mwc" },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_child_mwc", callID: "mw3", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_mwc" },
      { sessionID: "ses_ext_mwc" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("file.txt");
  });

  // -----------------------------------------------------------------------
  // Journal reconcile - the watch tools self-heal after a registry rebuild
  // -----------------------------------------------------------------------

  test("watch_list and watch_cancel self-heal from the journal after a registry rebuild", async () => {
    // Simulate a watcher journaled by a previous runtime instance that a
    // session_move or plugin reload orphaned: the journal row exists (same
    // pid), but the live registry the tools query is empty. Before the
    // reconcile, watch_list said "No active watchers" and watch_cancel "No
    // watcher in this session" while the orphaned poller kept delivering.
    const watcher = {
      id: "watch_selfheal",
      source: "branch" as const,
      sessionID: "ses_selfheal",
      repo: "acme/widgets",
      branch: "main",
      events: ["branch_commit"],
      workflows: [],
      once: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60_000,
      state: { headSha: "aaaa1111aaaa1111", checkRuns: {}, workflowRuns: {} },
    };
    const jdb = new ThatchDB(process.env.THATCH_DB_PATH!);
    jdb.runtimeStatePut("watchers", "ses_selfheal", [watcher], "/tmp/thatch-test-worktree");

    // watch_list self-heals: the journaled watcher is hydrated and listed.
    const listed = await (hooks as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_selfheal" });
    expect(listed).toContain("watch_selfheal");
    expect(listed).toContain("acme/widgets@main");

    // watch_cancel self-heals too: the rehydrated watcher is cancelable.
    const cancelled = await (hooks as any).tool.thatch_watch_cancel.execute(
      { id: "watch_selfheal" }, { sessionID: "ses_selfheal" },
    );
    expect(cancelled).toContain("[cancelled] watch_selfheal");

    // Cancel re-journals the empty list - the row is gone, the entry does
    // not resurrect on the next call.
    const listed2 = await (hooks as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_selfheal" });
    expect(listed2).toBe("No active watchers.");
  });

  test("reconcile leaves cross-process (dormant) journal rows to the runtime scan", async () => {
    // A row journaled by a DEAD process (a real restart's leftover) must
    // NOT be hydrated by the tool path: its baseline needs the revalidation
    // that only scanDormantWatchers performs.
    const watcher = {
      id: "watch_dormant",
      source: "branch" as const,
      sessionID: "ses_dormant",
      repo: "acme/widgets",
      branch: "main",
      events: ["branch_commit"],
      workflows: [],
      once: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60_000,
      state: { headSha: "bbbb2222bbbb2222", checkRuns: {}, workflowRuns: {} },
    };
    const foreignPid = process.pid + 12345;
    const jdb = new ThatchDB(process.env.THATCH_DB_PATH!);
    // A directory that does NOT match the runtime's own: a dead-pid row
    // whose directory matches would fire a watcher-death notice into the
    // next chat.message in this file (test isolation). Delete the row at
    // the end regardless.
    jdb.runtimeStatePut("watchers", "ses_dormant", [watcher], "/tmp/not-the-runtime-dir", foreignPid);

    const listed = await (hooks as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_dormant" });
    expect(listed).toBe("No active watchers.");
    jdb.runtimeStateDelete("watchers", "ses_dormant");
  });

  test("reconcile does not clobber a live watcher with stale journal rows", async () => {
    // A command watcher: its baseline (`false`, exit 1) is not yet met, so
    // the create registers it. (Command watchers need no gh; branch
    // watchers would fetch a baseline over the network.) The command runs
    // with cwd = the harness's worktree, which nothing else creates.
    mkdirSync("/tmp/thatch-test-worktree", { recursive: true });
    const created = await (hooks as any).tool.thatch_watch_command_create.execute(
      { command: "false" }, { sessionID: "ses_live" },
    );
    expect(created).toContain("[watching]");
    const stale = {
      id: "watch_stale",
      source: "branch" as const,
      sessionID: "ses_live",
      repo: "acme/other",
      branch: "main",
      events: ["branch_commit"],
      workflows: [],
      once: false,
      createdAt: Date.now() - 1000,
      expiresAt: Date.now() + 60 * 60_000,
      state: { headSha: "cccc3333cccc3333", checkRuns: {}, workflowRuns: {} },
    };
    const jdb = new ThatchDB(process.env.THATCH_DB_PATH!);
    jdb.runtimeStatePut("watchers", "ses_live", [stale], "/tmp/thatch-test-worktree");

    const listed = await (hooks as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_live" });
    // The LIVE watcher survives the reconcile (hydrate never clobbers), and
    // the journaled stale definition legitimately rehydrates alongside it -
    // the journal is reconciled INTO the registry, never over it.
    expect(listed).toContain("cmd:");
    expect(listed).toContain("watch_stale");
    // Tidy up: the seeded row must not leak into later tests (this file
    // shares one db across tests).
    jdb.runtimeStateDelete("watchers", "ses_live");
  });

  test("sibling sub-agent going idle does not drop the extractor's claimed payload", async () => {
    // THE RACE, pinned: parent acks (accept) immediately after dispatching
    // the extractor, per the nudge's own instruction. A sibling
    // task-dispatched sub-agent (a code-review specialist) goes idle while
    // the extractor is still working. Before claim scoping, the sibling's
    // idle signal dropped the WHOLE accepted set and the extractor's
    // payload fetch came back empty - silent loss, and the nudge loop
    // Jeff saw for a week.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_race", callID: "rc1", args: { command: "git log" } },
      { title: "log", output: "abc123 the real interaction", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_race", callID: "rc2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_specialist", parentID: "ses_race" } } } as any,
    });
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_specialist", status: { type: "idle" } } } as any,
    });

    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_race" },
      { sessionID: "ses_extractor" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("abc123");
  });

  test("completion consumes only the completing child's claimed delivery", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_two", callID: "t1", args: { command: "cmd A" } },
      { title: "A", output: "interaction A", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_two", callID: "t2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_ext1", parentID: "ses_two" } } } as any,
    });
    // Fetch through the TOOL (not the after-hook): the execute path records
    // the fetcher's claim - the delivery record completion consumes.
    await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_two" },
      { sessionID: "ses_ext1" },
    );

    // New exhaust accumulates while extractor 1 works; extractor 2 fetches
    // and its claim covers the delivered set.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_two", callID: "t4", args: { command: "cmd B" } },
      { title: "B", output: "interaction B", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_ext2", parentID: "ses_two" } } } as any,
    });
    await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_two" },
      { sessionID: "ses_ext2" },
    );

    // Extractor 1 finishes: only ITS delivery (interaction A) completes.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_ext1", callID: "t6", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );

    // Interaction B survives extractor 1's completion.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_two" },
      { sessionID: "ses_ext3" },
    );
    const text = typeof served === "string" ? served : JSON.stringify(served);
    expect(text).toContain("interaction B");
    expect(text).not.toContain("interaction A");
  });

  test("DEFECT 2 shape: a parent ack mis-targeting its child's id is harmless, extraction still completes", async () => {
    // The frozen-count loop: the parent, told to ack, passed the CHILD's id
    // as session_id. Old code took the target branch (completeAccepted on a
    // session with nothing accepted - no-op) and never accepted the
    // parent's own buffer, so pending never drained and the same count
    // re-fired forever. Now the pipeline does not depend on the parent's
    // ack at all: the child's fetch + completion drains the parent.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_mistarget", callID: "mt1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_mistarget_child", parentID: "ses_mistarget" } } } as any,
    });
    // Parent acks with the CHILD's id (the mis-target). Must not drop or
    // strand anything.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_mistarget", callID: "mt2", args: { session_id: "ses_mistarget_child" } },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    // The child fetches with no id (auto-resolves to the parent) and
    // completes with no id.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      {},
      { sessionID: "ses_mistarget_child" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_mistarget_child", callID: "mt3", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_mistarget" },
      { sessionID: "ses_mistarget_other" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("file.txt");
  });

  test("an extraction child's fetch resolves to its parent's queue automatically", async () => {
    // The model should never need to copy a session ID. The plugin always
    // knows the CALLING session's id (every tool call carries it); the
    // parent link for plugin-created extraction children is in
    // childToParent - so an omitted (or self-named) session_id from a
    // linked child retargets to the parent's buffer. This is the safety
    // net for a child that mis-parrots the ID from its dispatch prompt;
    // the prompt still carries the explicit ID.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_autoparent", callID: "ap1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_autoparent_child", parentID: "ses_autoparent" } } } as any,
    });

    // Child fetches with NO session_id: resolves to its own session, which
    // the provider retargets to the parent via childToParent.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      {},
      { sessionID: "ses_autoparent_child" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");

    // Same with the child's OWN id passed explicitly (mis-parrot shape).
    const served2 = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_autoparent_child" },
      { sessionID: "ses_autoparent_child" },
    );
    expect(typeof served2 === "string" ? served2 : JSON.stringify(served2)).toContain("file.txt");

    // The child's no-arg extraction_done (parentID known via
    // childToParent) completes its claim - the parent's buffer drains.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_autoparent_child", callID: "ap2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_autoparent" },
      { sessionID: "ses_autoparent_other" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("file.txt");
  });

  test("wrap-up shape: parent-side fetch plus no-save extraction_done completes its own claim", async () => {
    // The /thatch/compact and /thatch/exit checklists have the PARENT
    // fetch its own payload, process inline, and ack. A no-save run writes
    // no memory, so the ack is the only completion signal for the parent's
    // self-claim. Before this branch completed claims, the entries sat
    // held for 15 minutes and were needlessly re-extracted.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_wrapup", callID: "w1", args: { command: "cmd W" } },
      { title: "W", output: "interaction W", metadata: {} },
    );
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      {},
      { sessionID: "ses_wrapup" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("interaction W");
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_wrapup", callID: "w2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      {},
      { sessionID: "ses_wrapup" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("interaction W");
  });

  test("parent-side direct fetch plus memory write completes its own claim", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_direct", callID: "d1", args: { command: "cmd C" } },
      { title: "C", output: "interaction C", metadata: {} },
    );
    // The parent fetches its own payload (no sub-agent) and then saves.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_direct" },
      { sessionID: "ses_direct" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("interaction C");
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_direct", callID: "d2", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_direct" },
      { sessionID: "ses_direct" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("interaction C");
  });

  // -----------------------------------------------------------------------
  // Direct extraction (opencode SDK path) - the ONLY opencode path
  // -----------------------------------------------------------------------
  //
  // When the parent session goes idle with pending tool interactions, the
  // plugin creates a child session and prompts it directly. There is no
  // model-facing extraction nudge on opencode: the model-driven handshake
  // (dispatch + ack + id-copying) raced its own state machine and was
  // removed. chat.message stays clean; the pipeline owns the lifecycle.

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

  test("direct extraction: extraction child deleted before completing requeues", async () => {
    // The no-loss contract for EXTRACTION-kind children: the child is
    // deleted before it fetches or acks. (Task-kind children are deleted
    // routinely and do NOT requeue - see the task-child deletion test
    // above; the kind gate is what separates the two.)
    const recClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_delx" } }),
        delete: async () => {},
      },
      tui: {
        showToast: async () => {},
      },
    };
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true";
    const testHooks = await server({ client: recClient, worktree: "/tmp/test" } as any);

    // Buffer a tool interaction, then let the parent go idle - the plugin
    // dispatches a direct-extraction child (kind=extraction).
    await testHooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_delx", callID: "dx1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_delx", status: { type: "idle" } } } as any,
    });

    // The extraction child is deleted before completing.
    await testHooks.event!({ event: {
      type: "session.deleted",
      properties: { info: { id: "child_delx" } } } as any,
    });

    // The entries return to pending: the NEXT idle re-triggers extraction
    // (there is no model-facing nudge fallback any more - the plugin owns
    // the retry).
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_delx", status: { type: "idle" } } } as any,
    });
    await new Promise((r) => setTimeout(r, 10));

    // The buffer was not dropped - the payload provider still serves it.
    const served = await (testHooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_delx" },
      { sessionID: "ses_ext_delx" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");

    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    testHooks.dispose?.();
  });

  test("direct extraction: chat.message stays clean while an extraction child runs", async () => {    const recClient = {
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

    // chat.message stays clean while a direct-extraction child runs (no
    // model-facing extraction nudge exists at all - see the section
    // comment). Short prompt falls through to recall, which produces
    // nothing here.
    const out: any = { message: { id: "msg_d2" }, parts: [{ type: "text", text: "ok" }] };
    await testHooks["chat.message"]!({ sessionID: "ses_direct2", messageID: "msg_d2" } as any, out);
    expect(out.parts.length).toBe(1); // only the original part
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

    // Child fetches its payload (the tool call records the claim), does a
    // no-save run, and acks - the claim completion consumes the delivered
    // entries.
    await (testHooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_direct3" },
      { sessionID: "child_direct3" },
    );
    await testHooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "child_direct3", callID: "d3c", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );

    // Child goes idle — should clean up and delete the child
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "child_direct3", status: { type: "idle" } } } as any,
    });

    expect(deleteCalled).toBe(true);
    expect(deleteArgs.path.id).toBe("child_direct3");

    // After cleanup, the extracting flag is cleared and the claimed entries
    // are consumed - the delivered entries were processed, so nothing is
    // left to extract. (A child that never fetches leaves them held: the
    // stale requeue returns them to pending, instead of the old idle-time
    // snapshot drain that silently dropped never-fetched entries.)
    const out: any = { message: { id: "msg_d3" }, parts: [{ type: "text", text: "hello world testing" }] };
    await testHooks["chat.message"]!({ sessionID: "ses_direct3", messageID: "msg_d3" } as any, out);
    expect(out.parts.length).toBe(1); // clean message, claim consumed on child ack

    testHooks.dispose?.();
  });

  test("direct extraction: child error clears extracting, next idle re-extracts", async () => {
    let promptRuns = 0;
    const recClient = {
      session: {
        prompt: async () => { promptRuns++; },
        promptAsync: async () => { promptRuns++; },
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

    // The entries are still pending (the erroring child never fetched).
    // There is no nudge fallback any more - the plugin itself retries on
    // the next idle.
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_direct4", status: { type: "idle" } } } as any,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(promptRuns).toBe(2);

    testHooks.dispose?.();
  });

  test("direct extraction: child memory write without a fetch does not consume the parent's buffer", async () => {
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

    // session.created fires for the child
    await testHooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "child_direct5", parentID: "ses_direct5" } } } as any,
    });

    // Child writes a memory WITHOUT fetching first - its write proves
    // nothing about the parent's buffer (no claim exists), so the parent's
    // pending entries survive untouched.
    await testHooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "child_direct5", callID: "d5b", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );

    // Parent's buffer is still served - no silent consumption.
    const served = await (testHooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_direct5" },
      { sessionID: "ses_ext_d5" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");

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

    // Child goes idle — must NOT drain the buffer (interleaved entries
    // should survive for the next extraction cycle)
    await testHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "child_interleave_fix", status: { type: "idle" } } } as any,
    });

    // The child never fetched, so nothing was claimed or consumed: ALL
    // five entries (3 pre-dispatch + 2 interleaved) are still served for
    // the next extraction cycle. Nothing was lost.
    const served = await (testHooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_interleave_fix" },
      { sessionID: "ses_ext_ivf" },
    );
    const text = typeof served === "string" ? served : JSON.stringify(served);
    for (let i = 0; i < 3; i++) expect(text).toContain(`out-${i}`);
    for (let i = 0; i < 2; i++) expect(text).toContain(`out2-${i}`);

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

    // Buffer should still have entries - the payload provider still serves
    // them (the task child's idle consumed nothing it never claimed).
    const served = await (testHooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_task_parent" },
      { sessionID: "ses_ext_tk" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");

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
    // The nudge teaches the argument shape: a bare positional string is the
    // most common first-call mistake (opencode DB analysis, Sept 2026).
    expect(nudge).toContain('({ query: "..." })');
    expect(nudge).toContain("never a bare positional string");
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

describe("formatWhenLine prefix deduplication", () => {
  const { formatWhenLine, predictionVerb } = require("../src/prompts");

  test("does not double a matcher that already starts with When", () => {
    const line = formatWhenLine(0.56, 1, "When reviewing a tiny config PR", "prefer the existing pattern", "you tend to");
    expect(line).toContain("] When reviewing a tiny config PR:");
    expect(line).not.toContain("When When");
  });

  test("prepends When to a gerund matcher", () => {
    const line = formatWhenLine(0.56, 1, "Deciding how to show activity feedback", "prefer toast notifications", "you tend to");
    expect(line).toContain("] When Deciding how to show activity feedback: you tend to prefer toast notifications");
  });

  test("does not double a statement that already carries the evidence verb", () => {
    const line = formatWhenLine(0.56, 1, "Deciding how to show activity feedback", "you tend to prefer toast notifications", predictionVerb(1));
    expect(line).toContain(": you tend to prefer toast notifications");
    expect(line).not.toContain("you tend to you tend to");
  });

  test("0-evidence statements keep the hedged verb", () => {
    const line = formatWhenLine(0.5, 0, "Deciding how to show activity feedback", "prefer toast notifications", predictionVerb(0));
    expect(line).toContain("you may prefer");
  });
});

describe("claudeRecallNudge (Claude Code / Cursor)", () => {
  test("uses bare tool name without thatch_ prefix", () => {
    const matches: NudgeMatch[] = [{ label: "Architecture", score: 0.72 }];
    const nudge = claudeRecallNudge(matches);
    expect(nudge).toContain("memory_recall");
    expect(nudge).not.toContain("thatch_memory_recall");
    expect(nudge).toContain('({ query: "..." })');
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

describe("extractionNudge escalation (MCP hosts only)", () => {
  const sessionID = "sess-abc";

  test("tier 0 (missedCount 0-1): leads with sub-agent dispatch wording", () => {
    const nudge = extractionNudge(3, 0, sessionID);
    expect(nudge).toContain("Spawn a background sub-agent");
    expect(nudge).not.toContain("background: true");
    expect(nudge).not.toContain("subagent_type");
    expect(nudge).toContain("mcp__thatch__extraction_done");
    expect(nudge).toContain("not user input");
    expect(nudge).toContain("continue waiting");
    expect(nudge).not.toContain("YOU HAVE NOT");
    expect(nudge).not.toContain("IGNORING");
  });

  test("tier 0 includes session ID and fetch tool name, not payload", () => {
    const nudge = extractionNudge(3, 0, sessionID);
    expect(nudge).toContain(sessionID);
    expect(nudge).toContain("mcp__thatch__get_extraction_payload");
    expect(nudge).not.toContain('"interactions"');
    expect(nudge).not.toContain('"projectStore"');
  });

  test("tier 1 (missedCount 2): directive prefix, no shouting", () => {
    const nudge = extractionNudge(3, 2, sessionID);
    expect(nudge).toContain("YOU HAVE NOT PROCESSED");
    expect(nudge).not.toContain("IGNORING");
  });

  test("tier 2 (missedCount 3+): all caps, harsh", () => {
    const nudge = extractionNudge(3, 3, sessionID);
    expect(nudge).toContain("IGNORING EXTRACTION INSTRUCTIONS");
    expect(nudge).toContain("INSTALLED THIS PLUGIN FOR A REASON");
  });

  test("tier 2 escalates further with higher counts", () => {
    const nudge = extractionNudge(5, 10, sessionID);
    expect(nudge).toContain("IGNORING");
  });

  test("all tiers include the session ID (case-insensitive for ALL-CAPS tier)", () => {
    for (const missed of [0, 2, 3]) {
      const nudge = extractionNudge(1, missed, sessionID);
      expect(nudge.toLowerCase()).toContain(sessionID.toLowerCase());
    }
  });

  test("no tier includes the raw JSON payload", () => {
    for (const missed of [0, 2, 3]) {
      const nudge = extractionNudge(1, missed, sessionID);
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

  test("task-dispatched sub-agent sessions get no recall nudge", async () => {
    // Task sub-agents (session.created with a parentID, not created by the
    // extraction pipeline) have restricted tool lists that exclude the
    // thatch tools - nudging them only produces "No tool named" error
    // rounds (opencode DB analysis, Sept 2026).
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_subagent_recall", parentID: "ses_subagent_parent" } } } as any,
    });

    const output: any = {
      message: { id: "msg_subagent_recall" },
      parts: [{ type: "text", text: "# test-coverage\n\ntest coverage metrics and gaps" }],
    };
    await hooks["chat.message"]!({
      sessionID: "ses_subagent_recall", messageID: "msg_subagent_recall",
    } as any, output);
    expect(output.parts.length).toBe(1);
  });

  test("task-dispatched sub-agent sessions get no extraction nudge", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_subagent_extract", callID: "sx1", args: { command: "ls" } },
      { title: "list files", output: "file.txt", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_subagent_extract", parentID: "ses_subagent_parent2" } } } as any,
    });

    const output: any = {
      message: { id: "msg_subagent_extract" },
      parts: [{ type: "text", text: "next prompt for the sub-agent session" }],
    };
    await hooks["chat.message"]!({
      sessionID: "ses_subagent_extract", messageID: "msg_subagent_extract",
    } as any, output);
    expect(output.parts.length).toBe(1);
  });

  test("pending extraction does not block the recall nudge (no extraction nudge exists)", async () => {
    // The old extraction nudge took priority and suppressed recall whenever
    // the buffer was non-empty - tool-dense sessions starved recall. With
    // extraction plugin-driven (no nudge), recall fires independently.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_priority", callID: "c1", args: { command: "ls" } },
      { title: "list files", output: "file.txt", metadata: {} },
    );

    const output: any = {
      message: { id: "msg_priority" },
      parts: [{ type: "text", text: "test coverage metrics and gaps" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_priority", messageID: "msg_priority" } as any, output);
    // No extraction nudge part ever appears...
    for (const part of output.parts) {
      expect(part.text ?? "").not.toContain("thatch-fact-extractor");
    }
    // ...and the buffered interaction is still served for extraction.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_priority" },
      { sessionID: "ses_ext_priority" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");
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

  test("first idle does not register a sub-agent child session", async () => {
    // The idle auto-register path (the backstop for sessions whose TUI was
    // not connected at init) had no child check: every fact-extractor run
    // registered a roster row on its terminal idle - the "thatch-extraction"
    // corpse flood (September 2026). Children are machinery, not chat
    // participants, on BOTH registration paths.
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr-child-idle" } as any);
    try {
      await prHooks.event!({ event: {
        type: "session.created",
        properties: { info: { id: "ses_idle_child", parentID: "ses_idle_parent" } } } as any,
      });
      // The child's run ends: its terminal idle must not register it.
      await prHooks.event!({ event: {
        type: "session.status",
        properties: { sessionID: "ses_idle_child", status: { type: "idle" } } } as any,
      });
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_idle_child")).toBeUndefined();
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
      expect(names).toEqual(["compact", "defrag", "exit", "extract", "hygiene", "refine", "reflect"]);
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

  test("frontmatter descriptions are always quoted YAML scalars", async () => {
    // An unquoted value containing ": " (hygiene's description has one) is
    // invalid YAML; hosts that miss the lenient fallback then show the
    // command with no description at all.
    const { opencodeCommandDefs, claudeCommandDefs } = await import("../src/commands");
    for (const def of [...opencodeCommandDefs(), ...claudeCommandDefs()]) {
      const line = def.content.split("\n").find((l) => l.startsWith("description:"))!;
      const value = line.slice("description:".length).trim();
      expect(value).toMatch(/^".*"$/);
    }
  });

  test("Claude Code command set drops wrap-ups and the opencode-only extract action", async () => {
    const { claudeCommandDefs } = await import("../src/commands");
    const names = claudeCommandDefs().map((d) => d.name).sort();
    expect(names).toEqual(["defrag", "hygiene", "refine", "reflect"]);
    for (const def of claudeCommandDefs()) {
      // Tool spelling follows the host. Hygiene drives the thatch CLI and
      // refine triggers a skill; neither names a memory tool, so both are
      // exempt from the MCP spelling check.
      if (def.name !== "hygiene" && def.name !== "refine") {
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
      expect(first).toHaveLength(4);
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
