import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_DEFS } from "../src/tool-defs";
import { extractionNudge } from "../src/prompts";
import { appendBatch, peekQueue, getMissedCount, incrementMissedCount, type BatchToolCall } from "../src/extract-queue";

// Simulates the tool lookup that src/mcp.ts:dispatch performs against the
// frozen tool map compiled at server startup (mcp.ts:compileTools). A real
// MCP server builds this map once from TOOL_DEFS and never reloads it.
function makeServerToolSet(defs: typeof TOOL_DEFS): Set<string> {
  return new Set(defs.map((d) => d.name));
}

// The bare tool names a model would extract from the nudge text. The MCP
// host strips the mcp__thatch__ prefix when dispatching tools/call, so the
// server receives the bare name (e.g. "get_extraction_payload").
function extractToolNamesFromNudge(nudge: string): string[] {
  const names: string[] = [];
  const re = /mcp__thatch__(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(nudge)) !== null) {
    names.push(m[1]);
  }
  return [...new Set(names)];
}

function call(
  name: string,
  input: Record<string, unknown> = {},
  response: string | unknown[] = "",
  id = `toolu_${Math.random().toString(36).slice(2)}`,
): BatchToolCall {
  return { tool_name: name, tool_input: input, tool_use_id: id, tool_response: response };
}

let dir: string;
let originalQueueDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thatch-skew-"));
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

describe("hook/server version skew (issue #6)", () => {
  // The original 8 tools that a pre-extraction thatch MCP server exposed.
  // These match what a session started before extraction_done and
  // get_extraction_payload were added would have in its frozen tool map.
  const OLD_SERVER_TOOLS = [
    "memory_remember",
    "memory_recall",
    "memory_list",
    "memory_show",
    "memory_forget",
    "store_list",
    "find_duplicates",
    "dedup_mark_checked",
  ];

  test("TOOL_DEFS has more tools than the old server set", () => {
    expect(TOOL_DEFS.length).toBeGreaterThan(OLD_SERVER_TOOLS.length);
  });

  test("extraction tools exist in current TOOL_DEFS but not the old server set", () => {
    const currentNames = TOOL_DEFS.map((d) => d.name);
    expect(currentNames).toContain("extraction_done");
    expect(currentNames).toContain("get_extraction_payload");
    expect(OLD_SERVER_TOOLS).not.toContain("extraction_done");
    expect(OLD_SERVER_TOOLS).not.toContain("get_extraction_payload");
  });

  test("nudge references tools the old server does not have", () => {
    // Simulate buffer-batch: tool calls arrive and get queued.
    appendBatch("skew-session", [
      call("Read", { file_path: "/src/app.ts" }, "const x = 1;"),
      call("Bash", { command: "npm test" }, "all tests passed"),
    ]);

    // Simulate flush-tools: peek the queue, generate the extraction nudge.
    const interactions = peekQueue("skew-session");
    expect(interactions.length).toBe(2);

    const nudge = extractionNudge(
      interactions.length,
      0,
      "mcp__thatch__memory_remember",
      "skew-session",
    );

    // The nudge tells the model to call extraction tools.
    const referencedTools = extractToolNamesFromNudge(nudge);
    expect(referencedTools).toContain("get_extraction_payload");
    expect(referencedTools).toContain("extraction_done");

    // The old running MCP server (frozen at session start) does not have these.
    const oldServer = makeServerToolSet(
      TOOL_DEFS.filter((d) => OLD_SERVER_TOOLS.includes(d.name)),
    );
    for (const toolName of referencedTools) {
      expect(oldServer.has(toolName)).toBe(false);
    }
  });

  test("model calling the referenced tools against the old server returns 'Unknown tool'", () => {
    appendBatch("skew-session", [
      call("Read", { file_path: "/a" }, "content"),
    ]);

    const nudge = extractionNudge(
      1,
      0,
      "mcp__thatch__memory_remember",
      "skew-session",
    );

    const referencedTools = extractToolNamesFromNudge(nudge);
    const oldServer = makeServerToolSet(
      TOOL_DEFS.filter((d) => OLD_SERVER_TOOLS.includes(d.name)),
    );

    // Simulate what mcp.ts:dispatch does when the model calls a tool the
    // server doesn't have: return "Unknown tool: <name>" (mcp.ts:270).
    for (const toolName of referencedTools) {
      const exists = oldServer.has(toolName);
      if (!exists) {
        const errorResponse = `Unknown tool: ${toolName}`;
        expect(errorResponse).toContain("Unknown tool");
        expect(errorResponse).toContain(toolName);
      } else {
        // If the old server somehow has the tool, the skew doesn't manifest.
        // This branch should not be reached for the referenced extraction tools.
        expect.unreachable();
      }
    }
  });

  test("missed-nudge counter escalates when the model cannot satisfy the nudge", () => {
    // The queue persists because the model never calls memory_remember or
    // extraction_done (it can't: the old server doesn't have them). Each
    // flush-tools invocation increments the missed counter.
    appendBatch("escalation-session", [
      call("Read", { file_path: "/a" }, "content"),
    ]);

    // Simulate 4 consecutive UserPromptSubmit hooks (4 user prompts).
    for (let i = 0; i < 4; i++) {
      const interactions = peekQueue("escalation-session");
      if (interactions.length > 0) {
        const missed = getMissedCount("escalation-session");
        incrementMissedCount("escalation-session");

        const nudge = extractionNudge(
          interactions.length,
          missed,
          "mcp__thatch__memory_remember",
          "escalation-session",
        );

        // Verify the escalation tiers match the expected behavior.
        if (missed >= 3) {
          // ALL-CAPS shouting tier
          expect(nudge).toContain("YOU ARE IGNORING EXTRACTION INSTRUCTIONS");
        } else if (missed >= 2) {
          // Insistent tier
          expect(nudge).toContain("YOU HAVE NOT PROCESSED");
        } else {
          // Polite tier (missed 0 and 1)
          expect(nudge).toContain("Spawn a background sub-agent");
        }
      }
    }

    // The queue is never consumed because the model cannot call the tools.
    expect(peekQueue("escalation-session").length).toBeGreaterThan(0);
    expect(getMissedCount("escalation-session")).toBe(4);
  });

  test("current server has all tools the nudge references (no skew at same version)", () => {
    // Control case: when the server and hooks are the same version,
    // all referenced tools exist. This proves the bug is specifically
    // about version skew, not about missing tools in general.
    appendBatch("same-version", [
      call("Read", { file_path: "/a" }, "content"),
    ]);

    const nudge = extractionNudge(
      1,
      0,
      "mcp__thatch__memory_remember",
      "same-version",
    );

    const referencedTools = extractToolNamesFromNudge(nudge);
    const currentServer = makeServerToolSet(TOOL_DEFS);

    for (const toolName of referencedTools) {
      expect(currentServer.has(toolName)).toBe(true);
    }
  });
});
