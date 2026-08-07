import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import {
  appendBatch,
  peekQueue,
  consumeQueue,
  type BatchToolCall,
} from "../../../src/extract-queue";
import { buildExtractionPayload } from "../../../src/extraction";

/**
 * UC-017: buffer-tool vs buffer-batch contract.
 *
 * Automatable: yes — appendBatch, peekQueue, and consumeQueue are pure
 * file-backed operations. We set THATCH_QUEUE_DIR to an isolated temp dir,
 * then verify: buffer-batch handles a tool_calls array with session_id,
 * buffer-tool handles a single call with conversation_id (both route through
 * appendBatch), mcp__thatch__* calls are filtered, the 20 cap drops oldest,
 * peek does not drain, and consume deletes the queue file.
 */

function makeToolCall(tool: string, response = "ok"): BatchToolCall {
  return {
    tool_name: tool,
    tool_input: { filePath: `/tmp/${tool}.txt` },
    tool_response: response,
  };
}

const useCase: UseCase = {
  name: "UC-017-buffer-tool-vs-buffer-batch",
  preconditions: [
    "- A Claude Code setup (`PostToolBatch` -> `buffer-batch`) and a Cursor setup",
    "  (`postToolUse` -> `buffer-tool`)",
  ].join("\n"),
  steps: [
    "1. **Claude Code**: a `PostToolBatch` fires with a `tool_calls` array (several",
    "   tools, one a `mcp__thatch__*` call) and a `session_id`.",
    "2. **Cursor**: a `postToolUse` fires for a single tool with a `conversation_id`.",
    "3. Run `flush-tools` for both.",
  ].join("\n"),
  expected: [
    "- `buffer-batch` (Claude Code) reads the `tool_calls` array and `session_id`,",
    "  appends all interactions to the session's JSONL queue, filters out",
    "  `mcp__thatch__*` calls, and caps at 20 (oldest dropped). It is **silent**.",
    "- `buffer-tool` (Cursor) reads **one** tool call, normalizes `conversation_id`",
    "  to a safe filename (unsafe chars -> underscore), appends that single",
    "  interaction, filters `mcp__thatch__*`, same 20 cap. Also silent.",
    "- Both write the same `ToolInteraction` shape to the same JSONL format, so",
    "  `flush-tools` drains them identically and `buildExtractionPayload` produces an",
    "  identical contract for the fact-extractor skill.",
    "- Thatch's own tools never appear in either queue (no self-echo feedback loop).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const queueDir = join(ctx.dir, "uc017-queue");
    const origQueueDir = process.env.THATCH_QUEUE_DIR;
    process.env.THATCH_QUEUE_DIR = queueDir;
    const failures: string[] = [];

    try {
      // --- buffer-batch: array of tool_calls with session_id (Claude Code) ---
      {
        const sessionID = "batch-session";
        appendBatch(sessionID, [
          makeToolCall("read"),
          makeToolCall("bash"),
          { tool_name: "mcp__thatch__memory_remember", tool_input: {}, tool_response: "saved" },
          makeToolCall("grep"),
        ]);

        const queue = peekQueue(sessionID);
        // mcp__thatch__memory_remember is filtered out.
        if (queue.length !== 3) {
          failures.push(`buffer-batch: expected 3 interactions (mcp__ filtered), got ${queue.length}`);
        } else {
          if (queue[0].tool !== "read" || queue[1].tool !== "bash" || queue[2].tool !== "grep") {
            failures.push("buffer-batch: wrong tool order or content");
          }
          // Thatch's own tools never appear.
          for (const ix of queue) {
            if (ix.tool.startsWith("mcp__thatch__")) {
              failures.push("buffer-batch: mcp__thatch__ tool leaked into queue");
            }
          }
        }

        // peek does not drain.
        const queue2 = peekQueue(sessionID);
        if (queue2.length !== queue.length) {
          failures.push("buffer-batch: peek drained the queue");
        }

        // Both write the same ToolInteraction shape.
        if (queue.length > 0) {
          const ix = queue[0];
          if (ix.sessionID !== sessionID || !ix.tool || !ix.title || ix.output === undefined) {
            failures.push("buffer-batch: ToolInteraction shape is wrong");
          }
        }

        // buildExtractionPayload produces valid JSON from the queue.
        const payload = buildExtractionPayload(queue, "test-store");
        try {
          const parsed = JSON.parse(payload);
          if (!parsed.interactions || !parsed.projectStore || !parsed.globalStore) {
            failures.push("buildExtractionPayload: missing required fields");
          }
        } catch {
          failures.push("buildExtractionPayload: output is not valid JSON");
        }

        consumeQueue(sessionID);
        if (peekQueue(sessionID).length !== 0) {
          failures.push("buffer-batch: consume did not clear the queue");
        }
      }

      // --- buffer-tool: single tool call with conversation_id (Cursor) ---
      {
        const conversationID = "cursor-conv-123";
        appendBatch(conversationID, [makeToolCall("write", "file written")]);

        const queue = peekQueue(conversationID);
        if (queue.length !== 1) {
          failures.push(`buffer-tool: expected 1 interaction, got ${queue.length}`);
        } else {
          if (queue[0].tool !== "write") {
            failures.push("buffer-tool: wrong tool");
          }
          if (queue[0].sessionID !== conversationID) {
            failures.push("buffer-tool: sessionID does not match conversation_id");
          }
        }

        consumeQueue(conversationID);
      }

      // --- unsafe session ID characters are sanitized to underscores ---
      {
        const unsafeID = "session/with:bad!chars";
        appendBatch(unsafeID, [makeToolCall("read")]);
        // safeName replaces non-alphanumeric chars with _, so the file should
        // exist at "session_with_bad_chars.jsonl".
        const sanitizedFile = join(queueDir, "session_with_bad_chars.jsonl");
        if (!existsSync(sanitizedFile)) {
          failures.push("buffer-tool: unsafe session ID was not sanitized in filename");
        }
        const queue = peekQueue(unsafeID);
        if (queue.length !== 1) {
          failures.push("buffer-tool: could not peek queue with unsafe session ID");
        } else {
          // The sessionID in the ToolInteraction is preserved as-is.
          if (queue[0].sessionID !== unsafeID) {
            failures.push("buffer-tool: sessionID was modified (should be preserved as-is)");
          }
        }
        consumeQueue(unsafeID);
      }

      // --- 20 cap: oldest interactions are dropped ---
      {
        const sessionID = "cap-test";
        const calls: BatchToolCall[] = [];
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
          failures.push(`20 cap: expected 20 interactions, got ${queue.length}`);
        } else {
          // Oldest 5 should be dropped; the queue should start at file5.
          const first = queue[0].args.filePath;
          if (first !== "/tmp/file5.txt") {
            failures.push(`20 cap: oldest entries not dropped (first was ${first})`);
          }
        }
        consumeQueue(sessionID);
      }

      // --- queue persists until consumed ---
      {
        const sessionID = "persist-test";
        appendBatch(sessionID, [makeToolCall("read")]);
        const first = peekQueue(sessionID);
        const second = peekQueue(sessionID);
        if (first.length !== 1 || second.length !== 1) {
          failures.push("queue does not persist across peek calls");
        }
        consumeQueue(sessionID);
        if (peekQueue(sessionID).length !== 0) {
          failures.push("queue still exists after consume");
        }
      }

      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`  FAIL: ${f}`);
        }
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
