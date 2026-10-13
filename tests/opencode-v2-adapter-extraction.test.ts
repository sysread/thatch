import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { setup } from "../src/opencode/v2";
import { runtimeStateRow } from "./mocks/runtime-state";
import {
  addedTools,
  contextHook,
  makeContext,
  promptHook,
  queueEvent,
  SESSION_DIR,
  sessionCreateCalls,
  sessionPromptCalls,
  sessionRemoveCalls,
  setupTestEnv,
  teardownTestEnv,
  toolAfterHook,
  waitFor,
} from "./mocks/opencode-v2-harness";

// The extraction child lifecycle on the v2 adapter: the zero-session-id
// end-to-end flows (parent idle -> child spawn -> fetch/ack via
// childToParent), the child's idle-time deletion, and the older-SDK floor
// for session.remove.

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  setupTestEnv();
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  await teardownTestEnv();
});

describe("opencode v2 adapter", () => {
  test("buffered tool entries get a derived title (v2 sends no title field)", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // v2's Tool.Result has no title: `output` is the typed output value.
    // The adapter derives the title from the tool name and args (same rule
    // as the MCP host path); a bash call's command text becomes the title.
    // The observable is the extraction payload the payload-fetch tool
    // serves: it lists each buffered entry's title.
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_title",
      input: { command: "mise run check" },
      status: "completed",
      result: { content: [{ type: "text", text: "all green" }] },
    });
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload");
    expect(payloadTool).toBeDefined();
    // The v2 execute wraps (input, toolContext) - the host context carries
    // the session the buffer is keyed by.
    const result = await payloadTool!.execute({ limit: 20 }, { sessionID: "ses_v2_title", agent: "build" });
    const payload = typeof result === "string" ? result : JSON.stringify(result);
    expect(payload).toContain("mise run check");
  });

  test("v2 end-to-end: idle-triggered extraction child completes with zero session ids", async () => {
    // The whole opencode v2 lifecycle through the real adapter, with the
    // model passing NO session ids anywhere: parent work buffers -> parent
    // idle (session.execution.succeeded) creates the child via
    // sessionCreate (childToParent set eagerly - v2 create has no parentID)
    // -> the child fetches with no id (auto-resolves to the parent via
    // childToParent) -> the child acks with no id -> the parent's buffer is
    // drained. No prompt-hook injection ever carried an extraction nudge.
    const context = makeContext();
    cleanup = (await setup(context as any)) as () => Promise<void>;
    const fetchTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    expect(fetchTool).toBeDefined();

    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_e2e",
      input: { command: "git log" },
      status: "completed",
      result: { content: "abc123 real work" },
    });

    // Parent idle: the plugin creates the extraction child itself.
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_e2e" },
    });
    await waitFor("child created", () => sessionCreateCalls.length === 1);
    // The child was prompted with the parent's id interpolated by the
    // plugin - but the child below never uses it.
    await waitFor("child prompted", () => sessionPromptCalls.length >= 1);
    expect(sessionPromptCalls[0].text).toContain("thatch-fact-extractor");

    // The child fetches with NO session_id: the host supplies the child's
    // own id, and the provider retargets to the parent via childToParent.
    const served = await fetchTool.execute({}, { sessionID: "v2-test-child", agent: "general" });
    expect(String((served as any).content)).toContain("abc123");

    // The child acks with NO session_id: parentID is known, the claim
    // completes, and the parent's buffer is gone.
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "v2-test-child",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    const drained = await fetchTool.execute({ session_id: "ses_v2_e2e" }, { sessionID: "ses_v2_other", agent: "general" });
    expect(String((drained as any).content)).not.toContain("abc123");

    // The prompt hook never injected an extraction nudge for the parent.
    const prompt = { text: "and now what" };
    await promptHook!({ sessionID: "ses_v2_e2e", messageID: "msg_e2e", prompt });
    const request = {
      sessionID: "ses_v2_e2e",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "and now what" }] }],
    };
    await contextHook!(request);
    expect((request.messages[0].content as any[]).length).toBe(1);
  });

  test("v2 end-to-end: a model-dispatched sub-agent (info.parentID link) extracts with zero ids", async () => {
    // v2's session.created carries info.parentID for task-tool-dispatched
    // sub-agents (translateEvent). Such a child is linked in childToParent
    // the same way, so the auto-resolution and claim-scoped completion
    // cover it too - even though no plugin-side triggerExtraction created
    // it. Its memory write (not an ack) is the completion signal here.
    const context = makeContext();
    cleanup = (await setup(context as any)) as () => Promise<void>;
    const fetchTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;

    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_task_parent",
      input: { command: "ls" },
      status: "completed",
      result: { content: "payload-xyz" },
    });
    await queueEvent({
      type: "session.created",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_task_child", info: { id: "ses_v2_task_child", parentID: "ses_v2_task_parent" } },
    });
    // The pump's handler is async: poll until the link is live, then fetch
    // with NO session_id - the child's own id retargets to the parent.
    let linked = "";
    const end = Date.now() + 5000;
    while (!linked.includes("payload-xyz")) {
      if (Date.now() > end) throw new Error("timed out waiting for: child linked");
      const r = await fetchTool.execute({}, { sessionID: "ses_v2_task_child", agent: "general" });
      linked = String((r as any).content);
      if (!linked.includes("payload-xyz")) await new Promise((res) => setTimeout(res, 25));
    }

    // Memory write in the linked child completes its claim.
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: "ses_v2_task_child",
      input: { label: "x", content: "y" },
      status: "completed",
      result: { content: "[saved]" },
    });
    const drained = await fetchTool.execute({ session_id: "ses_v2_task_parent" }, { sessionID: "ses_v2_other2", agent: "general" });
    expect(String((drained as any).content)).not.toContain("payload-xyz");
  });

  test("the extraction child's idle deletes it via session.remove on a current host", async () => {
    // The child deletion keeps the session picker clean on v2 (and `-c`
    // resume out of extraction children). finishExtractionChild drives it
    // from the child's idle event; the child routes through the
    // childSessions forwarding set (its events carry no location here).
    const context = makeContext({ remove: true });
    cleanup = (await setup(context as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_child_del",
      input: { command: "git log" },
      status: "completed",
      result: { content: "abc123 real work" },
    });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_child_del" },
    });
    await waitFor("extraction child created", () => sessionCreateCalls.length === 1);
    await queueEvent({ type: "session.execution.succeeded", data: { sessionID: "v2-test-child" } });
    await waitFor("child deleted", () => sessionRemoveCalls.length === 1);
    expect(sessionRemoveCalls[0]).toEqual({ sessionID: "v2-test-child" });
  });

  test("an older SDK without session.remove leaves the child in place, silently", async () => {
    // The floor keeps the documented gap (the picker accumulates one
    // thatch-extraction entry per extraction): best-effort by contract, so
    // the degrade is silent and the rest of the child cleanup still runs.
    // The child journal row is the completion observable: journalChild
    // deletes it after the map cleanup and BEFORE sessionDelete, so
    // row-gone proves the cleanup ran - the settle idiom cannot (a throw
    // in finishExtractionChild would also leave remove at zero).
    const childJournaled = (): boolean => runtimeStateRow(process.env.THATCH_DB_PATH!, "child", "v2-test-child") !== null;
    const context = makeContext();
    cleanup = (await setup(context as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_v2_child_floor",
      input: { command: "git log" },
      status: "completed",
      result: { content: "abc123 real work" },
    });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_child_floor" },
    });
    await waitFor("extraction child created and journaled", () => sessionCreateCalls.length === 1 && childJournaled());
    await queueEvent({ type: "session.execution.succeeded", data: { sessionID: "v2-test-child" } });
    await waitFor("child cleanup completed", () => !childJournaled());
    expect(sessionRemoveCalls.length).toBe(0);
  });
});
