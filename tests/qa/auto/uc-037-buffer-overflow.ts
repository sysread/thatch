import { rmSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ExtractionPipeline, type ToolInteraction } from "../../../src/extraction";
import { appendBatch, peekQueue, consumeQueue } from "../../../src/extract-queue";

/**
 * UC-037: Buffer overflow.
 *
 * Automatable: the ring buffer (ExtractionPipeline, cap 20) and file-backed
 * queue (appendBatch, MAX_BUFFER=20) are pure in-memory/file operations.
 * This test pushes 25 interactions through each path and verifies only the
 * last 20 survive, plus per-session independence.
 */

function makeInteraction(sessionID: string, i: number): ToolInteraction {
  return {
    tool: "bash",
    sessionID,
    args: { command: `cmd-${i}` },
    title: `title-${i}`,
    output: `output-${i}`,
  };
}

const useCase: UseCase = {
  name: "UC-037-buffer-overflow",
  preconditions: [
    "- Thatch active in a session (opencode or MCP host)",
    "- THATCH_QUEUE_DIR set to an isolated temp directory (for the MCP path)",
  ].join("\n"),
  steps: [
    "1. Generate more than 20 non-thatch tool interactions in a single session without triggering extraction.",
    "2. Check the buffer contents.",
    "3. Generate interactions in a second session and verify independence.",
  ].join("\n"),
  expected: [
    "- The buffer holds exactly 20 interactions — the oldest entries are dropped.",
    "- The surviving 20 are the most recent interactions, in order.",
    "- The cap is per-session: a second session's buffer is independent and also caps at 20.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const queueDir = join(ctx.dir, "uc037-queue");
    const origQueueDir = process.env.THATCH_QUEUE_DIR;
    process.env.THATCH_QUEUE_DIR = queueDir;
    const failures: string[] = [];

    try {
      // --- opencode path: ExtractionPipeline ring buffer caps at 20 ---
      {
        const pipeline = new ExtractionPipeline();
        const sessionID = "opencode-session";
        for (let i = 0; i < 25; i++) {
          pipeline.push(makeInteraction(sessionID, i));
        }
        const buf = pipeline.peek(sessionID);
        if (buf.length !== 20) {
          failures.push(`ExtractionPipeline: expected 20, got ${buf.length}`);
        } else {
          // Oldest 5 dropped; first surviving entry is index 5.
          if (buf[0].title !== "title-5") {
            failures.push(`ExtractionPipeline: oldest not dropped (first was ${buf[0].title})`);
          }
          if (buf[19].title !== "title-24") {
            failures.push(`ExtractionPipeline: newest missing (last was ${buf[19].title})`);
          }
        }

        // Per-session independence: a second session is independent.
        const session2 = "opencode-session-2";
        for (let i = 0; i < 10; i++) {
          pipeline.push(makeInteraction(session2, i));
        }
        const buf2 = pipeline.peek(session2);
        if (buf2.length !== 10) {
          failures.push(`ExtractionPipeline session-2: expected 10, got ${buf2.length}`);
        }
        // First session still has 20.
        if (pipeline.peek(sessionID).length !== 20) {
          failures.push("ExtractionPipeline: session-2 affected session-1 buffer");
        }
      }

      // --- MCP path: appendBatch file-backed queue caps at 20 ---
      {
        const sessionID = "mcp-session";
        const calls = [];
        for (let i = 0; i < 25; i++) {
          calls.push({
            tool_name: "read",
            tool_input: { filePath: `/tmp/file${i}.txt` },
            tool_response: `content ${i}`,
          });
        }
        appendBatch(sessionID, calls);
        const queue = peekQueue(sessionID);
        if (queue.length !== 20) {
          failures.push(`appendBatch: expected 20, got ${queue.length}`);
        } else {
          // Oldest 5 dropped; first surviving entry is file5.
          if (queue[0].args.filePath !== "/tmp/file5.txt") {
            failures.push(`appendBatch: oldest not dropped (first was ${queue[0].args.filePath})`);
          }
          if (queue[19].args.filePath !== "/tmp/file24.txt") {
            failures.push(`appendBatch: newest missing (last was ${queue[19].args.filePath})`);
          }
        }
        consumeQueue(sessionID);
      }

      // --- MCP path: per-session independence ---
      {
        const s1 = "mcp-session-a";
        const s2 = "mcp-session-b";
        appendBatch(s1, [{
          tool_name: "read",
          tool_input: { filePath: "/tmp/a.txt" },
          tool_response: "a",
        }]);
        for (let i = 0; i < 25; i++) {
          appendBatch(s2, [{
            tool_name: "read",
            tool_input: { filePath: `/tmp/b${i}.txt` },
            tool_response: `b${i}`,
          }]);
        }
        if (peekQueue(s1).length !== 1) {
          failures.push(`appendBatch: session s1 expected 1, got ${peekQueue(s1).length}`);
        }
        if (peekQueue(s2).length !== 20) {
          failures.push(`appendBatch: session s2 expected 20, got ${peekQueue(s2).length}`);
        }
        consumeQueue(s1);
        consumeQueue(s2);
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
