// chat.message nudge tiers from plugin.test.ts: the recall, prediction,
// and behavior auto-fires plus the compaction guard, all driven through
// the shared plugin runtime hooks.

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
