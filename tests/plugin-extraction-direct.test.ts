// Part of the former plugin.test.ts "plugin entry" describe, split by
// topic: the direct-extraction child lifecycle (parent idle dispatch,
// child completion/error/deletion, toast metrics). The wiring tests live
// in plugin-entry.test.ts, the buffering + payload handshake in
// plugin-extraction.test.ts, and the journal reconcile / claim scoping in
// plugin-extraction-claims.test.ts.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  server,
  setupPluginHarness,
  teardownPluginHarness,
} from "./mocks/plugin-harness";
import { ThatchDB } from "../src/db";

beforeAll(async () => {
  await setupPluginHarness();
});

afterAll(() => {
  teardownPluginHarness();
});

describe("plugin entry", () => {
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

    // Child creation writes the durable chat machinery marker, so the chat
    // auto-registration paths refuse the child even when a plugin reload
    // or daemon restart wiped the in-memory childToParent mapping.
    const directDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    expect(directDb.isChatMachinery("child_direct1")).toBe(true);
    directDb.close();

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
});
