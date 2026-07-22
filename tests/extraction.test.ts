import { describe, test, expect } from "bun:test";
import { ExtractionPipeline, type ToolInteraction } from "../src/extraction";

describe("ExtractionPipeline", () => {
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
