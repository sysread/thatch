import { describe, test, expect } from "bun:test";
import {
  ExtractionPipeline,
  buildExtractionPayload,
  deriveTitle,
  guardInteractionOutput,
  unwrapExecuteThatchCalls,
  planJournalPrune,
  EXTRACTION_JOURNAL_KINDS,
  INTERACTION_OUTPUT_MAX,
  MEMORY_DISPLAY_MARKER,
  MEMORY_DISPLAY_STAMP,
  MEMORY_WITHHELD_PLACEHOLDER,
  RUNTIME_STATE_TTL_MS,
  type ToolInteraction,
  type JournalRowRef,
} from "../src/extraction";

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

  test("buildPayload covers the opencode v2 path arg spelling", () => {
    const pipeline = new ExtractionPipeline();

    // opencode v2's built-in file tools declare the arg as `path`, so the
    // v2 adapter buffers { path } where v1 sent filePath and Claude Code
    // sends file_path.
    const interactions = [
      { tool: "read", sessionID: "s", args: { path: "/src/app.ts" }, title: "t", output: "o" },
      { tool: "edit", sessionID: "s", args: { path: "/src/app.ts" }, title: "t", output: "o" },
      { tool: "write", sessionID: "s", args: { path: "/src/app.ts" }, title: "t", output: "o" },
    ];

    const payload = pipeline.buildPayload(interactions, "test/repo");
    const parsed = JSON.parse(payload);

    expect(parsed.interactions[0].args).toBe("file: /src/app.ts"); // read
    expect(parsed.interactions[1].args).toBe("file: /src/app.ts"); // edit
    expect(parsed.interactions[2].args).toBe("file: /src/app.ts"); // write
  });

  test("a path arg does not leak into non-file tools' summaries", () => {
    const pipeline = new ExtractionPipeline();

    // `path` is a generic key. Only tools named read/edit/write may read
    // it as the file target: every other case ignores it, and the default
    // branch serializes the whole args, so a path arg still survives
    // there without being relabeled as a file.
    const interactions = [
      { tool: "list", sessionID: "s", args: { path: "/src" }, title: "t", output: "o" },
      { tool: "grep", sessionID: "s", args: { pattern: "foo", path: "/src" }, title: "t", output: "o" },
    ];

    const payload = pipeline.buildPayload(interactions, "test/repo");
    const parsed = JSON.parse(payload);

    expect(parsed.interactions[0].args).toBe('{"path":"/src"}'); // default branch
    expect(parsed.interactions[1].args).toBe("pattern: foo"); // grep branch, path ignored
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

describe("deriveTitle", () => {
  test("derives the basename from every host's file-arg spelling", () => {
    expect(deriveTitle("read", { filePath: "/src/app.ts" })).toBe("app.ts"); // opencode v1
    expect(deriveTitle("Read", { file_path: "/src/app.ts" })).toBe("app.ts"); // Claude Code/Cursor
    expect(deriveTitle("read", { path: "/src/app.ts" })).toBe("app.ts"); // opencode v2
    expect(deriveTitle("edit", { path: "/src/app.ts" })).toBe("app.ts");
    expect(deriveTitle("write", { path: "/src/app.ts" })).toBe("app.ts");
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

describe("ExtractionPipeline claim semantics", () => {
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

  test("claim delivers pending + accepted and holds them for the fetcher", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 3);
    pipeline.accept(session); // parent ack accepted the first 3
    pushN(pipeline, session, 2); // new exhaust after the ack

    const claimed = pipeline.claim(session, "child-1");
    expect(claimed.length).toBe(5);
    expect(pipeline.peek(session).length).toBe(0);
    expect(pipeline.peekAccepted(session).length).toBe(5);
  });

  test("the fetcher's completion consumes only its claim", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 3);
    pipeline.claim(session, "child-1");
    pushN(pipeline, session, 2);
    pipeline.claim(session, "child-2"); // both children hold overlapping sets

    pipeline.completeClaimed("child-1");
    // child-1's claim covered the first 3; child-2's later claim covers all
    // 5, so child-1's completion leaves child-2's claim intact.
    expect(pipeline.peekAccepted(session).length).toBe(2);
  });

  test("a completion from a child with no claim is a no-op - the sibling race", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 3);
    pipeline.accept(session); // parent ack
    pipeline.claim(session, "extractor"); // the extractor fetched

    // A sibling sub-agent (code-review specialist) goes idle. It never
    // fetched a payload; its completion must not drop the accepted set.
    expect(pipeline.completeClaimed("specialist")).toBe(false);
    expect(pipeline.peekAccepted(session).length).toBe(3);
  });

  test("requeue between claim and completion orphans the claim safely", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 3);
    pipeline.claim(session, "child-1");
    pipeline.requeueAccepted(session); // extractor errored; entries back to pending

    expect(pipeline.completeClaimed("child-1")).toBe(true);
    expect(pipeline.peekAccepted(session).length).toBe(0);
    expect(pipeline.peek(session).length).toBe(3); // entries preserved for re-extraction
  });

  test("dropClaim forgets a fetcher's claim on session deletion", () => {
    const pipeline = new ExtractionPipeline();
    const session = "parent";

    pushN(pipeline, session, 2);
    pipeline.claim(session, "child-1");
    pipeline.dropClaim("child-1");

    expect(pipeline.completeClaimed("child-1")).toBe(false);
    expect(pipeline.peekAccepted(session).length).toBe(2);
  });

  test("completing an empty claim is a no-op that still returns true", () => {
    const pipeline = new ExtractionPipeline();
    pipeline.claim("parent", "child-1");
    expect(pipeline.completeClaimed("child-1")).toBe(true);
    expect(pipeline.peekAccepted("parent").length).toBe(0);
  });
});

describe("journal size bounds", () => {
  test("push truncates oversized output before buffering and journaling", () => {
    const journaled: ToolInteraction[] = [];
    const pipeline = new ExtractionPipeline((_kind, _sessionID, value) => {
      if (value) journaled.push(...value);
    });
    const big = "x".repeat(INTERACTION_OUTPUT_MAX * 4);

    pipeline.push({ tool: "read", sessionID: "ses_big", args: { filePath: "/f" }, title: "f", output: big });

    // The buffered interaction and the journaled row both carry the capped
    // shape; the caller's object is untouched.
    expect(pipeline.peek("ses_big")[0].output.length).toBe(INTERACTION_OUTPUT_MAX + 3);
    expect(journaled[0].output.length).toBe(INTERACTION_OUTPUT_MAX + 3);
    expect(big.length).toBe(INTERACTION_OUTPUT_MAX * 4);
  });

  test("push caps oversized string args (execute code, write content) but keeps the Record shape", () => {
    const pipeline = new ExtractionPipeline();
    const code = "y".repeat(INTERACTION_OUTPUT_MAX * 2);
    pipeline.push({ tool: "execute", sessionID: "ses_args", args: { code, n: 7 }, title: "t", output: "ok" });

    const stored = pipeline.peek("ses_args")[0];
    expect(typeof stored.args).toBe("object");
    expect((stored.args as any).code.length).toBe(INTERACTION_OUTPUT_MAX + 3);
    expect((stored.args as any).code.startsWith("yyy")).toBe(true);
    expect((stored.args as any).n).toBe(7);
  });

  test("push passes short output and args through UNCHANGED, same object (identity invariant)", () => {
    const pipeline = new ExtractionPipeline();
    const interaction: ToolInteraction = { tool: "bash", sessionID: "ses_ok", args: { command: "ls" }, title: "t", output: "small" };
    pipeline.push(interaction);
    expect(pipeline.peek("ses_ok")[0]).toBe(interaction);
  });

  test("consumeSnapshot still drains oversized entries (cloned at push) by pipeline identity", () => {
    const pipeline = new ExtractionPipeline();
    pipeline.push({
      tool: "read",
      sessionID: "ses_snap",
      args: { filePath: "/f" },
      title: "f",
      output: "z".repeat(INTERACTION_OUTPUT_MAX * 3),
    });
    // The snapshot is taken from the PIPELINE's objects (peek), the same
    // shape the child-dispatch journal path uses.
    const snapshot = [...pipeline.peek("ses_snap")];
    pipeline.push({ tool: "bash", sessionID: "ses_snap", args: {}, title: "later turn", output: "new" });

    pipeline.consumeSnapshot("ses_snap", snapshot);

    const remaining = pipeline.peek("ses_snap");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe("later turn");
  });

  test("push passes short output through unchanged", () => {
    const pipeline = new ExtractionPipeline();
    pipeline.push({ tool: "bash", sessionID: "ses_ok", args: {}, title: "t", output: "small" });
    expect(pipeline.peek("ses_ok")[0].output).toBe("small");
  });
});

describe("planJournalPrune", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  const opts = { nowMs: now, ttlMs: RUNTIME_STATE_TTL_MS, pathExists: (p: string) => p === "/live" };
  const row = (kind: string, sessionID: string, directory: string, ageMs: number): JournalRowRef => ({
    kind,
    sessionID,
    directory,
    createdAt: new Date(now - ageMs).toISOString(),
  });

  test("dead-directory rows are doomed regardless of age; live fresh rows survive", () => {
    const plan = planJournalPrune(
      [row("buffer", "ses_dead", "/dead", 0), row("buffer", "ses_live", "/live", 0)],
      opts,
    );
    expect(plan.map((r) => r.sessionID)).toEqual(["ses_dead"]);
  });

  test("rows silent past the TTL are doomed even in live directories", () => {
    const plan = planJournalPrune(
      [row("accepted", "ses_old", "/live", RUNTIME_STATE_TTL_MS + 60_000), row("accepted", "ses_new", "/live", 60_000)],
      opts,
    );
    expect(plan.map((r) => r.sessionID)).toEqual(["ses_old"]);
  });

  test("legacy empty-directory rows are exempt from the path check, not doomed by it", () => {
    const plan = planJournalPrune([row("buffer", "ses_legacy", "", 0)], opts);
    expect(plan).toEqual([]);
  });

  test("the startup-resumed session's rows are kept even when dead-dir and TTL would doom them", () => {
    const plan = planJournalPrune(
      [
        row("buffer", "ses_resumed", "/dead", RUNTIME_STATE_TTL_MS * 2),
        row("accepted", "ses_resumed", "/dead", RUNTIME_STATE_TTL_MS * 2),
        row("buffer", "ses_other", "/dead", 0),
      ],
      { ...opts, keepSessionID: "ses_resumed" },
    );
    // The partition deliberately inherited the resumed session's rows for
    // crash recovery; the sweep must not contradict that decision.
    expect(plan.map((r) => r.sessionID)).toEqual(["ses_other"]);
  });

  test("watcher_death rows are exempt from the dead-directory rule; age still dooms them", () => {
    // A stamped death row's consumer (the dead subordinate's coordinator)
    // runs in the MAIN checkout, so a merged-and-deleted worktree must not
    // eat the pickup row before the coordinator's next prompt. Age is the
    // only doom criterion (the global age-out for unpicked rows).
    const plan = planJournalPrune(
      [
        row("watcher_death", "ses_pickup", "/dead", 0),
        row("watcher_death", "ses_aged", "/dead", RUNTIME_STATE_TTL_MS + 60_000),
      ],
      opts,
    );
    expect(plan.map((r) => r.sessionID)).toEqual(["ses_aged"]);
  });

  test("only the extraction journal kinds are in scope by design", () => {
    // Child rows are finalized (with session cleanup) by the rehydration
    // partition; watchers/hosted/wrapup rows own their lifecycles. The
    // watcher_death kind joins the sweep's CALL-SITE list as a global
    // age-only pass (with its own dead-directory exemption), but the
    // extraction module's own constant stays narrow.
    expect(EXTRACTION_JOURNAL_KINDS).toEqual(["buffer", "accepted"]);
  });
});

// ---------------------------------------------------------------------------
// guardInteractionOutput - the display stamp's buffer-side guard
// ---------------------------------------------------------------------------

describe("guardInteractionOutput", () => {
  // Every fixture is composed from the exported constants at runtime: the
  // test file must never contain the marker token at a line start or any
  // literal anchor sequence (the self-collision discipline the guard
  // itself documents - a file that violates it gets its own reads withheld).
  const stamp = MEMORY_DISPLAY_STAMP;
  const token = MEMORY_DISPLAY_MARKER;

  test("line-start marker in raw text is replaced with the placeholder", () => {
    const output = stamp + "\n[sysread/thatch] Some Memory\n\nthe memory body";
    expect(guardInteractionOutput(output)).toBe(MEMORY_WITHHELD_PLACEHOLDER);
  });

  test("line-start marker mid-output (prefix noise before the CLI line) is replaced", () => {
    const output = "preamble\n" + stamp + "\nbody";
    expect(guardInteractionOutput(output)).toBe(MEMORY_WITHHELD_PLACEHOLDER);
  });

  test("a quoted token mid-line is NOT replaced (source and docs quoting the marker)", () => {
    // The repo's own files quote the token constantly; a bare substring
    // match would withhold every thatch-dev session's read of them.
    const quoted = 'export const X = "' + token + '"; // the marker';
    expect(guardInteractionOutput(quoted)).toBe(quoted);
  });

  test("a token at a line start inside a code span is still replaced (column 0 is column 0)", () => {
    const output = "text\n" + token + " tail\nmore";
    expect(guardInteractionOutput(output)).toBe(MEMORY_WITHHELD_PLACEHOLDER);
  });

  test("JSON string-value-open form (compact serialization) is replaced", () => {
    // MCP hosts deliver tool_response as content blocks; the stamp lands
    // at the start of a text value, which serializes as colon-quote-token.
    const blocks = [{ type: "text", text: stamp + "\nmemory body" }];
    expect(guardInteractionOutput(JSON.stringify(blocks))).toBe(MEMORY_WITHHELD_PLACEHOLDER);
  });

  test("JSON string-value-open form tolerates pretty-printed whitespace", () => {
    // `jq .` and JSON.stringify(x, null, 2) emit a space after the colon.
    const blocks = [{ output: stamp + "\nmemory body" }];
    expect(guardInteractionOutput(JSON.stringify(blocks, null, 2))).toBe(MEMORY_WITHHELD_PLACEHOLDER);
  });

  test("escaped-newline form (marker line after other lines in one string value) is replaced", () => {
    const inner = "line one\n" + stamp + "\nmemory body";
    const serialized = JSON.stringify({ output: inner });
    expect(guardInteractionOutput(serialized)).toBe(MEMORY_WITHHELD_PLACEHOLDER);
  });

  test("the escaped-newline form survives depth-2 re-serialization", () => {
    // A JSON embedding of a JSON embedding: the doubly-escaped newline
    // still contains the literal backslash-n before the token, so form 3
    // fires even when form 2's anchor is destroyed by re-escaping.
    const inner = "line one\n" + stamp + "\nmemory body";
    const depth2 = JSON.stringify({ dump: JSON.stringify({ output: inner }) });
    expect(guardInteractionOutput(depth2)).toBe(MEMORY_WITHHELD_PLACEHOLDER);
  });

  test("a bare string-array embedding is NOT replaced (the named residual cousin)", () => {
    const arr = [stamp + "\nmemory body"];
    const serialized = JSON.stringify(arr);
    expect(guardInteractionOutput(serialized)).toBe(serialized);
  });

  test("guarding is idempotent: the placeholder carries no marker form", () => {
    expect(guardInteractionOutput(MEMORY_WITHHELD_PLACEHOLDER)).toBe(MEMORY_WITHHELD_PLACEHOLDER);
  });

  test("buildExtractionPayload guards stamped rows at the funnel (skew-window backstop)", () => {
    // A row written by an un-upgraded buffer side carries the raw stamped
    // output; the funnel swaps it before the extractor ever sees it.
    const stamped: ToolInteraction = {
      tool: "bash",
      sessionID: "ses_skew",
      args: { command: "thatch show X" },
      title: "thatch show X",
      output: stamp + "\n[sysread/thatch] X\n\nthe memory body",
    };
    const payload = JSON.parse(buildExtractionPayload([stamped], "sysread/thatch"));
    expect(payload.interactions[0].output).toBe(MEMORY_WITHHELD_PLACEHOLDER);
    expect(payload.interactions[0].output).not.toContain("the memory body");
  });

  test("the funnel guards before truncating: a marker past char 500 still fires", () => {
    const long = "x".repeat(600) + "\n" + stamp + "\nbody";
    const row: ToolInteraction = {
      tool: "bash",
      sessionID: "ses_skew",
      args: {},
      title: "t",
      output: long,
    };
    const payload = JSON.parse(buildExtractionPayload([row], "sysread/thatch"));
    expect(payload.interactions[0].output).toBe(MEMORY_WITHHELD_PLACEHOLDER);
  });

  test("unstamped output passes through the funnel unchanged (apart from the 500 cap)", () => {
    const row: ToolInteraction = {
      tool: "bash",
      sessionID: "ses_plain",
      args: {},
      title: "t",
      output: "ordinary tool output",
    };
    const payload = JSON.parse(buildExtractionPayload([row], "sysread/thatch"));
    expect(payload.interactions[0].output).toBe("ordinary tool output");
  });
});
