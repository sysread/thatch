// Part of the former plugin.test.ts "plugin entry" describe, split by
// topic, re-based onto the v2 harness (the drop-v1 plan's Phase A-prime):
// interaction buffering and the payload accept/claim/complete handshake.
// The wiring tests live in plugin-entry.test.ts, the journal reconcile and
// claim-scoping races in plugin-extraction-claims.test.ts, and the
// direct-extraction child lifecycle in plugin-extraction-direct.test.ts.
// The crafted-output.parts legs of the nudge guards (echo-skip,
// synthetic-only, mixed multi-part) are v1-vehicle residue and live in
// plugin-v1-mechanism.test.ts.

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { setup } from "../src/opencode/v2";
import {
  addedTools,
  contextHook,
  makeContext,
  promptHook,
  queueEvent,
  SESSION_DIR,
  setupTestEnv,
  teardownTestEnv,
  toolAfterHook,
} from "./mocks/opencode-v2-harness";

// These tests pump async events through the v2 adapter harness; under a
// loaded CI runner the pump can lag. Bun's default per-test timeout is 5s
// with no margin for that (the 2026-11-03 fleet-contention CI reds). 90s =
// expected (ms-scale pump handling) x ~900 headroom, above the harness
// waitFor deadline so real hangs report the poll message.
setDefaultTimeout(90_000);

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  setupTestEnv();
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  await teardownTestEnv();
});

// The v2 Tool.Result carries the tool's text in `content`.
const textOf = (r: unknown): string => String((r as any)?.content ?? "");

// The v2 bus envelope for a session event: payload in `data`, and a
// location so the pump's directory filter routes it to this instance.
const sessionEvent = (type: string, data: Record<string, unknown>) => ({
  type,
  location: { directory: SESSION_DIR },
  data: { ...data },
});

describe("plugin entry", () => {
  test("buffered interactions never surface as chat.message nudges (extraction is plugin-driven)", async () => {
    // There is deliberately NO model-facing extraction nudge on opencode:
    // the model-driven handshake raced its own state machine (the September
    // 2026 dispatch-loop report). Buffered interactions are extracted by the
    // plugin's own child session at idle; chat.message must stay clean.
    // (The echo-bubble leg of this guard is v1 residue - the v2 prompt hook
    // cannot craft output.parts.)
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_echo_skip",
      input: { command: "ls" },
      status: "completed",
      result: { content: "README.md" },
    });

    // A real user message with the same pending buffer: still no nudge.
    const text = "hello there friend";
    await promptHook!({ sessionID: "ses_echo_skip", messageID: "msg_real", prompt: { text } });
    const request = {
      sessionID: "ses_echo_skip",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    };
    await contextHook!(request);
    expect((request.messages[0].content as unknown[]).length).toBe(1);

    // The buffer was not dropped - the payload provider still serves it.
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      { session_id: "ses_echo_skip" },
      { sessionID: "ses_extractor", agent: "general" },
    );
    expect(textOf(served)).toContain("README.md");
  });

  test("real messages skip the (removed) extraction nudge", async () => {
    // Extraction no longer nudges at all, so no extraction text may appear
    // for a real user message. (The synthetic-only and mixed multi-part legs
    // of this guard are v1 residue - the v2 prompt hook cannot craft
    // output.parts.)
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_synth",
      input: { command: "ls" },
      status: "completed",
      result: { content: "README.md" },
    });

    const text = "what is next?";
    await promptHook!({ sessionID: "ses_synth", messageID: "msg_real", prompt: { text } });
    const request = {
      sessionID: "ses_synth",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    };
    await contextHook!(request);
    const parts = request.messages[0].content as { type: string; text: string }[];
    expect(parts.length).toBe(1);
    expect(parts[0].text).not.toContain("thatch-fact-extractor");
  });

  test("buffered tool interactions are served by the payload provider, scoped per session", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_a",
      input: { command: "ls" },
      status: "completed",
      result: { content: "README.md" },
    });
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;

    // A different session sees nothing.
    const other = await payloadTool.execute(
      { session_id: "ses_b" },
      { sessionID: "ses_b", agent: "general" },
    );
    expect(textOf(other)).not.toContain("README.md");

    // The originating session's buffer is served - session ID in the
    // payload context, interactions inside, no nudge was ever injected.
    const served = await payloadTool.execute(
      { session_id: "ses_a" },
      { sessionID: "ses_ext_a", agent: "general" },
    );
    const text = textOf(served);
    expect(text).toContain("README.md");
    expect(text).toContain("projectStore");

    // The buffer is NOT drained by the fetch alone - the fetch records a
    // CLAIM for the fetcher, and a second fetcher still sees the entries
    // until that fetcher's completion signal arrives.
    const served2 = await payloadTool.execute(
      { session_id: "ses_a" },
      { sessionID: "ses_ext_b", agent: "general" },
    );
    expect(textOf(served2)).toContain("README.md");

    // The extractor (ses_ext_a) completes with the parent's session id:
    // its claimed delivery is consumed.
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_ext_a",
      input: { session_id: "ses_a" },
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    const drained = await payloadTool.execute(
      { session_id: "ses_a" },
      { sessionID: "ses_ext_c", agent: "general" },
    );
    expect(textOf(drained)).not.toContain("README.md");
  });

  test("thatch's own tools are not buffered for extraction", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: "ses_c",
      input: {},
      status: "completed",
      result: { content: "[saved]" },
    });
    const text = "a normal user prompt";
    await promptHook!({ sessionID: "ses_c", messageID: "msg_3", prompt: { text } });
    const request = {
      sessionID: "ses_c",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    };
    await contextHook!(request);
    expect((request.messages[0].content as unknown[]).length).toBe(1);
  });

  test("skill, task, and subagent meta-tools are not buffered (feedback loop prevention)", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "skill",
      sessionID: "ses_d",
      input: { name: "thatch-fact-extractor" },
      status: "completed",
      result: { content: "loaded" },
    });
    await toolAfterHook!({
      tool: "task",
      sessionID: "ses_d",
      input: { description: "extract" },
      status: "completed",
      result: { content: "done" },
    });
    // v2's dispatch tool is named subagent; buffering a dispatch would feed
    // the extraction loop with its own exhaust (nudge -> dispatch ->
    // buffered dispatch -> nudge).
    await toolAfterHook!({
      tool: "subagent",
      sessionID: "ses_d",
      input: { description: "extract" },
      status: "completed",
      result: { content: "done" },
    });
    const text = "a normal user prompt";
    await promptHook!({ sessionID: "ses_d", messageID: "msg_4", prompt: { text } });
    const request = {
      sessionID: "ses_d",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    };
    await contextHook!(request);
    expect((request.messages[0].content as unknown[]).length).toBe(1);
  });

  test("DEFECT 1: a no-claim child ack does not drop the accepted set", async () => {
    // The accept-before-fetch interaction loss: a child extraction_done
    // that arrives BEFORE the child fetched (or mis-targeted) had no
    // claim, and the old whole-set fallback completed the parent's ENTIRE
    // accepted queue - wiping the delivery the real extractor was about to
    // claim, silently, every round. A no-claim ack proves nothing was
    // processed, so it must be a no-op: entries stay held for the real
    // extractor, and requeueStaleAccepted bounds any orphan linger.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_p",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    // Parent acks (accept): entries move to the holding area.
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_p",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    // A child acks WITHOUT fetching first (payload call errored, or a
    // mis-ordered run). No claim exists for it.
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_ext_early",
      input: { session_id: "ses_p" },
      status: "completed",
      result: { content: "[acknowledged]" },
    });

    // The accepted set SURVIVES the no-claim ack - the real extractor can
    // still claim and process it.
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      { session_id: "ses_p" },
      { sessionID: "ses_ext", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");

    // The real extractor finishes and acks with the parent's session id:
    // ITS claimed delivery completes (the fetch above recorded the claim).
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_ext",
      input: { session_id: "ses_p" },
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    const drained = await payloadTool.execute(
      { session_id: "ses_p" },
      { sessionID: "ses_other", agent: "general" },
    );
    expect(textOf(drained)).not.toContain("file.txt");
  });

  test("task child memory write does not drain the parent's buffer", async () => {
    // A task-dispatched sub-agent saving its OWN findings is not evidence
    // that the parent's buffer was extracted: the child never fetched a
    // payload. The old whole-child drain silently dropped the parent's
    // pre-dispatch entries without extraction once v2 linked all children
    // to their parents - the drain is now extraction-child only.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // Step 1: Buffer tool interactions in the PARENT session BEFORE dispatch
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_parent_fixa",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });

    // Step 2: Simulate a sub-agent child session being created (dispatch).
    // The snapshot captures the parent's current buffer at this point.
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_child_fixa",
      info: { id: "ses_child_fixa", parentID: "ses_parent_fixa" },
    }));

    // Step 3: Child session writes a memory (as a sub-agent would)
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: "ses_child_fixa",
      input: {},
      status: "completed",
      result: { content: "[saved]" },
    });

    // Parent's pre-dispatch entries SURVIVE the task child's memory write -
    // the payload provider still serves them for extraction.
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      { session_id: "ses_parent_fixa" },
      { sessionID: "ses_ext_fixa", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");
  });

  test("task child memory write preserves interleaved entries too", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // Buffer tool calls in parent BEFORE dispatch
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_parent_interleave",
      input: { command: "git status" },
      status: "completed",
      result: { content: "clean" },
    });

    // Dispatch sub-agent — snapshot captures the parent's current buffer
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_child_interleave",
      info: { id: "ses_child_interleave", parentID: "ses_parent_interleave" },
    }));

    // While sub-agent runs, parent makes more tool calls (interleaved turn)
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_parent_interleave",
      input: { command: "git log" },
      status: "completed",
      result: { content: "history" },
    });

    // Sub-agent writes a memory — a task-kind child drains NOTHING: the
    // pre-dispatch AND interleaved entries both survive.
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: "ses_child_interleave",
      input: {},
      status: "completed",
      result: { content: "[saved]" },
    });

    // The parent's entries (both pre-dispatch and interleaved) are still
    // served for extraction.
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      { session_id: "ses_parent_interleave" },
      { sessionID: "ses_ext_iv", agent: "general" },
    );
    const text = textOf(served);
    expect(text).toContain("clean");
    expect(text).toContain("history");
  });

  test("parent ack holds entries; a claim-less child idle leaves them held (no wipe)", async () => {
    // The parent-accept role: entries move to the holding area (no model-
    // facing nudge exists to quiet any more, but the accept is harmless),
    // and NOTHING drops them until a fetcher's claim is completed - not
    // even the child's idle signal.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_fixc",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });

    // Parent accepts the buffer after dispatching the extractor
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_fixc",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });

    // Extractor (child session) finishes without fetching or saving and
    // goes idle - a no-claim idle is a no-op, never a wipe.
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_child_fixc",
      info: { id: "ses_child_fixc", parentID: "ses_fixc" },
    }));
    await queueEvent(sessionEvent("session.execution.succeeded", {
      sessionID: "ses_child_fixc",
    }));

    // The held entries are still served - requeueStaleAccepted will return
    // them to pending for re-extraction; nothing was lost.
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      { session_id: "ses_fixc" },
      { sessionID: "ses_ext_fixc", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");
  });

  test("accept/requeue: child session error returns entries to pending (re-extractable)", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_requeue",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_requeue",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });

    // Extractor child errors out before writing any memory
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_child_requeue",
      info: { id: "ses_child_requeue", parentID: "ses_requeue" },
    }));
    await queueEvent(sessionEvent("session.error", {
      sessionID: "ses_child_requeue",
      error: { name: "APIError", message: "boom" },
    }));

    // The requeued entries are still served — facts are not lost
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      { session_id: "ses_requeue" },
      { sessionID: "ses_ext_rq", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");
  });

  test("accept/requeue: task child deleted before completing leaves entries held", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_delq",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_delq",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_child_delq",
      info: { id: "ses_child_delq", parentID: "ses_delq" },
    }));
    await queueEvent(sessionEvent("session.deleted", {
      sessionID: "ses_child_delq",
    }));

    // A task-kind child is deleted ROUTINELY (after finishing, or by the
    // harness). Its deletion must not requeue the parent's accepted set -
    // that would yank an in-flight extractor's claim back to pending. The
    // claim-less task child holds nothing; requeueStaleAccepted bounds any
    // orphan linger. Either way the entries are served, never dropped.
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      { session_id: "ses_delq" },
      { sessionID: "ses_ext_dq", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");
  });

  test("session.deleted drops the session's pending buffer (journal row included)", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_delbuf",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    // The buffer is served before deletion...
    const served = await payloadTool.execute(
      { session_id: "ses_delbuf" },
      { sessionID: "ses_ext_delbuf", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");

    await queueEvent(sessionEvent("session.deleted", { sessionID: "ses_delbuf" }));

    // ...and gone after: no future prompt can nudge a deleted session, so
    // keeping the buffer (and its runtime_state journal row) would strand
    // it until a restart - forever, if the directory dies first.
    const after = await payloadTool.execute(
      { session_id: "ses_delbuf" },
      { sessionID: "ses_ext_delbuf2", agent: "general" },
    );
    expect(textOf(after)).not.toContain("file.txt");
  });

  test("accept/complete: child fetch + extraction_done completes the parent's accepted entries", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_ack",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_ack",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_child_ack",
      info: { id: "ses_child_ack", parentID: "ses_ack" },
    }));

    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    // The child fetches its payload (recording the claim)...
    await payloadTool.execute(
      { session_id: "ses_ack" },
      { sessionID: "ses_child_ack", agent: "general" },
    );
    // ...and finishes a no-save run by calling extraction_done itself
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_child_ack",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });

    const drained = await payloadTool.execute(
      { session_id: "ses_ack" },
      { sessionID: "ses_ext_ak", agent: "general" },
    );
    expect(textOf(drained)).not.toContain("file.txt");
  });

  test("accept/complete: child fetch + memory write completes accepted entries", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_mwc",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_mwc",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_child_mwc",
      info: { id: "ses_child_mwc", parentID: "ses_mwc" },
    }));
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    // The child fetches its payload (recording the claim), then proves it
    // processed the delivery by writing a memory - the write completes the
    // claim.
    await payloadTool.execute(
      { session_id: "ses_mwc" },
      { sessionID: "ses_child_mwc", agent: "general" },
    );
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: "ses_child_mwc",
      input: {},
      status: "completed",
      result: { content: "[saved]" },
    });

    const drained = await payloadTool.execute(
      { session_id: "ses_mwc" },
      { sessionID: "ses_ext_mwc", agent: "general" },
    );
    expect(textOf(drained)).not.toContain("file.txt");
  });
});
