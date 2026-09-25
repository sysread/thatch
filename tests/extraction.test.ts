import { describe, test, expect } from "bun:test";
import { ExtractionPipeline, unwrapExecuteThatchCalls, type ToolInteraction } from "../src/extraction";

const ix = (sessionID: string): ToolInteraction => ({
  tool: "bash",
  sessionID,
  args: { command: "echo hi" },
  title: "echo hi",
  output: "hi",
});

describe("ExtractionPipeline", () => {
  test("requeueStaleAccepted requeues accepted entries past the age", () => {
    const pipeline = new ExtractionPipeline();
    pipeline.push(ix("ses_s"));
    pipeline.accept("ses_s");
    // A fresh accept is inside any reasonable age bound - left alone.
    expect(pipeline.requeueStaleAccepted(60_000)).toEqual([]);
    expect(pipeline.pending("ses_s")).toBe(false); // still accepted, quiet
    // Past the age (negative = everything is stale): requeued to pending,
    // accepted cleared - the nudge replays and the entries are honestly
    // re-extracted.
    expect(pipeline.requeueStaleAccepted(-1)).toEqual(["ses_s"]);
    expect(pipeline.pending("ses_s")).toBe(true);
    expect(pipeline.peek("ses_s")).toHaveLength(1);
    // Requeueing twice does not duplicate.
    expect(pipeline.requeueStaleAccepted(-1)).toEqual([]);
  });

  test("constructor creates an empty pipeline", () => {
    const pipeline = new ExtractionPipeline();
    expect(pipeline.pending("session-1")).toBe(false);
  });

  test("push adds an interaction", () => {
    const pipeline = new ExtractionPipeline();
    pipeline.push({
      tool: "bash",
      sessionID: "session-1",
      args: { command: "ls" },
      title: "list files",
      output: "file1.txt\nfile2.txt",
    });
    expect(pipeline.pending("session-1")).toBe(true);
  });

  test("peek returns interactions and consume clears buffer", () => {
    const pipeline = new ExtractionPipeline();
    pipeline.push({
      tool: "bash",
      sessionID: "session-1",
      args: { command: "ls" },
      title: "list files",
      output: "output",
    });

    const batch = pipeline.peek("session-1");
    expect(batch.length).toBe(1);
    expect(batch[0].tool).toBe("bash");
    expect(pipeline.pending("session-1")).toBe(true);

    pipeline.consume("session-1");
    expect(pipeline.pending("session-1")).toBe(false);
  });

  test("peek returns empty array for unknown session", () => {
    const pipeline = new ExtractionPipeline();
    const batch = pipeline.peek("unknown");
    expect(batch.length).toBe(0);
  });

  test("pending returns false for unknown session", () => {
    const pipeline = new ExtractionPipeline();
    expect(pipeline.pending("unknown")).toBe(false);
  });

  test("buildPayload serializes interactions", () => {
    const pipeline = new ExtractionPipeline();
    const interactions = [
      {
        tool: "bash",
        sessionID: "session-1",
        args: { command: "ls" },
        title: "list files",
        output: "file1.txt",
      },
    ];

    const payload = pipeline.buildPayload(interactions, "test/repo");
    const parsed = JSON.parse(payload);

    expect(parsed.projectStore).toBe("test/repo");
    expect(parsed.globalStore).toBe("global");
    expect(parsed.interactions.length).toBe(1);
    expect(parsed.interactions[0].tool).toBe("bash");
  });

  test("buffers are scoped per session", () => {
    const pipeline = new ExtractionPipeline();

    pipeline.push({
      tool: "bash",
      sessionID: "session-a",
      args: {},
      title: "a",
      output: "a",
    });

    pipeline.push({
      tool: "bash",
      sessionID: "session-b",
      args: {},
      title: "b",
      output: "b",
    });

    expect(pipeline.pending("session-a")).toBe(true);
    expect(pipeline.pending("session-b")).toBe(true);

    const batchA = pipeline.peek("session-a");
    expect(batchA.length).toBe(1);
    pipeline.consume("session-a");
    expect(pipeline.pending("session-a")).toBe(false);
    expect(pipeline.pending("session-b")).toBe(true);
  });

  test("buffer respects max size", () => {
    const pipeline = new ExtractionPipeline();

    // Push more than the max buffer size (20)
    for (let i = 0; i < 25; i++) {
      pipeline.push({
        tool: "bash",
        sessionID: "session-1",
        args: { command: `cmd-${i}` },
        title: `title-${i}`,
        output: `output-${i}`,
      });
    }

    const batch = pipeline.peek("session-1");
    expect(batch.length).toBe(20); // capped at max
    expect(batch[0].args.command).toBe("cmd-5"); // oldest 5 dropped
  });

  test("buildPayload exercises all summarizeArgs branches", () => {
    const pipeline = new ExtractionPipeline();

    // Exercise each tool type in summarizeArgs
    const interactions = [
      { tool: "read", sessionID: "s", args: { filePath: "/path" }, title: "t", output: "o" },
      { tool: "bash", sessionID: "s", args: { command: "ls" }, title: "t", output: "o" },
      { tool: "grep", sessionID: "s", args: { pattern: "foo" }, title: "t", output: "o" },
      { tool: "glob", sessionID: "s", args: { pattern: "*.ts" }, title: "t", output: "o" },
      { tool: "edit", sessionID: "s", args: { filePath: "/path" }, title: "t", output: "o" },
      { tool: "write", sessionID: "s", args: { filePath: "/path" }, title: "t", output: "o" },
      { tool: "unknown", sessionID: "s", args: { foo: "bar" }, title: "t", output: "o" },
    ];

    const payload = pipeline.buildPayload(interactions, "test/repo");
    const parsed = JSON.parse(payload);

    expect(parsed.interactions.length).toBe(7);
    expect(parsed.interactions[0].args).toBe("file: /path"); // read
    expect(parsed.interactions[1].args).toBe("ls"); // bash
    expect(parsed.interactions[2].args).toBe("pattern: foo"); // grep
    expect(parsed.interactions[3].args).toBe("pattern: *.ts"); // glob
    expect(parsed.interactions[4].args).toBe("file: /path"); // edit
    expect(parsed.interactions[5].args).toBe("file: /path"); // write
    expect(parsed.interactions[6].args).toContain("foo"); // default (JSON.stringify)
  });

  test("buildPayload truncates long output", () => {
    const pipeline = new ExtractionPipeline();

    const longOutput = "x".repeat(600);
    const interactions = [
      { tool: "bash", sessionID: "s", args: {}, title: "t", output: longOutput },
    ];

    const payload = pipeline.buildPayload(interactions, "test/repo");
    const parsed = JSON.parse(payload);

    expect(parsed.interactions[0].output.length).toBeLessThan(600);
    expect(parsed.interactions[0].output).toContain("...");
  });
});

describe("unwrapExecuteThatchCalls", () => {
  test("detects a wrapped thatch tool and reports no overwrite", () => {
    const result = unwrapExecuteThatchCalls({
      code: `const done = await tools.thatch_extraction_done({ session_id: "ses_x" });\nreturn done;`,
    });
    expect(result.tools).toEqual(["thatch_extraction_done"]);
    expect(result.overwrite).toBe(false);
  });

  test("detects multiple distinct wrapped tools in first-appearance order", () => {
    const result = unwrapExecuteThatchCalls({
      code: `await tools.thatch_memory_remember({ text: "..." });\nawait tools.thatch_extraction_done({});`,
    });
    expect(result.tools).toEqual(["thatch_memory_remember", "thatch_extraction_done"]);
  });

  test("dedupes repeated invocations of the same tool", () => {
    const result = unwrapExecuteThatchCalls({
      code: `await tools.thatch_memory_recall({ query: "a" });\nawait tools.thatch_memory_recall({ query: "b" });`,
    });
    expect(result.tools).toEqual(["thatch_memory_recall"]);
  });

  test("detects overwrite: true inside the code string", () => {
    const result = unwrapExecuteThatchCalls({
      code: `await tools.thatch_memory_remember({ text: "x", overwrite: true });`,
    });
    expect(result.tools).toEqual(["thatch_memory_remember"]);
    expect(result.overwrite).toBe(true);
  });

  test("detects the bracket form of wrapped thatch tools", () => {
    // tools["thatch_extraction_done"] used to slip past the dot-form regex
    // and re-open the dispatch/ack loop through the buffer.
    const result = unwrapExecuteThatchCalls({
      code: `await tools["thatch_extraction_done"]({ session_id: "ses_parent" });`,
    });
    expect(result.tools).toEqual(["thatch_extraction_done"]);
    expect(result.sessionID).toBe("ses_parent");
  });

  test("captures the session_id of a wrapped extraction_done", () => {
    const result = unwrapExecuteThatchCalls({
      code: `const r = await tools.thatch_extraction_done({ session_id: "ses_parent" });\nreturn r;`,
    });
    expect(result.sessionID).toBe("ses_parent");
  });

  test("sessionID is undefined when the wrapped done carries none", () => {
    const result = unwrapExecuteThatchCalls({
      code: `await tools.thatch_extraction_done({});`,
    });
    expect(result.sessionID).toBeUndefined();
  });

  test("ignores overwrite when false or absent", () => {
    const absent = unwrapExecuteThatchCalls({ code: `tools.thatch_memory_show({})` });
    const falsy = unwrapExecuteThatchCalls({ code: `tools.thatch_memory_show({ overwrite: false })` });
    expect(absent.overwrite).toBe(false);
    expect(falsy.overwrite).toBe(false);
  });

  test("returns empty for code that mentions thatch without invoking tools.thatch_*", () => {
    const result = unwrapExecuteThatchCalls({
      code: `console.log("the thatch_extraction_done tool is nice")`,
    });
    expect(result.tools).toEqual([]);
  });

  test("returns empty for non-execute-shaped args", () => {
    expect(unwrapExecuteThatchCalls(undefined).tools).toEqual([]);
    expect(unwrapExecuteThatchCalls({ command: "ls" }).tools).toEqual([]);
    expect(unwrapExecuteThatchCalls({ code: 42 }).tools).toEqual([]);
  });

  test("plain execute calls without thatch content signal normal buffering", () => {
    const result = unwrapExecuteThatchCalls({
      code: `const r = await fetch("https://example.com");\nreturn r.status;`,
    });
    expect(result.tools).toEqual([]);
  });
});

describe("ExtractionPipeline.consumeSnapshot", () => {
  function pushN(pipeline: ExtractionPipeline, session: string, n: number): ToolInteraction[] {
    const entries: ToolInteraction[] = [];
    for (let i = 0; i < n; i++) {
      const ix: ToolInteraction = {
        tool: "bash",
        sessionID: session,
        args: { command: `cmd-${i}` },
        title: `title-${i}`,
        output: `output-${i}`,
      };
      entries.push(ix);
      pipeline.push(ix);
    }
    return entries;
  }

  test("removes only snapshot entries, preserving interleaved-turn entries", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    // Parent accumulates 3 entries before dispatching a sub-agent
    pushN(pipeline, session, 3);

    // Snapshot at dispatch time (same references as the buffer entries)
    const snapshot = [...pipeline.peek(session)];
    expect(snapshot.length).toBe(3);

    // Parent makes 2 more tool calls while sub-agent runs (interleaved turn)
    const post = pushN(pipeline, session, 2);
    expect(pipeline.peek(session).length).toBe(5);

    // Sub-agent writes a memory — drain only the snapshot entries
    pipeline.consumeSnapshot(session, snapshot);

    const remaining = pipeline.peek(session);
    expect(remaining.length).toBe(2);
    expect(remaining[0]).toBe(post[0]);
    expect(remaining[1]).toBe(post[1]);
    expect(pipeline.pending(session)).toBe(true);
  });

  test("empty snapshot is a no-op (all entries preserved)", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 3);
    pipeline.consumeSnapshot(session, []);

    expect(pipeline.peek(session).length).toBe(3);
    expect(pipeline.pending(session)).toBe(true);
  });

  test("full snapshot clears the buffer (equivalent to consume)", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 3);
    const snapshot = [...pipeline.peek(session)];
    pipeline.consumeSnapshot(session, snapshot);

    expect(pipeline.pending(session)).toBe(false);
  });

  test("unknown session is a no-op", () => {
    const pipeline = new ExtractionPipeline();
    pipeline.consumeSnapshot("nonexistent", []);
    expect(pipeline.pending("nonexistent")).toBe(false);
  });

  test("handles buffer cap eviction (evicted entries simply not found)", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    // Push 18 entries, take snapshot
    pushN(pipeline, session, 18);
    const snapshot = [...pipeline.peek(session)];

    // Push 10 more — cap at 20 means 8 oldest entries are dropped
    const post = pushN(pipeline, session, 10);
    expect(pipeline.peek(session).length).toBe(20);

    // Drain the snapshot — surviving old entries removed, new entries kept
    pipeline.consumeSnapshot(session, snapshot);

    const remaining = pipeline.peek(session);
    expect(remaining.length).toBe(10);
    expect(remaining.every((ix) => post.includes(ix))).toBe(true);
  });
});

describe("ExtractionPipeline accept/complete/requeue", () => {
  function pushN(pipeline: ExtractionPipeline, session: string, n: number): ToolInteraction[] {
    const entries: ToolInteraction[] = [];
    for (let i = 0; i < n; i++) {
      const ix: ToolInteraction = {
        tool: "bash",
        sessionID: session,
        args: { command: `cmd-${i}` },
        title: `title-${i}`,
        output: `output-${i}`,
      };
      entries.push(ix);
      pipeline.push(ix);
    }
    return entries;
  }

  test("accept moves the buffer to holding: nudge stops, entries kept", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 3);
    pipeline.accept(session);

    expect(pipeline.pending(session)).toBe(false);
    expect(pipeline.peek(session).length).toBe(0);
    expect(pipeline.peekAccepted(session).length).toBe(3);
  });

  test("accept with an empty buffer is a no-op", () => {
    const pipeline = new ExtractionPipeline();
    pipeline.accept("nonexistent");
    expect(pipeline.peekAccepted("nonexistent").length).toBe(0);
  });

  test("accept accumulates across calls", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 2);
    pipeline.accept(session);
    pushN(pipeline, session, 2);
    pipeline.accept(session);

    expect(pipeline.peekAccepted(session).length).toBe(4);
  });

  test("completeAccepted drops held entries", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 3);
    pipeline.accept(session);
    pipeline.completeAccepted(session);

    expect(pipeline.peekAccepted(session).length).toBe(0);
    expect(pipeline.pending(session)).toBe(false);
  });

  test("completeAccepted with nothing held is a no-op", () => {
    const pipeline = new ExtractionPipeline();
    pipeline.completeAccepted("nonexistent");
    expect(pipeline.peekAccepted("nonexistent").length).toBe(0);
  });

  test("requeueAccepted restores entries to pending, ahead of newer arrivals", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    const old = pushN(pipeline, session, 3);
    pipeline.accept(session);
    const newer = pushN(pipeline, session, 2);

    pipeline.requeueAccepted(session);

    expect(pipeline.peekAccepted(session).length).toBe(0);
    const pending = pipeline.peek(session);
    expect(pending.length).toBe(5);
    expect(pending[0]).toBe(old[0]);
    expect(pending[2]).toBe(old[2]);
    expect(pending[3]).toBe(newer[0]);
    expect(pending[4]).toBe(newer[1]);
  });

  test("requeueAccepted with nothing held is a no-op", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 2);
    pipeline.requeueAccepted(session);

    expect(pipeline.peek(session).length).toBe(2);
  });
});
