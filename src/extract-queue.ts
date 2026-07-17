import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveTitle, type ToolInteraction } from "./extraction";

/**
 * File-backed per-session queue of buffered tool interactions. Replaces the
 * opencode plugin's in-memory ExtractionPipeline under Claude Code, where each
 * hook invocation is a fresh process. PostToolBatch writes; UserPromptSubmit reads.
 * The skill consumes the same JSON shape from either path.
 */

const MAX_BUFFER = 20;

/** Shape of a single tool call inside PostToolBatch's `tool_calls` array. */
export interface BatchToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  tool_response: string | unknown[];
}

/** Resolve the queue directory. Override via THATCH_QUEUE_DIR for tests. */
export function queueDir(): string {
  if (process.env.THATCH_QUEUE_DIR) return process.env.THATCH_QUEUE_DIR;
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheHome, "thatch", "queue");
}

/** Sanitize a session id for use as a filename — UUIDs are already safe. */
function safeName(sessionID: string): string {
  return sessionID.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function queuePath(sessionID: string): string {
  return join(queueDir(), `${safeName(sessionID)}.jsonl`);
}

/**
 * Buffer a batch of tool calls for later extraction. Filters out:
 * - thatch's own MCP tools (mcp__thatch__*) to avoid self-echo — extracting
 *   facts from memory operations would just write the store back into itself.
 * - skill/task/agent meta-tools — these orchestrate agent behavior (loading
 *   skills, dispatching sub-agents) and buffering them creates a feedback
 *   loop where the extraction nudge triggers a skill load, which gets
 *   buffered, which triggers another nudge on the next turn.
 * Each surviving call is mapped to a ToolInteraction (title synthesized since
 * Claude Code doesn't supply one) and appended as one JSON line.
 */
export function appendBatch(sessionID: string, toolCalls: BatchToolCall[]): void {
  const dir = queueDir();
  const path = join(dir, `${safeName(sessionID)}.jsonl`);

  const existing = readQueueFile(path);
  const additions: ToolInteraction[] = [];
  for (const tc of toolCalls) {
    const lower = tc.tool_name.toLowerCase();
    if (lower.startsWith("mcp__thatch__")) continue;
    if (lower === "skill" || lower === "task" || lower === "agent") continue;
    const response = typeof tc.tool_response === "string"
      ? tc.tool_response
      : JSON.stringify(tc.tool_response).slice(0, 500);
    additions.push({
      tool: tc.tool_name,
      sessionID,
      args: tc.tool_input ?? {},
      title: deriveTitle(tc.tool_name, tc.tool_input ?? {}),
      output: response,
    });
  }

  const all = [...existing, ...additions].slice(-MAX_BUFFER);
  if (all.length === 0) return;

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, all.map((ix) => JSON.stringify(ix)).join("\n") + "\n");
}

/** Read and delete a session's queue. Returns the buffered interactions in order. */
export function flushQueue(sessionID: string): ToolInteraction[] {
  let path: string;
  try {
    path = queuePath(sessionID);
  } catch {
    return [];
  }
  if (!existsSync(path)) return [];
  const interactions = readQueueFile(path);
  unlinkSync(path);
  return interactions;
}

function readQueueFile(path: string): ToolInteraction[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as ToolInteraction;
      } catch {
        return null;
      }
    })
    .filter((ix): ix is ToolInteraction => ix !== null);
}