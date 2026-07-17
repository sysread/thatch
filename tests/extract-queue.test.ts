import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBatch, flushQueue, peekQueue, consumeQueue, queueDir, getMissedCount, incrementMissedCount, resetMissedCount, type BatchToolCall } from "../src/extract-queue";
import { buildExtractionPayload } from "../src/extraction";

let dir: string;
let originalQueueDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thatch-queue-"));
  originalQueueDir = process.env.THATCH_QUEUE_DIR;
  process.env.THATCH_QUEUE_DIR = dir;
});

afterEach(() => {
  if (originalQueueDir === undefined) {
    delete process.env.THATCH_QUEUE_DIR;
  } else {
    process.env.THATCH_QUEUE_DIR = originalQueueDir;
  }
  rmSync(dir, { recursive: true, force: true });
});

function call(
  name: string,
  input: Record<string, unknown> = {},
  response: string | unknown[] = "",
  id = `toolu_${Math.random().toString(36).slice(2)}`,
): BatchToolCall {
  return { tool_name: name, tool_input: input, tool_use_id: id, tool_response: response };
}

describe("appendBatch + flushQueue", () => {
  test("empty flush returns no interactions", () => {
    expect(flushQueue("session-1")).toEqual([]);
  });

  test("round-trip a single batch", () => {
    appendBatch("session-1", [
      call("Read", { file_path: "/path/to/extraction.ts" }, "1: export const x = 1;\n"),
    ]);
    const out = flushQueue("session-1");
    expect(out.length).toBe(1);
    expect(out[0].tool).toBe("Read");
    expect(out[0].args).toEqual({ file_path: "/path/to/extraction.ts" });
    expect(out[0].output).toBe("1: export const x = 1;\n");
    expect(out[0].title).toBe("extraction.ts");
  });

  test("filters out mcp__thatch__* tool calls (self-echo prevention)", () => {
    appendBatch("session-1", [
      call("Read", { file_path: "/a" }, "a"),
      call("mcp__thatch__memory_remember", { label: "x" }, "ok"),
      call("mcp__thatch__memory_recall", { query: "y" }, "[]"),
      call("Bash", { command: "ls" }, "file1\n"),
    ]);
    const out = flushQueue("session-1");
    expect(out.length).toBe(2);
    expect(out.map((ix) => ix.tool)).toEqual(["Read", "Bash"]);
  });

  test("filters out skill/task/agent meta-tools (feedback loop prevention)", () => {
    appendBatch("session-1", [
      call("Read", { file_path: "/a" }, "a"),
      call("Skill", { name: "thatch-fact-extractor" }, "loaded"),
      call("Task", { description: "extract" }, "done"),
      call("Agent", { prompt: "extract" }, "done"),
      call("Bash", { command: "ls" }, "file1\n"),
    ]);
    const out = flushQueue("session-1");
    expect(out.length).toBe(2);
    expect(out.map((ix) => ix.tool)).toEqual(["Read", "Bash"]);
  });

  test("appends across multiple PostToolBatch invocations", () => {
    appendBatch("s", [call("Read", { file_path: "/a" }, "a")]);
    appendBatch("s", [call("Bash", { command: "ls" }, "file1")]);
    appendBatch("s", [call("Grep", { pattern: "foo" }, "no matches")]);
    const out = flushQueue("s");
    expect(out.map((ix) => ix.tool)).toEqual(["Read", "Bash", "Grep"]);
  });

  test("flush deletes the file", () => {
    appendBatch("s", [call("Read", { file_path: "/a" }, "a")]);
    const path = join(queueDir(), "s.jsonl");
    expect(existsSync(path)).toBe(true);

    flushQueue("s");
    expect(existsSync(path)).toBe(false);
  });

  test("second flush after delete returns empty", () => {
    appendBatch("s", [call("Read", { file_path: "/a" }, "a")]);
    flushQueue("s");
    expect(flushQueue("s")).toEqual([]);
  });

  test("sessions are isolated (separate files)", () => {
    appendBatch("sess-a", [call("Read", { file_path: "/a" }, "a")]);
    appendBatch("sess-b", [call("Bash", { command: "ls" }, "b")]);
    expect(flushQueue("sess-a").map((ix) => ix.tool)).toEqual(["Read"]);
    expect(flushQueue("sess-b").map((ix) => ix.tool)).toEqual(["Bash"]);
  });

  test("caps queue at 20 entries (oldest dropped)", () => {
    for (let i = 0; i < 25; i++) {
      appendBatch("s", [call("Bash", { command: `cmd-${i}` }, `out-${i}`)]);
    }
    const out = flushQueue("s");
    expect(out.length).toBe(20);
    expect(out[0].args.command).toBe("cmd-5");
    expect(out[19].args.command).toBe("cmd-24");
  });

  test("tool_response array shape stringified and truncated", () => {
    appendBatch("s", [
      call(
        "Read",
        { file_path: "/x" },
        [{ type: "text", text: "x".repeat(600) }],
      ),
    ]);
    const out = flushQueue("s");
    expect(out.length).toBe(1);
    expect(out[0].output.length).toBeLessThanOrEqual(500);
  });

  test("string response is preserved verbatim (truncation happens at payload time)", () => {
    appendBatch("s", [call("Read", { file_path: "/a" }, "hello world")]);
    const out = flushQueue("s");
    expect(out[0].output).toBe("hello world");
  });

  test("compatible with buildExtractionPayload downstream", () => {
    appendBatch("s", [
      call("Read", { file_path: "/a.ts" }, "const x = 1;"),
      call("Bash", { command: "ls" }, "file1\nfile2"),
    ]);
    const interactions = flushQueue("s");
    const payload = buildExtractionPayload(interactions, "test/repo");
    const parsed = JSON.parse(payload);
    expect(parsed.projectStore).toBe("test/repo");
    expect(parsed.globalStore).toBe("global");
    expect(parsed.interactions.length).toBe(2);
    expect(parsed.interactions[0].tool).toBe("Read");
    expect(parsed.interactions[0].title).toBe("a.ts");
  });

  test("skips corrupt JSON lines when reading the queue", () => {
    const path = join(queueDir(), "corrupt.jsonl");
    writeFileSync(path, '{"tool":"Read","sessionID":"s","args":{},"title":"a","output":"ok"}\n{not valid json}\n');
    const out = flushQueue("corrupt");
    expect(out.length).toBe(1);
    expect(out[0].tool).toBe("Read");
  });
});

describe("queueDir", () => {
  test("honors THATCH_QUEUE_DIR override", () => {
    process.env.THATCH_QUEUE_DIR = "/custom/queue";
    expect(queueDir()).toBe("/custom/queue");
  });

  test("falls back to XDG_CACHE_HOME when THATCH_QUEUE_DIR is unset", () => {
    delete process.env.THATCH_QUEUE_DIR;
    process.env.XDG_CACHE_HOME = "/custom/cache";
    expect(queueDir()).toBe(join("/custom/cache", "thatch", "queue"));
    delete process.env.XDG_CACHE_HOME;
  });
});

describe("safe session ids", () => {
  test("unsafe characters are replaced with underscore", () => {
    appendBatch("weird/session id", [call("Read", { file_path: "/a" }, "a")]);
    expect(existsSync(join(queueDir(), "weird_session_id.jsonl"))).toBe(true);
    const out = flushQueue("weird/session id");
    expect(out.length).toBe(1);
  });
});

describe("missed-nudge counter", () => {
  test("starts at 0 for a new session", () => {
    expect(getMissedCount("fresh-session")).toBe(0);
  });

  test("increments and persists across calls", () => {
    incrementMissedCount("inc-session");
    expect(getMissedCount("inc-session")).toBe(1);
    incrementMissedCount("inc-session");
    expect(getMissedCount("inc-session")).toBe(2);
  });

  test("reset deletes the counter file", () => {
    incrementMissedCount("reset-session");
    expect(getMissedCount("reset-session")).toBe(1);
    resetMissedCount("reset-session");
    expect(getMissedCount("reset-session")).toBe(0);
  });

  test("appendBatch resets counter and consumes queue when memory_remember is in the batch", () => {
    incrementMissedCount("echo-session");
    expect(getMissedCount("echo-session")).toBe(1);
    appendBatch("echo-session", [
      call("Read", { file_path: "/a" }, "a"),
    ]);
    expect(peekQueue("echo-session").length).toBe(1);
    appendBatch("echo-session", [
      call("mcp__thatch__memory_remember", { label: "x" }, "ok"),
    ]);
    expect(getMissedCount("echo-session")).toBe(0);
    expect(peekQueue("echo-session").length).toBe(0);
  });
});

describe("peekQueue + consumeQueue", () => {
  test("peek returns interactions without deleting", () => {
    appendBatch("peek-s", [call("Read", { file_path: "/a" }, "a")]);
    const first = peekQueue("peek-s");
    expect(first.length).toBe(1);
    // Second peek sees the same data — not consumed
    const second = peekQueue("peek-s");
    expect(second.length).toBe(1);
  });

  test("consume deletes the queue file", () => {
    appendBatch("consume-s", [call("Read", { file_path: "/a" }, "a")]);
    const path = join(queueDir(), "consume-s.jsonl");
    expect(existsSync(path)).toBe(true);
    consumeQueue("consume-s");
    expect(existsSync(path)).toBe(false);
  });

  test("peek after consume returns empty", () => {
    appendBatch("pc-s", [call("Read", { file_path: "/a" }, "a")]);
    consumeQueue("pc-s");
    expect(peekQueue("pc-s")).toEqual([]);
  });

  test("ignored nudge accumulates — peek sees old + new interactions", () => {
    appendBatch("accum-s", [call("Read", { file_path: "/a" }, "a")]);
    // Nudge fires (peek, no consume) — agent ignores it
    expect(peekQueue("accum-s").length).toBe(1);
    // More tool calls arrive
    appendBatch("accum-s", [call("Bash", { command: "ls" }, "file1")]);
    // Next peek sees both old and new
    const all = peekQueue("accum-s");
    expect(all.length).toBe(2);
    expect(all.map((ix) => ix.tool)).toEqual(["Read", "Bash"]);
  });
});