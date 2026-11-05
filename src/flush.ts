import { buildExtractionPayload, type ToolInteraction } from "./extraction";
import { peekQueue, getMissedCount, incrementMissedCount, queueFilePath } from "./extract-queue";
import { stampModLiveness } from "./version-check";
import { escalationLevel, extractionNudge, claudeInlineExtraction, claudeWriteNudge, claudeRecallNudge, predictionNudge, behaviorNudge, mcpToolName, chatNotificationNudge } from "./prompts";
import { ensureMcpChatIdentity, mcpChatHookLine, mcpSessionID, isoMinutesAgo, renderChatParticipant, CHAT_CLI_SENDER, CHAT_RENUDGE_MINUTES } from "./chat";
import type { ThatchDB } from "./db";

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

/**
 * The plugin regime's per-prompt stage: the bundled server runs this when
 * the mod calls the plugin_stage tool (one call per prompt.submit) - the
 * flush tiers without the one-shot hook process. Stamps the mod liveness
 * file (the disabled-mod detector), then the same tier order as
 * flush-tools: extraction peek/escalation first, then the
 * recall/prediction/behavior scan on ONE embedding, then the static write
 * fallback. Every tier failure is isolated (try/catch per tier, like the
 * nudge pipeline's contract): a failed recall must not swallow a
 * prediction or kill the write fallback.
 */
export async function computePluginStage(
  deps: {
    db: ThatchDB;
    model: { queryEmbed(text: string): Promise<Float32Array> };
    repo: string;
    dbPath: string;
  },
  prompt: string,
  sessionID: string,
  transcriptPath?: string,
): Promise<string> {
  stampModLiveness(deps.dbPath);

  // The chat identity anchor - the plugin regime's replacement for the
  // fallback hooks' anchor: the stage call runs per prompt from the mod,
  // so it records (server ppid -> session) the same way flush-tools did,
  // and the ensure/adoption keeps the identity + mailbox following the
  // conversation across session forks. The rendered chat line rides on
  // every stage delivery (the model learns who it is without a tool
  // call) - the same line chatHookLine printed in the fallback regime.
  deps.db.recordChatHostPid(process.ppid, mcpSessionID(sessionID));
  const chatLine = ensureMcpChatIdentity(deps.db, sessionID, deps.repo, transcriptPath)
    ? mcpChatHookLine(deps.db, sessionID, deps.repo, transcriptPath)
    : "";

  // Tier 1: extraction - peek, escalate, and deliver the inline payload.
  // The missed-nudge increment lives here now (the mod has no file access,
  // so the hook process's incrementMissedCount call moved server-side).
  let stageText: string | null = null;
  try {
    const interactions = peekQueue(sessionID);
    if (interactions.length > 0) {
      const missed = getMissedCount(sessionID);
      incrementMissedCount(sessionID);
      stageText = buildExtractionStage({ interactions, missedCount: missed, host: "claude-code", sessionID, repo: deps.repo });
    }
  } catch {
    // Extraction is best-effort at stage level: the queues' tiers below
    // still run.
  }

  if (stageText === null) {
    // Tiers 2-4: recall / prediction / behavior on one shared embedding,
    // then the write fallback.
    const promptText = prompt ?? "";
    if (promptText.length >= 10) {
      try {
        const embedding = await deps.model.queryEmbed(promptText);
        const stores = [deps.repo, "global"];
        const parts: string[] = [];
        try {
          const threshold = parseFloat(process.env.THATCH_RECALL_THRESHOLD ?? "0.55");
          const matches = deps.db
            .search(stores, embedding, { limit: 5 })
            .filter((r) => r._score >= threshold)
            .map((r) => ({ label: r.label, score: Math.round(r._score * 1000) / 1000, store: r.store }));
          if (matches.length > 0) parts.push(claudeRecallNudge(matches));
        } catch { /* recall failed - tiers 3-4 still run */ }
        try {
          const threshold = parseFloat(process.env.THATCH_PREDICTION_THRESHOLD ?? "0.60");
          const predictions = deps.db.scorePredictionNudge(stores, embedding, threshold, 5);
          if (predictions.length > 0) parts.push(predictionNudge(predictions, mcpToolName));
        } catch { /* predictions failed - tiers 3-4 still run */ }
        try {
          const threshold = parseFloat(process.env.THATCH_BEHAVIOR_THRESHOLD ?? "0.60");
          const behaviors = deps.db.scoreBehaviorNudge(stores, embedding, threshold, 5);
          if (behaviors.length > 0) parts.push(behaviorNudge(behaviors, mcpToolName));
        } catch { /* behaviors failed - the write fallback still runs */ }
        if (parts.length > 0) stageText = parts.join("\n\n");
      } catch {
        // The embedding itself failed - fall through to the write nudge.
      }
    }
    if (stageText === null) stageText = claudeWriteNudge();
  }

  return chatLine ? `${stageText}\n\n${chatLine}` : stageText;
}

/**
 * The plugin regime's chat wake: the mod polls this (its $.clock.every
 * cadence) and submits the returned nudge as a turn ($.prompt.submit) -
 * the proactive wake delivery that settings hooks could never do (the
 * fallback regime's Stop-hook chat-notify is the turn-end shadow of
 * this). Same re-nudge window and delivered stamps as chat-notify: the
 * window (not model obedience) bounds repeats, and a poll that finds
 * nothing returns "".
 */
export function computePluginChatWake(db: ThatchDB, hostSessionID: string): string {
  const anchor = mcpSessionID(hostSessionID);
  if (!db.findChatSession(anchor)) return "";
  const pending = db
    .pendingChatNotifications([anchor], isoMinutesAgo(CHAT_RENUDGE_MINUTES))
    .filter((m) => m.to_session === anchor);
  if (pending.length === 0) return "";
  const senders = [...new Set(pending.map((m) => renderChatParticipant(m.from_name, m.from_session)))];
  const userRows = pending.filter((m) => m.from_session === CHAT_CLI_SENDER);
  // Stamp before returning: the re-nudge window (not model obedience)
  // bounds repeats when the mail goes ignored.
  db.markChatDelivered(pending.map((m) => m.id));
  return chatNotificationNudge(senders, pending.length, {
    fromUser: userRows.length > 0,
    mixed: userRows.length > 0 && userRows.length < pending.length,
  });
}
