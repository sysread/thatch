import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { setup } from "../src/opencode/v2";
import {
  addedTools,
  contextHook,
  currentHarness,
  dbDir,
  makeContext,
  promptHook,
  setupTestEnv,
  teardownTestEnv,
  toolAfterHook,
} from "./mocks/opencode-v2-harness";

// The v2 adapter's host-hook wiring: the prompt, context, and execute.after
// hooks - what they inject, what they must NOT inject (stored prompt text,
// stale nudge replay, chat echoes), and the nudge-block binding rules.

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  setupTestEnv();
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  await teardownTestEnv();
});

// Joins the last user message's text parts of a mocked request - the same
// surface the context hook injects into.
function blockTextOf(request: any): string {
  const lastUser = [...request.messages].reverse().find((m: any) => m?.role === "user");
  return (lastUser.content as { type: string; text: string }[])
    .filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

describe("opencode v2 adapter", () => {
  test("system prompt hook injects the thatch system prompt", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // Assert the hook TABLE, not the delegator binding: the delegator is
    // always defined (it reads the table at call time), so the binding
    // assert would be tautological - this one proves setup registered it.
    expect(currentHarness.hooks["context"]).toBeDefined();
    // v2 system parts are {type: "text", text} objects; the adapter must
    // convert the runtime's plain strings before pushing.
    const system: unknown[] = [];
    await contextHook!({ system });
    expect(system.length).toBe(1);
    const part = system[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("Persistence");
    expect(part.text).toContain("thatch_memory_remember");
  });

  test("prompt hook preserves the user's text when nothing fires", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(currentHarness.hooks["prompt"]).toBeDefined();
    const prompt = { text: "remember the thing we discussed about deployment" };
    await promptHook!({ sessionID: "ses_v2_a", messageID: "msg_1", prompt });
    // The runtime buffered no tool interactions, so no extraction nudge
    // fires and no injection appends.
    expect(prompt.text).toBe("remember the thing we discussed about deployment");
  });

  test("nudges stay out of the stored prompt and ride the context hook", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(currentHarness.hooks["execute.after"]).toBeDefined();
    expect(currentHarness.hooks["context"]).toBeDefined();
    // Buffer a tool interaction through the v2 execute.after hook, then
    // send a prompt: nothing may touch prompt.text (v2 stores prompt text
    // as the user message - injecting there would echo any injection into
    // the visible transcript). There is no extraction nudge on opencode at
    // all any more - extraction is plugin-driven at idle.
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_v2_nudge",
      input: { file_path: "/src/app.ts" },
      status: "completed",
      result: { content: "const x = 1;" },
    });
    const prompt = { text: "what do we know about this" };
    await promptHook!({ sessionID: "ses_v2_nudge", messageID: "msg_n", prompt });
    expect(prompt.text).toBe("what do we know about this");

    // The context hook must not inject an extraction nudge into the
    // outbound request either: the model-facing handshake is gone.
    const request = {
      sessionID: "ses_v2_nudge",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "what do we know about this" }] }],
    };
    await contextHook!(request);
    const parts = request.messages[0].content as { type: string; text: string }[];
    expect(parts.length).toBe(1);
    expect(parts[0].text).not.toContain("thatch_get_extraction_payload");
  });

  test("nudge injections are bound to the message they were computed for", async () => {
    // The Oct 2026 staleness report: deleted predictions kept surfacing in
    // the nudge block on later prompts. Mechanism (this test pins it): the
    // context hook injected whatever the prompt hook last stored for the
    // SESSION, so an entry that outlived its turn - prompt hook missed or
    // failed on a later message - replayed a stale block onto a message it
    // was never computed for. The binding check (inject only into a user
    // message whose text equals the prompt the entry was computed from)
    // kills the replay.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const { ThatchDB } = await import("../src/db");
    const { MockEmbeddingModel } = await import("./mocks/embeddings");
    const seedDb = new ThatchDB(join(dbDir, "test.db"));
    const model = new MockEmbeddingModel();
    const MATCHER_TEXT = "deciding whether to post a summary after every review round";
    const P1 = "always post a round summary";
    const P2 = "summarize only after a human review pass";
    const P3 = "post a round summary only for large changes";
    try {
      const matcherId = seedDb.createMatcher("global", MATCHER_TEXT, await model.queryEmbed(MATCHER_TEXT), model.name);
      for (const stmt of [P1, P2]) {
        seedDb.createEdge(matcherId, seedDb.createPrediction("global", stmt, "seed", await model.queryEmbed(stmt), model.name), 1.0);
      }
    } finally {
      seedDb.close();
    }

    // The reported mutation sequence, through the same tool defs the LLM
    // calls: disconfirm one, delete both, create a corrected prediction.
    const runMutations = async () => {
      const update = addedTools.find((t) => t.name === "thatch_prediction_update")!;
      const del = addedTools.find((t) => t.name === "thatch_prediction_delete")!;
      await update.execute({ matcher: MATCHER_TEXT, prediction: P1, signal: "disconfirm", rationale: "user pushed back", store: "global" }, { sessionID: "ses_stale", agent: "build" });
      await del.execute({ statement: P1, store: "global" }, { sessionID: "ses_stale", agent: "build" });
      await del.execute({ statement: P2, store: "global" }, { sessionID: "ses_stale", agent: "build" });
      await update.execute({ matcher: MATCHER_TEXT, prediction: P3, signal: "create", rationale: "corrected preference", store: "global" }, { sessionID: "ses_stale", agent: "build" });
    };
    const requestFor = (text: string) => ({
      sessionID: "ses_stale",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    });
    const blockText = (request: any): string => {
      const lastUser = [...request.messages].reverse().find((m: any) => m?.role === "user");
      return (lastUser.content as { type: string; text: string }[])
        .filter((p) => p.type === "text").map((p) => p.text).join("\n");
    };

    // Turn 1: a matching prompt fires the block.
    await promptHook!({ sessionID: "ses_stale", messageID: "msg_1", prompt: { text: MATCHER_TEXT } });
    const req1 = requestFor(MATCHER_TEXT);
    await contextHook!(req1);
    const block1 = blockText(req1);
    expect(block1).toContain(P1);
    expect(block1).toContain(P2);
    // The block carries its snapshot basis: computed at submission, not
    // refreshed by mid-turn mutations.
    expect(block1).toContain("Snapshot:");

    // Mutate mid-turn.
    await runMutations();

    // Same turn, next round: the prompt-time block is re-served (v1's
    // persistent-synthetic-part semantics), stamped as a snapshot.
    const req1b = requestFor(MATCHER_TEXT);
    await contextHook!(req1b);
    const block1b = blockText(req1b);
    expect(block1b).toContain(P1);
    expect(block1b).toContain("Snapshot:");

    // Turn 2, prompt hook FIRED: fresh recompute - deleted predictions
    // gone, corrected prediction present.
    await promptHook!({ sessionID: "ses_stale", messageID: "msg_2", prompt: { text: MATCHER_TEXT } });
    const req2 = requestFor(MATCHER_TEXT);
    await contextHook!(req2);
    const block2 = blockText(req2);
    expect(block2).not.toContain("always post a round summary\n");
    expect(block2).not.toContain("summarize only after a human review pass");
    expect(block2).toContain(P3);

    // Turn 3, prompt hook MISSED (host did not fire it, or onChatMessage
    // rejected and the hook bailed before refreshing): the turn-1 block
    // must NOT ride onto the new message.
    const req3 = requestFor("a completely different prompt about flaky tests");
    await contextHook!(req3);
    expect(blockText(req3)).toBe("a completely different prompt about flaky tests");
  });

  test("the binding matches the prompt's own message when a user-role reminder lands after it", async () => {
    // opencode's plan plugin splices a user-role reminder into the request
    // via its own context hook: BEFORE the prompt when the request's last
    // message is user-role, but AT THE TAIL when it is not (mid-turn
    // rounds), making the reminder the last user message. The pre-H1
    // binding picked the LAST user message, failed the equality against
    // the reminder, and silently dropped every nudge for the turn.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const { ThatchDB } = await import("../src/db");
    const { MockEmbeddingModel } = await import("./mocks/embeddings");
    const seedDb = new ThatchDB(join(dbDir, "test.db"));
    const model = new MockEmbeddingModel();
    const MATCHER_TEXT = "deciding whether to ship a fix on a Friday afternoon";
    const P1 = "never deploy on a Friday";
    try {
      const matcherId = seedDb.createMatcher("global", MATCHER_TEXT, await model.queryEmbed(MATCHER_TEXT), model.name);
      seedDb.createEdge(matcherId, seedDb.createPrediction("global", P1, "seed", await model.queryEmbed(P1), model.name), 1.0);
    } finally {
      seedDb.close();
    }

    await promptHook!({ sessionID: "ses_reminder", messageID: "msg_r1", prompt: { text: MATCHER_TEXT } });

    const request = {
      sessionID: "ses_reminder",
      system: [],
      messages: [
        { role: "user", content: [{ type: "text", text: MATCHER_TEXT }] },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
        { role: "user", content: [{ type: "text", text: "Plan mode reminder: you are in plan mode" }] },
      ],
    };
    await contextHook!(request);

    // The block rides the PROMPT's message (v1's persistent-synthetic-part
    // parity), not the reminder's.
    const promptParts = (request.messages[0].content as { type: string; text: string }[])
      .filter((p) => p.type === "text").map((p) => p.text);
    expect(promptParts.some((t) => t.includes(P1))).toBe(true);
    const reminderParts = request.messages[2].content as { type: string; text: string }[];
    expect(reminderParts.length).toBe(1);
    expect(reminderParts[0].text).toBe("Plan mode reminder: you are in plan mode");
  });

  test("multi-part user messages reconstruct with the same separator the write side joins with", async () => {
    // The context hook reconstructs a message's text by joining its text
    // parts; the write side joins prompt parts with "\n\n". A separator
    // mismatch between the two joins would fail the equality silently.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const { ThatchDB } = await import("../src/db");
    const { MockEmbeddingModel } = await import("./mocks/embeddings");
    const seedDb = new ThatchDB(join(dbDir, "test.db"));
    const model = new MockEmbeddingModel();
    const MATCHER_TEXT = "ship it\n\nnow";
    const P1 = "never deploy on a Friday";
    try {
      const matcherId = seedDb.createMatcher("global", MATCHER_TEXT, await model.queryEmbed(MATCHER_TEXT), model.name);
      seedDb.createEdge(matcherId, seedDb.createPrediction("global", P1, "seed", await model.queryEmbed(P1), model.name), 1.0);
    } finally {
      seedDb.close();
    }

    await promptHook!({ sessionID: "ses_multipart", messageID: "msg_m1", prompt: { text: MATCHER_TEXT } });

    const request = {
      sessionID: "ses_multipart",
      system: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "ship it" }, { type: "text", text: "now" }] },
      ],
    };
    await contextHook!(request);
    const parts = request.messages[0].content as { type: string; text: string }[];
    expect(parts.some((p) => p.text.includes(P1))).toBe(true);
  });

  test("a prompt queued mid-turn keeps its own entry without evicting the running turn's", async () => {
    // Queued prompts are a first-class workflow (stacked requests): prompt
    // B's hook fires while turn A is still running. A single-slot map
    // replaced turn A's entry, so turn A's remaining rounds lost their
    // block. The per-session set keeps both, matched by text.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const { ThatchDB } = await import("../src/db");
    const { MockEmbeddingModel } = await import("./mocks/embeddings");
    const seedDb = new ThatchDB(join(dbDir, "test.db"));
    const model = new MockEmbeddingModel();
    const MATCHER_A = "deciding whether to post a summary after every review round";
    const MATCHER_B = "choosing a database engine for a new service";
    const PA = "always post a round summary";
    const PB = "prefer Postgres unless the workload is key-value";
    try {
      const mA = seedDb.createMatcher("global", MATCHER_A, await model.queryEmbed(MATCHER_A), model.name);
      seedDb.createEdge(mA, seedDb.createPrediction("global", PA, "seed", await model.queryEmbed(PA), model.name), 1.0);
      const mB = seedDb.createMatcher("global", MATCHER_B, await model.queryEmbed(MATCHER_B), model.name);
      seedDb.createEdge(mB, seedDb.createPrediction("global", PB, "seed", await model.queryEmbed(PB), model.name), 1.0);
    } finally {
      seedDb.close();
    }

    // Turn A round 1: block A.
    await promptHook!({ sessionID: "ses_queue", messageID: "msg_q1", prompt: { text: MATCHER_A } });
    const reqA1 = {
      sessionID: "ses_queue",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: MATCHER_A }] }],
    };
    await contextHook!(reqA1);
    expect(blockTextOf(reqA1)).toContain(PA);

    // Mid-turn queue: prompt B's hook fires while turn A is still running.
    await promptHook!({ sessionID: "ses_queue", messageID: "msg_q2", prompt: { text: MATCHER_B } });

    // Turn A's remaining rounds still get turn A's block.
    const reqA2 = {
      sessionID: "ses_queue",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: MATCHER_A }] }],
    };
    await contextHook!(reqA2);
    expect(blockTextOf(reqA2)).toContain(PA);

    // Turn B's request carries turn A's prompt as history; the newest
    // entry wins, so turn B injects its OWN block, not turn A's.
    const reqB = {
      sessionID: "ses_queue",
      system: [],
      messages: [
        { role: "user", content: [{ type: "text", text: MATCHER_A }] },
        { role: "user", content: [{ type: "text", text: MATCHER_B }] },
      ],
    };
    await contextHook!(reqB);
    const blockB = blockTextOf(reqB);
    expect(blockB).toContain(PB);
    expect(blockB).not.toContain(PA);
  });

  test("prompt hook skips chat echoes (nudge-loop prevention on the v2 path)", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // An echo delivery re-entering the prompt hook (if v2 routes its own
    // synthetic deliveries back through it) must not trigger nudges - the
    // runtime's isChatEchoParts skip covers it, seeded through the same
    // parts shape the adapter builds. The context hook then has no cache
    // entry to inject.
    const prompt = { text: `[chat] al-go-rithm-00001 registered in the session directory` };
    await promptHook!({ sessionID: "ses_v2_echo", messageID: "msg_e", prompt });
    expect(prompt.text).toBe(`[chat] al-go-rithm-00001 registered in the session directory`);
    const request = {
      sessionID: "ses_v2_echo",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "echo" }] }],
    };
    await contextHook!(request);
    expect((request.messages[0].content as unknown[]).length).toBe(1);
  });

  test("tool execute.after hook skips error-status calls", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // An errored tool call must not feed the extraction buffer: the next
    // prompt must fire no extraction nudge (matching v1, whose hook only
    // fired on completed calls).
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_v2_err",
      input: { file_path: "/src/app.ts" },
      status: "error",
      error: { message: "boom" },
    });
    const prompt = { text: "what do we know about this" };
    await promptHook!({ sessionID: "ses_v2_err", messageID: "msg_e2", prompt });
    expect(prompt.text).toBe("what do we know about this");
  });

  test("prompt hook swallows runtime failures instead of rejecting", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // A runtime failure (here: messageID undefined, which the runtime's
    // buffer does not expect) must not reject the host's hook. Drive it
    // with a hook input whose shape the runtime does not expect.
    const prompt = { text: "hello there" };
    await expect(
      promptHook!({ sessionID: "ses_v2_boom", messageID: undefined, prompt }),
    ).resolves.toBeUndefined();
    expect(prompt.text).toBe("hello there");
  });
});
