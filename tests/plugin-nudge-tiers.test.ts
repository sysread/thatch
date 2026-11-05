// chat.message nudge tiers from plugin.test.ts, re-based onto the v2
// harness (the drop-v1 plan's Phase A-prime): the recall, prediction, and
// behavior auto-fires plus the compaction guard, driven through the v2
// prompt + context hook pair. On v2 the prompt hook computes a turn's
// injections and the context hook injects them into the outbound request's
// user message; assertions read the injected content parts (v1 read
// synthetic output.parts). The compaction-part suppression tests are
// v1-vehicle residue and live in plugin-v1-mechanism.test.ts.

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { setup } from "../src/opencode/v2";
import {
  addedTools,
  compactionHook,
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

// The v2 bus envelope for a session event: payload in `data`, and a
// location so the pump's directory filter routes it to this instance.
const sessionEvent = (type: string, data: Record<string, unknown>) => ({
  type,
  location: { directory: SESSION_DIR },
  data: { ...data },
});

const toolCtx = (sessionID: string) => ({ sessionID, agent: "general" });

// Seed a prediction via the adapter's own tool so embeddings come from the
// mocked BgeEmbeddingModel. The matcher text is the raw context; the prompt
// hook embeds the user's prompt with queryEmbed (QUERY_PREFIX stripped by
// the mock), so identical text hits cosine ~1.0.
const seedPrediction = async (matcher: string, prediction: string) => {
  const update = addedTools.find((t) => t.name === "thatch_prediction_update")!;
  await update.execute({ matcher, prediction, signal: "create", rationale: "seeded by test", store: "global" }, toolCtx("ses_seeder"));
};

const seedBehavior = async (situation: string, behavior: string) => {
  const codify = addedTools.find((t) => t.name === "thatch_behavior_codify")!;
  await codify.execute({ situation, behavior, rationale: "seeded by test" }, toolCtx("ses_seeder"));
};

// Seed the recall memory the v1 shared harness seeded at boot: the tool
// embeds "# {label}\n\n{content}", so a prompt must match that full text
// for the hash-based mock to produce a matching vector.
const seedMemory = async () => {
  const remember = addedTools.find((t) => t.name === "thatch_memory_remember")!;
  await remember.execute({ label: "test-coverage", content: "test coverage metrics and gaps", store: "global" }, toolCtx("ses_seeder"));
};

/**
 * Drives one v2 turn: the prompt hook computes the injections, then the
 * context hook applies them to a mocked model request whose user message
 * text matches the prompt (the adapter's binding rule). Returns the
 * injected content parts - on v2 these are plain {type:"text", text} parts
 * appended after the user's own prompt part (v1's synthetic output.parts).
 */
const runTurn = async (sessionID: string, text: string, messageID?: string) => {
  await promptHook!({ sessionID, messageID: messageID ?? `msg_${sessionID}`, prompt: { text } });
  const request = {
    sessionID,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
  await contextHook!(request);
  return (request.messages[0].content as { type: string; text: string }[]).slice(1);
};

describe("recall nudge via the prompt hook", () => {
  test("surfaces a recall nudge when prompt matches a stored memory", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await seedMemory();
    const injections = await runTurn("ses_recall", "# test-coverage\n\ntest coverage metrics and gaps");
    expect(injections.length).toBe(1);
    expect(injections[0].type).toBe("text");
    expect(injections[0].text).toContain("test-coverage");
    expect(injections[0].text).toContain("thatch_memory_recall");
  });

  test("no nudge when prompt does not match any memory", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const injections = await runTurn("ses_no_match", "completely unrelated cooking recipe ideas");
    expect(injections.length).toBe(0);
  });

  test("no nudge for short prompts even if content would match", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await seedMemory();
    const injections = await runTurn("ses_short", "ok");
    expect(injections.length).toBe(0);
  });

  test("task-dispatched sub-agent sessions get no recall nudge", async () => {
    // Task sub-agents (session.created with a parentID, not created by the
    // extraction pipeline) have restricted tool lists that exclude the
    // thatch tools - nudging them only produces "No tool named" error
    // rounds (opencode DB analysis, Sept 2026).
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await seedMemory();
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_subagent_recall",
      info: { id: "ses_subagent_recall", parentID: "ses_subagent_parent" },
    }));

    const injections = await runTurn("ses_subagent_recall", "# test-coverage\n\ntest coverage metrics and gaps");
    expect(injections.length).toBe(0);
  });

  test("task-dispatched sub-agent sessions get no extraction nudge", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_subagent_extract",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_subagent_extract",
      info: { id: "ses_subagent_extract", parentID: "ses_subagent_parent2" },
    }));

    const injections = await runTurn("ses_subagent_extract", "next prompt for the sub-agent session");
    expect(injections.length).toBe(0);
  });

  test("pending extraction does not block the recall nudge (no extraction nudge exists)", async () => {
    // The old extraction nudge took priority and suppressed recall whenever
    // the buffer was non-empty - tool-dense sessions starved recall. With
    // extraction plugin-driven (no nudge), recall fires independently.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_priority",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });

    const injections = await runTurn("ses_priority", "test coverage metrics and gaps");
    // No extraction nudge injection ever appears...
    for (const part of injections) {
      expect(part.text ?? "").not.toContain("thatch-fact-extractor");
    }
    // ...and the buffered interaction is still served for extraction.
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      { session_id: "ses_priority" },
      { sessionID: "ses_ext_priority", agent: "general" },
    );
    expect(String((served as any)?.content ?? "")).toContain("file.txt");
  });
});

describe("prediction auto-fire via the prompt hook", () => {
  test("surfaces a prediction nudge when prompt matches a stored matcher", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const matcher = "untangling a gnarly database migration plan";
    await seedPrediction(matcher, "ask about prod scars and prior migrations before touching the schema");

    const injections = await runTurn("ses_pred_1", matcher);
    expect(injections.length).toBeGreaterThanOrEqual(1);
    const predPart = injections.find((p) => p.text?.includes("User decision model"));
    expect(predPart).toBeDefined();
    expect(predPart!.text).toContain("[thatch]");
    expect(predPart!.text).toContain("you may prefer"); // 0-evidence verb
    // v1 also asserted the part's synthetic flag; v2 injections are plain
    // request content parts - the flag has no v2 subject.
  });

  test("no prediction nudge when prompt matches no matcher above threshold", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const injections = await runTurn("ses_pred_2", "completely unrelated cooking recipe ideas for dinner");
    expect(injections.find((p) => p.text?.includes("User decision model"))).toBeUndefined();
  });

  test("prediction nudge and recall nudge fire independently", async () => {
    // Seed a prediction whose matcher exactly matches the memory's stored
    // text format so both nudges fire from one prompt. The memory was
    // seeded via the thatch_memory_remember tool (which embeds
    // "# {label}\n\n{content}"). Use that same text as the matcher so
    // findMatchers hits cosine ~1.0 with the same prompt text.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const text = "# test-coverage\n\ntest coverage metrics and gaps";
    await seedMemory();
    await seedPrediction(text, "prioritize coverage in CI before merging");

    const injections = await runTurn("ses_pred_combined", text);
    // Both the recall nudge (memory match) and the prediction nudge
    // (matcher match) fire as independent injected parts.
    expect(injections.length).toBeGreaterThanOrEqual(2);
    expect(injections.find((p) => p.text?.includes("thatch_memory_recall"))).toBeDefined();
    expect(injections.find((p) => p.text?.includes("User decision model"))).toBeDefined();
  });
});

describe("behavior auto-fire via the prompt hook", () => {
  test("surfaces a behavior nudge when prompt matches a stored behavior matcher", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const situation = "about to import a new library into a project";
    await seedBehavior(situation, "check the whole codebase for an existing import of that library first");

    const injections = await runTurn("ses_behavior_1", situation);
    expect(injections.length).toBeGreaterThanOrEqual(1);
    const behaviorPart = injections.find((p) => p.text?.includes("Situational behaviors"));
    expect(behaviorPart).toBeDefined();
    expect(behaviorPart!.text).toContain("[thatch]");
    expect(behaviorPart!.text).toContain("consider"); // 0-evidence verb
    // v1 also asserted the part's synthetic flag; v2 injections are plain
    // request content parts - the flag has no v2 subject.
  });

  test("no behavior nudge when prompt matches no behavior matcher above threshold", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const injections = await runTurn("ses_behavior_2", "completely unrelated topic about cooking pasta from scratch");
    expect(injections.find((p) => p.text?.includes("Situational behaviors"))).toBeUndefined();
  });
});

describe("compaction guard on v2", () => {
  // The v2 vehicle for arming the guard: the adapter's compaction hook
  // (session.hook("compaction")) calls the runtime's onSessionCompacting.
  const armCompacting = async (sessionID: string) => {
    await compactionHook!({ sessionID, system: [] });
  };

  test("session.compacted event clears the compacting flag (belt-and-suspenders)", async () => {
    // v2's compaction completion is session.compaction.ended (v1: the
    // session.compacted event, translated by the adapter's pump).
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const matcher = "untangling a gnarly database migration plan";
    await seedPrediction(matcher, "ask about prod scars and prior migrations before touching the schema");
    await armCompacting("ses_guard_evt");

    await queueEvent(sessionEvent("session.compaction.ended", { sessionID: "ses_guard_evt" }));

    const injections = await runTurn("ses_guard_evt", matcher);
    // Flag was cleared by the event, so nudges should fire.
    expect(injections.find((p) => p.text?.includes("User decision model"))).toBeDefined();
  });

  test("compaction failure: a non-compaction prompt clears stale flag and resumes nudges", async () => {
    // Simulate compaction failure: no completion event. The next user
    // message is a regular prompt (v1 detected "not a compaction message"
    // by the absence of a compaction-type part - a part shape the v2 prompt
    // hook cannot produce, so the flag simply clears on the next prompt).
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const matcher = "untangling a gnarly database migration plan";
    await seedPrediction(matcher, "ask about prod scars and prior migrations before touching the schema");
    await armCompacting("ses_guard_fail");

    const injections = await runTurn("ses_guard_fail", matcher);
    // The stale flag was cleared because this is not a compaction message.
    // Nudges should fire (prediction nudge from seeded matcher).
    expect(injections.find((p) => p.text?.includes("User decision model"))).toBeDefined();
  });
});
