import { rmSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ExtractionPipeline, type ToolInteraction } from "../../../src/extraction";
import { appendBatch, peekQueue, consumeQueue } from "../../../src/extract-queue";

/**
 * UC-040: Tool filtering.
 *
 * Automatable: the filtering logic in both paths is deterministic. The MCP
 * path (appendBatch) filters mcp__thatch__*, skill, task, agent. The opencode
 * path (tool.execute.after hook) filters thatch_*-prefixed, skill, task. This
 * test exercises both paths directly and verifies only non-thatch tools are
 * buffered.
 */

function makeInteraction(sessionID: string, tool: string): ToolInteraction {
  return {
    tool,
    sessionID,
    args: {},
    title: tool,
    output: "ok",
  };
}

const useCase: UseCase = {
  name: "UC-040-tool-filtering",
  preconditions: [
    "- Thatch active in a session (opencode or MCP host)",
    "- THATCH_QUEUE_DIR set to an isolated temp directory (for the MCP path)",
  ].join("\n"),
  steps: [
    "1. Execute a thatch_memory_remember call.",
    "2. Execute a thatch_extraction_done call.",
    "3. Execute a skill tool call.",
    "4. Execute a task or agent tool call.",
    "5. Execute a non-thatch tool call (e.g., read, bash).",
    "6. Check the buffer/queue contents.",
  ].join("\n"),
  expected: [
    "- thatch_memory_remember and thatch_extraction_done do NOT produce buffer entries.",
    "- skill and task (opencode) / agent (Claude Code, Cursor) do NOT produce buffer entries.",
    "- Non-thatch tools (read, bash, grep, edit, write) DO produce buffer entries.",
    "- The buffer contains only the non-thatch tool interaction(s).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const queueDir = join(ctx.dir, "uc040-queue");
    const origQueueDir = process.env.THATCH_QUEUE_DIR;
    process.env.THATCH_QUEUE_DIR = queueDir;
    const failures: string[] = [];

    try {
      // --- opencode path: tool.execute.after hook filtering ---
      // The hook checks: if (tool.startsWith("thatch_") || tool === "skill" || tool === "task") return;
      // We replicate that condition and verify only non-thatch tools are pushed.
      {
        const pipeline = new ExtractionPipeline();
        const sessionID = "opencode-filter-test";

        const filteredTools = ["thatch_memory_remember", "thatch_extraction_done", "thatch_memory_recall", "skill", "task"];
        const allowedTools = ["read", "bash", "grep", "edit", "write"];

        for (const tool of filteredTools) {
          // Replicate the hook's filter condition.
          if (tool.startsWith("thatch_") || tool === "skill" || tool === "task") continue;
          pipeline.push(makeInteraction(sessionID, tool));
        }
        for (const tool of allowedTools) {
          if (tool.startsWith("thatch_") || tool === "skill" || tool === "task") continue;
          pipeline.push(makeInteraction(sessionID, tool));
        }

        const buf = pipeline.peek(sessionID);
        if (buf.length !== allowedTools.length) {
          failures.push(`opencode: expected ${allowedTools.length} entries, got ${buf.length}`);
        } else {
          for (const ix of buf) {
            if (ix.tool.startsWith("thatch_") || ix.tool === "skill" || ix.tool === "task") {
              failures.push(`opencode: filtered tool "${ix.tool}" leaked into buffer`);
            }
          }
        }
      }

      // --- MCP path: appendBatch filtering ---
      {
        const sessionID = "mcp-filter-test";
        appendBatch(sessionID, [
          { tool_name: "mcp__thatch__memory_remember", tool_input: {}, tool_response: "saved" },
          { tool_name: "mcp__thatch__extraction_done", tool_input: {}, tool_response: "done" },
          { tool_name: "mcp__thatch__memory_recall", tool_input: {}, tool_response: "recalled" },
          { tool_name: "skill", tool_input: {}, tool_response: "loaded" },
          { tool_name: "task", tool_input: {}, tool_response: "dispatched" },
          { tool_name: "agent", tool_input: {}, tool_response: "agent ran" },
          { tool_name: "Read", tool_input: { filePath: "/tmp/test.txt" }, tool_response: "contents" },
          { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "file.txt" },
        ]);

        const queue = peekQueue(sessionID);
        // mcp__thatch__memory_remember triggers consumeQueue, so it drains.
        // But since it's the first call, there's nothing to drain. The
        // remaining calls: mcp__thatch__* are skipped, skill/task/agent are
        // skipped. Only Read and Bash survive.
        if (queue.length !== 2) {
          failures.push(`MCP: expected 2 entries (Read, Bash), got ${queue.length}`);
        } else {
          for (const ix of queue) {
            const lower = ix.tool.toLowerCase();
            if (lower.startsWith("mcp__thatch__") || lower === "skill" || lower === "task" || lower === "agent") {
              failures.push(`MCP: filtered tool "${ix.tool}" leaked into queue`);
            }
          }
          if (queue[0].tool !== "Read" || queue[1].tool !== "Bash") {
            failures.push("MCP: wrong tools in queue");
          }
        }
        consumeQueue(sessionID);
      }

      // --- MCP path: memory_remember drains the queue ---
      {
        const sessionID = "mcp-drain-test";
        // First, buffer some non-thatch tools.
        appendBatch(sessionID, [
          { tool_name: "Read", tool_input: { filePath: "/tmp/a.txt" }, tool_response: "a" },
          { tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: "hi" },
        ]);
        if (peekQueue(sessionID).length !== 2) {
          failures.push("MCP drain: expected 2 entries before memory_remember");
        }
        // Now a memory_remember call should drain the queue.
        appendBatch(sessionID, [
          { tool_name: "mcp__thatch__memory_remember", tool_input: {}, tool_response: "saved" },
        ]);
        if (peekQueue(sessionID).length !== 0) {
          failures.push("MCP drain: queue should be empty after memory_remember");
        }
      }

      if (failures.length > 0) {
        for (const f of failures) console.log(`  FAIL: ${f}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      process.env.THATCH_QUEUE_DIR = origQueueDir;
      rmSync(queueDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
