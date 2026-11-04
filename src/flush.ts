import { buildExtractionPayload, type ToolInteraction } from "./extraction";
import { queueFilePath } from "./extract-queue";
import { escalationLevel, extractionNudge, claudeInlineExtraction } from "./prompts";

/**
 * The flush-tools stage logic, which lives in src/ because bin/thatch is
 * outside tsconfig and unreachable from bun test - the stages here are the
 * unit-testable decision surface, and bin/thatch stays the dispatcher: it
 * owns stdin/stdout, the sideband round-trips, the chat hook line, and the
 * version-skew file reads. The stages here only decide what the extraction
 * tier prints for a parsed hook payload. --json wrapping and the
 * version-warning/chat-line assembly stay at the dispatch boundary.
 */

/** The MCP hosts that run flush-tools on a per-prompt hook. */
export type FlushHost = "claude-code" | "cursor";

/** The parsed UserPromptSubmit (Claude Code) / beforeSubmitPrompt (Cursor) payload. */
export interface FlushPayload {
  session_id?: string;
  conversation_id?: string;
  transcript_path?: string;
  prompt?: string;
  message?: string;
  text?: string;
  user_input?: string;
  input?: string;
}

/**
 * Host detection from the parsed payload's id fields, matching the two
 * existing in-repo mechanisms (the chat host-pid anchor and the server's
 * project-dir chain): Claude Code payloads carry `session_id`, Cursor
 * payloads `conversation_id`. Null when neither id is present - the caller
 * skips the extraction tier (there is no session to peek a queue for).
 */
export function detectFlushHost(payload: FlushPayload): FlushHost | null {
  if (payload.session_id) return "claude-code";
  if (payload.conversation_id) return "cursor";
  return null;
}

/**
 * The output budget for the extraction stage on Claude Code. Claude Code
 * caps a hook's stdout (and additionalContext) at 10,000 characters and
 * saves over-cap output to a file it never asks the model to read. This
 * budget stays under that cap with headroom for the version warning
 * and chat hook line the dispatcher adds around the stage output.
 */
const INLINE_OUTPUT_BUDGET = 9500;

/**
 * The extraction stage's full output for one flush. `interactions` is the
 * session's queued contents (already peeked by the caller, which also owns
 * the missed-nudge increment - the missedCount here is the PRE-increment
 * count, the same convention extractionNudge has always used).
 *
 * Claude Code takes the INLINE path: the payload is printed with the
 * nudge and the parent processes it in its own context - no sub-agent, no
 * fetch call (the dispatched handshake manufactured the issue #22 nudge
 * loop). When the assembled output would blow the host's stdout cap, the
 * payload body degrades to the queue file's path (the instructions then
 * say to Read it) - delivery degrades to a two-step fetch, never to
 * silence. Cursor keeps the dispatched-extractor handshake.
 */
export function buildExtractionStage(opts: {
  interactions: ToolInteraction[];
  missedCount: number;
  host: FlushHost;
  sessionID: string;
  repo: string;
}): string {
  const { interactions, missedCount, host, sessionID, repo } = opts;
  if (host === "cursor") {
    return extractionNudge(interactions.length, missedCount, sessionID);
  }
  const payload = buildExtractionPayload(interactions, repo);
  const queuePath = queueFilePath(sessionID);
  const level = escalationLevel(missedCount);
  const output = claudeInlineExtraction(interactions.length, sessionID, payload, queuePath, level);
  if (output.length <= INLINE_OUTPUT_BUDGET) return output;
  return claudeInlineExtraction(interactions.length, sessionID, null, queuePath, level);
}
