import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBatch, flushQueue, queueDir, type BatchToolCall } from "../src/extract-queue";
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