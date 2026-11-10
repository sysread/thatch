// Part of the former plugin.test.ts "plugin entry" describe, split by
// topic, re-based onto the v2 harness (the drop-v1 plan's Phase A-prime):
// the direct-extraction child lifecycle (parent idle dispatch, child
// completion/error/deletion, toast metrics). The wiring tests live in
// plugin-entry.test.ts, the buffering + payload handshake in
// plugin-extraction.test.ts, and the journal reconcile / claim scoping in
// plugin-extraction-claims.test.ts. The sync/async endpoint-split test is
// v1-vehicle residue (plugin-v1-mechanism.test.ts): v2 has one prompt
// endpoint, so both dispatch modes enqueue the same way.

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { setup } from "../src/opencode/v2";
import { ThatchDB } from "../src/db";
import { TOAST_EVENT } from "../src/session-tab-shared";
import {
  addedTools,
  contextHook,
  makeContext,
  promptHook,
  queueEvent,
  rpcEmitted,
  SESSION_DIR,
  sessionCreateCalls,
  sessionPromptCalls,
  sessionRemoveCalls,
  setupTestEnv,
  teardownTestEnv,
  toolAfterHook,
  waitFor,
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

// The child id the v2 harness's session.create returns (the extraction
// child the plugin spawns on the parent's idle).
const CHILD_ID = "v2-test-child";

// The v2 bus envelope for a session event: payload in `data`, and a
// location so the pump's directory filter routes it to this instance.
const sessionEvent = (type: string, data: Record<string, unknown>) => ({
  type,
  location: { directory: SESSION_DIR },
  data: { ...data },
});

// The parent's idle: v2's execution lifecycle event (the idle signal).
const parentIdle = (sessionID: string) => sessionEvent("session.execution.succeeded", { sessionID });

// The child's idle needs no location: the adapter forwards events for
// sessions it created through its childSessions set.
const childIdle = (sessionID: string) => ({ type: "session.execution.succeeded", data: { sessionID } });

const textOf = (r: unknown): string => String((r as any)?.content ?? "");

const payloadTool = () => addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;

// Drives one v2 turn through the prompt + context hook pair; returns the
// injected content parts (empty means the message stayed clean).
const runTurn = async (sessionID: string, text: string) => {
  await promptHook!({ sessionID, messageID: `msg_${sessionID}`, prompt: { text } });
  const request = {
    sessionID,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
  await contextHook!(request);
  return (request.messages[0].content as { type: string; text: string }[]).slice(1);
};

const bufferBash = async (sessionID: string, output: string) => {
  await toolAfterHook!({
    tool: "bash",
    sessionID,
    input: { command: "ls" },
    status: "completed",
    result: { content: output },
  });
};

const toasts = () => rpcEmitted.filter((e) => e.name === TOAST_EVENT);
// The extraction-metrics toast ("new: N, updated: N, ..."), distinct from
// the chat auto-register toast the parent's first idle legitimately fires
// on this harness (the v1 recClient had no session.get, so its
// auto-register always failed silently and never toasted).
const metricsToasts = () =>
  toasts().filter((e) => /(?:new|updated|deleted|held): \d/.test(String(e.data?.message)) && e.data?.variant === "success");

describe("plugin entry", () => {
  // -----------------------------------------------------------------------
  // Direct extraction - the ONLY opencode path
  //
  // When the parent session goes idle with pending tool interactions, the
  // plugin creates a child session and prompts it directly. There is no
  // model-facing extraction nudge on opencode: the model-driven handshake
  // (dispatch + ack + id-copying) raced its own state machine and was
  // removed. chat.message stays clean; the pipeline owns the lifecycle.
  // -----------------------------------------------------------------------

  test("direct extraction: parent idle triggers child creation + child prompt", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Buffer a tool interaction in the parent
    await bufferBash("ses_direct1", "file.txt");

    // Parent goes idle - should trigger direct extraction
    await queueEvent(parentIdle("ses_direct1"));

    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);
    // Shape delta vs v1: v2's session API has no parentID - the child is
    // created TOP-LEVEL in the project directory and the runtime's
    // childToParent map (set eagerly at creation) carries the link instead.
    expect(sessionCreateCalls[0].title).toBe("thatch-extraction");
    expect(sessionCreateCalls[0].location).toEqual({ directory: "/tmp/thatch-v2-test-project" });
    await waitFor("extraction child prompted", () => sessionPromptCalls.length === 1);
    expect(sessionPromptCalls[0].text).toContain("thatch-fact-extractor");

    // Child creation writes the durable chat machinery marker, so the chat
    // auto-registration paths refuse the child even when a plugin reload
    // or daemon restart wiped the in-memory childToParent mapping.
    const directDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    expect(directDb.isChatMachinery(CHILD_ID)).toBe(true);
    directDb.close();
  });

  test("direct extraction: extraction child deleted before completing requeues", async () => {
    // The no-loss contract for EXTRACTION-kind children: the child is
    // deleted before it fetches or acks. (Task-kind children are deleted
    // routinely and do NOT requeue - see the task-child deletion test
    // above; the kind gate is what separates the two.)
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Buffer a tool interaction, then let the parent go idle - the plugin
    // dispatches a direct-extraction child (kind=extraction).
    await bufferBash("ses_delx", "file.txt");
    await queueEvent(parentIdle("ses_delx"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // The extraction child is deleted before completing.
    await queueEvent(sessionEvent("session.deleted", { sessionID: CHILD_ID }));

    // The entries return to pending: the NEXT idle re-triggers extraction
    // (there is no model-facing nudge fallback any more - the plugin owns
    // the retry).
    await queueEvent(parentIdle("ses_delx"));
    await waitFor("extraction re-triggered", () => sessionCreateCalls.length === 2);

    // The buffer was not dropped - the payload provider still serves it.
    const served = await payloadTool().execute(
      { session_id: "ses_delx" },
      { sessionID: "ses_ext_delx", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");
  });

  test("direct extraction: chat.message stays clean while an extraction child runs", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Buffer a tool interaction
    await bufferBash("ses_direct2", "file.txt");

    // Trigger extraction via parent idle
    await queueEvent(parentIdle("ses_direct2"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // chat.message stays clean while a direct-extraction child runs (no
    // model-facing extraction nudge exists at all - see the section
    // comment). Short prompt falls through to recall, which produces
    // nothing here.
    const injections = await runTurn("ses_direct2", "ok");
    expect(injections.length).toBe(0);
  });

  test("direct extraction: child idle cleans up and deletes child session", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Buffer + trigger extraction
    await bufferBash("ses_direct3", "file.txt");
    await queueEvent(parentIdle("ses_direct3"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // Child fetches its payload (the tool call records the claim), does a
    // no-save run, and acks - the claim completion consumes the delivered
    // entries.
    await payloadTool().execute(
      { session_id: "ses_direct3" },
      { sessionID: CHILD_ID, agent: "general" },
    );
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: CHILD_ID,
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });

    // Child goes idle — should clean up and delete the child
    await queueEvent(childIdle(CHILD_ID));
    await waitFor("extraction child deleted", () => sessionRemoveCalls.length === 1);
    expect(sessionRemoveCalls[0]).toEqual({ sessionID: CHILD_ID });

    // After cleanup, the extracting flag is cleared and the claimed entries
    // are consumed - the delivered entries were processed, so nothing is
    // left to extract. (A child that never fetches leaves them held: the
    // stale requeue returns them to pending, instead of the old idle-time
    // snapshot drain that silently dropped never-fetched entries.)
    const injections = await runTurn("ses_direct3", "hello world testing");
    expect(injections.length).toBe(0); // clean message, claim consumed on child ack
  });

  test("direct extraction: child error clears extracting, next idle re-extracts", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    await bufferBash("ses_direct4", "file.txt");
    await queueEvent(parentIdle("ses_direct4"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // Child errors out (v2's failed terminal event: error + idle pair).
    await queueEvent(sessionEvent("session.execution.failed", {
      sessionID: CHILD_ID,
      error: { name: "APIError", message: "boom" },
    }));

    // The entries are still pending (the erroring child never fetched).
    // There is no nudge fallback any more - the plugin itself retries on
    // the next idle.
    await queueEvent(parentIdle("ses_direct4"));
    await waitFor("extraction re-triggered", () => sessionPromptCalls.length === 2);
    expect(sessionCreateCalls.length).toBe(2);
  });

  test("direct extraction: child memory write without a fetch does not consume the parent's buffer", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Buffer tool interactions in parent
    await bufferBash("ses_direct5", "file.txt");

    // Parent idle triggers extraction
    await queueEvent(parentIdle("ses_direct5"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // Child writes a memory WITHOUT fetching first - its write proves
    // nothing about the parent's buffer (no claim exists), so the parent's
    // pending entries survive untouched.
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: CHILD_ID,
      input: {},
      status: "completed",
      result: { content: "[saved]" },
    });

    // Parent's buffer is still served - no silent consumption.
    const served = await payloadTool().execute(
      { session_id: "ses_direct5" },
      { sessionID: "ses_ext_d5", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");
  });

  test("direct extraction: no extraction triggered when buffer is empty", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Parent goes idle with no pending interactions
    await queueEvent(parentIdle("ses_empty"));
    // Negative wait: the pump's handler is async; settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(sessionCreateCalls.length).toBe(0);
  });

  test("HIGH fix: interleaved entries survive when child writes memory then goes idle", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Buffer 3 entries in parent, trigger extraction
    for (let i = 0; i < 3; i++) {
      await toolAfterHook!({
        tool: "bash",
        sessionID: "ses_interleave_fix",
        input: { command: `cmd-${i}` },
        status: "completed",
        result: { content: `out-${i}` },
      });
    }
    await queueEvent(parentIdle("ses_interleave_fix"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // Simulate interleaved turn: 2 new entries arrive while child runs
    for (let i = 0; i < 2; i++) {
      await toolAfterHook!({
        tool: "bash",
        sessionID: "ses_interleave_fix",
        input: { command: `cmd2-${i}` },
        status: "completed",
        result: { content: `out2-${i}` },
      });
    }

    // Child writes a memory — drains snapshot (3 pre-dispatch entries),
    // deletes parentSnapshots entry
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: CHILD_ID,
      input: {},
      status: "completed",
      result: { content: "[saved]" },
    });

    // Child goes idle — must NOT drain the buffer (interleaved entries
    // should survive for the next extraction cycle)
    await queueEvent(childIdle(CHILD_ID));

    // The child never fetched, so nothing was claimed or consumed: ALL
    // five entries (3 pre-dispatch + 2 interleaved) are still served for
    // the next extraction cycle. Nothing was lost.
    const served = await payloadTool().execute(
      { session_id: "ses_interleave_fix" },
      { sessionID: "ses_ext_ivf", agent: "general" },
    );
    const text = textOf(served);
    for (let i = 0; i < 3; i++) expect(text).toContain(`out-${i}`);
    for (let i = 0; i < 2; i++) expect(text).toContain(`out2-${i}`);
  });

  test("HIGH fix: non-extraction sub-agent idle does not drain buffer or delete session", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Buffer entries in parent
    await bufferBash("ses_task_parent", "file.txt");

    // Simulate a task-dispatched sub-agent (NOT created by triggerExtraction)
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_task_child",
      info: { id: "ses_task_child", parentID: "ses_task_parent" },
    }));

    // Sub-agent goes idle — should NOT drain buffer or delete session
    await queueEvent(sessionEvent("session.execution.succeeded", { sessionID: "ses_task_child" }));
    // Negative wait: the pump's handler is async; settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(sessionRemoveCalls.length).toBe(0);

    // Buffer should still have entries - the payload provider still serves
    // them (the task child's idle consumed nothing it never claimed).
    const served = await payloadTool().execute(
      { session_id: "ses_task_parent" },
      { sessionID: "ses_ext_tk", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");
  });

  test("toast: shows metrics on child idle after memory writes", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Buffer + trigger extraction
    await bufferBash("ses_toast1", "file.txt");
    await queueEvent(parentIdle("ses_toast1"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // Child writes 2 new memories and 1 updated
    const remember = (label: string, extra: Record<string, unknown> = {}) =>
      toolAfterHook!({
        tool: "thatch_memory_remember",
        sessionID: CHILD_ID,
        input: { label, ...extra },
        status: "completed",
        result: { content: "[saved]" },
      });
    await remember("a");
    await remember("b");
    await remember("a", { overwrite: true });

    // Child goes idle — toast should fire with metrics
    await queueEvent(childIdle(CHILD_ID));
    await waitFor("extraction metrics toast", () => metricsToasts().length === 1);
    const toast = metricsToasts()[0];
    expect(toast.data.message).toContain("new: 2");
    expect(toast.data.message).toContain("updated: 1");
    expect(toast.data.variant).toBe("success");
  });

  test("toast: teaching-output remember (no save) drains nothing and bumps no metrics", async () => {
    // The gate keeps a remember call whose output saved nothing from
    // draining the extraction buffer, completing claims, or bumping the
    // child's toast metrics. The child setup mirrors the positive toast
    // test exactly (buffered parent tool call, parent idle, then the
    // child linked) so the child is an extraction-kind child: with the
    // gate disabled, the metrics bump and the toast fires, which fails
    // this test.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // Buffer a parent tool call, then send the parent idle so the pending
    // extraction classifies the child as extraction-kind.
    await bufferBash("ses_teach1", "file.txt");
    await queueEvent(parentIdle("ses_teach1"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: CHILD_ID,
      input: {},
      status: "completed",
      result: { content: "No content provided - pass the information to remember in the content parameter." },
    });

    // A teaching return is not a write: no metrics are bumped, so the
    // child's idle stays toast-silent.
    await queueEvent(childIdle(CHILD_ID));
    // Negative wait: the pump's handler is async; settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(metricsToasts().length).toBe(0);
  });

  test("toast: a held write drains nothing, keeps the claim open, and counts as held", async () => {
    // A [held] remember output is not a save: the drain gate stays closed
    // (the child's fetched claim is NOT completed by the hold - the
    // entries survive for the completion signal), no save metric is
    // bumped, and the held counter fires the toast (the one knowing
    // override of the no-save suppression: a guard firing is exactly the
    // visibility the toast exists for).
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    await bufferBash("ses_hold1", "file.txt");
    await queueEvent(parentIdle("ses_hold1"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // The child fetches its payload (records the claim), then its remember
    // is refused by a tombstone guard.
    const fetch = await payloadTool().execute(
      { session_id: "ses_hold1" },
      { sessionID: CHILD_ID, agent: "general" },
    );
    expect(textOf(fetch)).toContain("file.txt");
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: CHILD_ID,
      input: { label: "x", content: "y" },
      status: "completed",
      result: { content: "[held] sysread/thatch :: x - nothing was saved: this content matches a memory deliberately deleted on 2026-11-10." },
    });

    // The hold did not complete the child's claim: the parent's entries
    // are still delivered to a new fetcher (nothing was lost, and the
    // completion still belongs to extraction_done or the child's idle).
    const refetch = await payloadTool().execute(
      { session_id: "ses_hold1" },
      { sessionID: CHILD_ID, agent: "general" },
    );
    expect(textOf(refetch)).toContain("file.txt");

    // The child completes: the toast reports the hold, not a save.
    await queueEvent(childIdle(CHILD_ID));
    await waitFor("held metrics toast", () => metricsToasts().length === 1);
    const toast = metricsToasts()[0];
    expect(toast.data.message).toContain("held: 1");
    expect(toast.data.message).not.toContain("new:");
  });

  test("toast: no toast on no-save extraction run", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    await bufferBash("ses_toast2", "file.txt");
    await queueEvent(parentIdle("ses_toast2"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // Child goes idle without writing any memories — no toast should fire.
    await queueEvent(childIdle(CHILD_ID));
    // Negative wait: the pump's handler is async; settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(metricsToasts().length).toBe(0);
  });

  test("toast: tracks deletions in child sessions", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    await bufferBash("ses_toast3", "file.txt");
    await queueEvent(parentIdle("ses_toast3"));
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);

    // Child writes 1 new memory and deletes 1
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: CHILD_ID,
      input: { label: "c" },
      status: "completed",
      result: { content: "[saved]" },
    });
    await toolAfterHook!({
      tool: "thatch_memory_forget",
      sessionID: CHILD_ID,
      input: { label: "old" },
      status: "completed",
      result: { content: "[forgotten]" },
    });

    await queueEvent(childIdle(CHILD_ID));
    await waitFor("extraction metrics toast", () => metricsToasts().length === 1);
    const toast = metricsToasts()[0];
    expect(toast.data.message).toContain("new: 1");
    expect(toast.data.message).toContain("deleted: 1");
    expect(toast.data.variant).toBe("success");
  });
});
