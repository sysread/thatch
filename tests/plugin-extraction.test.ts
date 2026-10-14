// Part of the former plugin.test.ts "plugin entry" describe, split by
// topic: interaction buffering and the payload accept/claim/complete
// handshake. The wiring tests live in plugin-entry.test.ts, the journal
// reconcile and claim-scoping races in plugin-extraction-claims.test.ts,
// and the direct-extraction child lifecycle in
// plugin-extraction-direct.test.ts.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
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

  test("session.deleted drops the session's pending buffer (journal row included)", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_delbuf", callID: "db1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    // The buffer is served before deletion...
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_delbuf" },
      { sessionID: "ses_ext_delbuf" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");

    await hooks.event!({ event: {
      type: "session.deleted",
      properties: { info: { id: "ses_delbuf" } } } as any,
    });

    // ...and gone after: no future prompt can nudge a deleted session, so
    // keeping the buffer (and its runtime_state journal row) would strand
    // it until a restart - forever, if the directory dies first.
    const after = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_delbuf" },
      { sessionID: "ses_ext_delbuf2" },
    );
    const afterText = typeof after === "string" ? after : JSON.stringify(after);
    expect(afterText).not.toContain("file.txt");
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
});
