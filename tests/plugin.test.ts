import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock @huggingface/transformers so BgeEmbeddingModel can embed without
// downloading a model. Produces the same hash-based vectors as
// MockEmbeddingModel, stripping the QUERY_PREFIX so query and passage
// embeddings for the same text produce identical vectors.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
mock.module("@huggingface/transformers", () => ({
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

import { server } from "../src/index";
import {
  sessionStartReminder,
  recallNudge,
  claudeRecallNudge,
  claudeSessionStartReminder,
  claudeWriteNudge,
  claudeExtractionNudge,
  extractionNudge,
  extractionDirectPrompt,
  type NudgeMatch,
} from "../src/prompts";

let hooks: Awaited<ReturnType<typeof server>>;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-plugin-test-"));
  process.env.THATCH_DB_PATH = join(dbDir, "test.db");
  // Redirect skill installation away from the real ~/.config.
  process.env.XDG_CONFIG_HOME = join(dbDir, "config");
  // RECALL_THRESHOLD is a module-level constant (0.55 default), read when
  // index.ts is first imported. Setting the env var here can't change it,
  // but 0.55 works: the hash-based mock scores ~1.0 for identical texts and
  // near-orthogonal for different texts.
  const mockClient = {
    session: {
      prompt: async () => {},
      promptAsync: async () => {},
      create: async () => ({ data: { id: "test-child" } }),
      delete: async () => {},
    },
    tui: {
      showToast: async () => {},
    },
  };
  hooks = await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree" } as any);

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
      "thatch_dedup_mark_checked",
      "thatch_extraction_done",
      "thatch_find_duplicates",
      "thatch_memory_forget",
      "thatch_memory_list",
      "thatch_memory_recall",
      "thatch_memory_remember",
      "thatch_memory_show",
      "thatch_prediction_delete",
      "thatch_prediction_list",
      "thatch_prediction_query",
      "thatch_prediction_update",
      "thatch_store_list",
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

  test("buffered tool interactions surface as a payload nudge, scoped per session", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_a", callID: "c1", args: { command: "ls" } },
      { title: "list files", output: "README.md", metadata: {} },
    );

    // A different session sees no nudge.
    const otherOutput: any = { message: { id: "msg_0" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_b" } as any, otherOutput);
    expect(otherOutput.parts.length).toBe(0);

    // The originating session gets the nudge with the actual payload.
    const output: any = { message: { id: "msg_1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_a", messageID: "msg_1" } as any, output);
    expect(output.parts.length).toBe(1);
    expect(output.parts[0].type).toBe("text");
    expect(output.parts[0].sessionID).toBe("ses_a");
    expect(output.parts[0].text).toContain("thatch-fact-extractor");
    expect(output.parts[0].text).toContain('"tool":"bash"');

    // The buffer is NOT drained — it persists until the agent calls
    // memory_remember. A second chat.message delivers the same nudge again
    // (now at escalation tier 1 since missedCount incremented).
    const output2: any = { message: { id: "msg_2" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_a" } as any, output2);
    expect(output2.parts.length).toBe(1);
    expect(output2.parts[0].text).toContain("thatch-fact-extractor");
    expect(output2.parts[0].text).toContain('"tool":"bash"');

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

  test("skill and task meta-tools are not buffered (feedback loop prevention)", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: "ses_d", callID: "c3", args: { name: "thatch-fact-extractor" } },
      { title: "load skill", output: "loaded", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "ses_d", callID: "c4", args: { description: "extract" } },
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

    // The nudge replays with the original payload — facts are not lost
    const out: any = { message: { id: "msg_rq1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_requeue", messageID: "msg_rq1" } as any, out);
    expect(out.parts.length).toBe(1);
    expect(out.parts[0].text).toContain('"tool":"bash"');
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
    expect(out.parts[0].text).toContain('"tool":"bash"');
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
// claudeSessionStartReminder / claudeWriteNudge / claudeExtractionNudge
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

describe("claudeExtractionNudge", () => {
  test("singular form for one interaction", () => {
    const nudge = claudeExtractionNudge(1, '{"tool":"bash"}');
    expect(nudge).toContain("1 queued tool interaction");
    expect(nudge).not.toContain("interactions");
    expect(nudge).toContain("thatch-fact-extractor");
    expect(nudge).toContain("mcp__thatch__memory_remember");
    expect(nudge).toContain('{"tool":"bash"}');
  });

  test("plural form for multiple interactions", () => {
    const nudge = claudeExtractionNudge(3, '{"tool":"bash"}');
    expect(nudge).toContain("3 queued tool interactions");
    expect(nudge).toContain("thatch-fact-extractor");
  });
});

describe("extractionNudge escalation", () => {
  const payload = '{"tool":"bash"}';
  const tool = "thatch_memory_remember";

  test("tier 0 (missedCount 0-1): leads with verb, mentions background dispatch", () => {
    const nudge = extractionNudge(3, 0, tool, payload);
    expect(nudge).toContain("Dispatch a task with background: true");
    expect(nudge).toContain("thatch_extraction_done");
    expect(nudge).toContain("not user input");
    expect(nudge).toContain("continue waiting");
    expect(nudge).not.toContain("YOU HAVE NOT");
    expect(nudge).not.toContain("IGNORING");
    expect(nudge).not.toContain("if your harness");
  });

  test("tier 0 MCP path: uses generic sub-agent wording, not background: true", () => {
    const nudge = extractionNudge(3, 0, "mcp__thatch__memory_remember", payload);
    expect(nudge).toContain("Spawn a background sub-agent");
    expect(nudge).not.toContain("background: true");
    expect(nudge).toContain("mcp__thatch__extraction_done");
  });

  test("tier 1 (missedCount 2): directive prefix, no shouting", () => {
    const nudge = extractionNudge(3, 2, tool, payload);
    expect(nudge).toContain("YOU HAVE NOT PROCESSED");
    expect(nudge).not.toContain("IGNORING");
  });

  test("tier 2 (missedCount 3+): all caps, harsh", () => {
    const nudge = extractionNudge(3, 3, tool, payload);
    expect(nudge).toContain("IGNORING EXTRACTION INSTRUCTIONS");
    expect(nudge).toContain("INSTALLED THIS PLUGIN FOR A REASON");
  });

  test("tier 2 escalates further with higher counts", () => {
    const nudge = extractionNudge(5, 10, tool, payload);
    expect(nudge).toContain("IGNORING");
  });

  test("all tiers include the payload", () => {
    for (const missed of [0, 2, 3]) {
      expect(extractionNudge(1, missed, tool, payload)).toContain(payload);
    }
  });
});

describe("extractionDirectPrompt", () => {
  const payload = '{"tool":"bash"}';

  test("tells the model to run the skill directly, no task dispatch", () => {
    const prompt = extractionDirectPrompt(3, payload);
    expect(prompt).toContain("thatch-fact-extractor");
    expect(prompt).toContain("thatch_memory_remember");
    expect(prompt).toContain("thatch_extraction_done");
    expect(prompt).not.toContain("Dispatch a task");
    expect(prompt).not.toContain("background: true");
  });

  test("includes the payload", () => {
    const prompt = extractionDirectPrompt(1, payload);
    expect(prompt).toContain(payload);
  });

  test("singular form for one interaction", () => {
    const prompt = extractionDirectPrompt(1, payload);
    expect(prompt).toContain("1 queued tool interaction");
    expect(prompt).not.toContain("interactions");
  });

  test("plural form for multiple interactions", () => {
    const prompt = extractionDirectPrompt(5, payload);
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
