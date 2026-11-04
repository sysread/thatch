import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFlushHost, buildExtractionStage, type FlushPayload } from "../src/flush";
import type { ToolInteraction } from "../src/extraction";

let dir: string;
let originalQueueDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thatch-flush-"));
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

describe("detectFlushHost", () => {
  test("session_id means Claude Code", () => {
    expect(detectFlushHost({ session_id: "s1" })).toBe("claude-code");
  });

  test("conversation_id means Cursor", () => {
    expect(detectFlushHost({ conversation_id: "c1" })).toBe("cursor");
  });

  test("session_id wins when both are present", () => {
    expect(detectFlushHost({ session_id: "s1", conversation_id: "c1" })).toBe("claude-code");
  });

  test("neither id returns null (no queue to peek)", () => {
    expect(detectFlushHost({ prompt: "hello" } as FlushPayload)).toBeNull();
  });
});

describe("buildExtractionStage", () => {
  const interactions: ToolInteraction[] = [
    { tool: "Bash", sessionID: "s1", args: { command: "ls" }, title: "ls", output: "file1" },
    { tool: "Read", sessionID: "s1", args: { file_path: "/a" }, title: "a", output: "a" },
  ];

  test("Claude Code takes the inline path: payload delivered, no dispatch instruction", () => {
    const out = buildExtractionStage({ interactions, missedCount: 0, host: "claude-code", sessionID: "s1", repo: "test/repo" });
    expect(out).not.toContain("Spawn a background sub-agent");
    expect(out).toContain("Process the queued tool interactions inline");
    expect(out).toContain("2 queued tool interactions are ready for extraction");
    expect(out).toContain('mcp__thatch__extraction_done with session_id "s1"');
    // The payload itself is delivered: buildExtractionPayload's shape.
    expect(out).toContain('"projectStore":"test/repo"');
    expect(out).toContain('"interactions"');
  });

  test("Cursor keeps the dispatched-extractor nudge (pin)", () => {
    const out = buildExtractionStage({ interactions, missedCount: 0, host: "cursor", sessionID: "s1", repo: "test/repo" });
    expect(out).toContain("Spawn a background sub-agent");
    expect(out).toContain("2 queued tool interactions");
    expect(out).toContain('session_id "s1"');
    expect(out).not.toContain("Process the queued tool interactions inline");
  });

  test("escalation is tone-only for both hosts - the payload is always delivered", () => {
    for (const host of ["claude-code", "cursor"] as const) {
      const polite = buildExtractionStage({ interactions, missedCount: 0, host, sessionID: "s1", repo: "r" });
      const insistent = buildExtractionStage({ interactions, missedCount: 2, host, sessionID: "s1", repo: "r" });
      const shouting = buildExtractionStage({ interactions, missedCount: 3, host, sessionID: "s1", repo: "r" });
      expect(polite).not.toContain("YOU HAVE NOT");
      expect(insistent).toContain("YOU HAVE NOT PROCESSED");
      expect(shouting).toContain("IGNORING EXTRACTION");
      if (host === "claude-code") {
        // Tone-only escalation: the payload body survives shouting, and the
        // identifiers stay verbatim (an uppercased session id drains a
        // nonexistent queue; an uppercased path fails on case-sensitive
        // filesystems).
        expect(shouting).toContain('"interactions"');
        expect(shouting).toContain('session_id "s1"');
        expect(shouting).not.toContain('SESSION_ID');
      }
    }
  });

  test("over-budget output degrades to instructions + queue-file path, never silence", () => {
    // The host caps hook stdout at 10,000 chars; the stage budget is under
    // it. This fixture deterministically exceeds the budget (20
    // interactions x ~900 chars), so the output must be the pointer form:
    // the process instructions with the queue file named, and NO payload
    // body.
    const big: ToolInteraction[] = Array.from({ length: 20 }, (_, i) => ({
      tool: `Tool${i}`,
      sessionID: "cap-s",
      args: { command: `cmd-${i} ${"x".repeat(400)}` },
      title: `tool-${i}`,
      output: "y".repeat(500),
    }));
    const out = buildExtractionStage({ interactions: big, missedCount: 0, host: "claude-code", sessionID: "cap-s", repo: "r" });
    expect(out.length).toBeLessThanOrEqual(9500);
    expect(out).toContain('mcp__thatch__extraction_done with session_id "cap-s"');
    expect(out).toContain("Read that file first");
    expect(out).toContain("queued at");
    expect(out).not.toContain('"interactions"');
  });
});
