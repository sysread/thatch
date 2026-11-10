/**
 * The hook-facing subcommands: buffer-batch, buffer-tool, flush-tools,
 * chat-notify, flush-predictions. Each was a case of bin/thatch's switch
 * before the registry replaced it. All are silent-on-success hooks or
 * hook JSON emitters; the shared stdin/debug/emit plumbing comes from
 * createHookHelpers (instantiated per run from ctx.dbPath).
 */
import { repoPathCache } from "../../db";
import { detectRepo } from "../../git";
import {
  mcpSessionID,
  CHAT_RENUDGE_MINUTES,
  CHAT_CLI_SENDER,
  renderChatParticipant,
  isoMinutesAgo,
} from "../../chat";
import { chatEnabled, loadConfig } from "../../config";
import { chatNotificationNudge } from "../../prompts";
import { createHookHelpers } from "../hooks";
import type { Subcommand } from "../types";

export const bufferBatch: Subcommand = {
  name: "buffer-batch",
  summary: "Append a PostToolBatch payload to the queue (Claude Code hook only)",
  usage: () => ({ synopsis: "thatch buffer-batch", flags: [] }),
  async run(_args, ctx) {
    const hh = createHookHelpers(ctx.dbPath);
    // PostToolBatch hook: append the batch's tool_calls to the session's
    // JSONL queue. Silent on success - no stdout - so the next model call
    // is not delayed waiting for an exit code-driven message.
    try {
      const raw = await Bun.stdin.text();
      hh.logHookPayload("buffer-batch", raw);
      const data = JSON.parse(raw) as { session_id?: string; tool_calls?: unknown[] };
      if (data.session_id && Array.isArray(data.tool_calls)) {
        const { appendBatch } = await import("../../extract-queue");
        appendBatch(data.session_id, data.tool_calls as never);
      }
    } catch (err) {
      console.error(`[thatch buffer-batch] failed: ${err}`);
    }
  },
};

export const bufferTool: Subcommand = {
  name: "buffer-tool",
  summary: "Append a single postToolUse interaction to the queue (Cursor hook only)",
  usage: () => ({ synopsis: "thatch buffer-tool", flags: [] }),
  async run(_args, ctx) {
    const hh = createHookHelpers(ctx.dbPath);
    // Cursor postToolUse hook: append a single tool interaction to the
    // session's JSONL queue. Cursor fires postToolUse per-tool (no batch
    // equivalent), so this receives one tool at a time. Silent on success.
    // Session ID comes as `conversation_id` in Cursor (vs `session_id` in
    // Claude Code). The tool result field name is not explicitly documented,
    // so we try the most likely candidates.
    try {
      const raw = await Bun.stdin.text();
      hh.logHookPayload("buffer-tool", raw);
      const data = JSON.parse(raw) as {
        conversation_id?: string;
        session_id?: string;
        tool_name?: string;
        tool_input?: Record<string, unknown>;
        tool_use_id?: string;
        tool_result?: string | unknown[];
        tool_response?: string | unknown[];
        result_json?: string;
        result?: string | unknown[];
        output?: string;
      };
      const sessionID = data.conversation_id ?? data.session_id;
      if (sessionID && data.tool_name) {
        const { appendBatch } = await import("../../extract-queue");
        const response = data.tool_result ?? data.tool_response ?? data.result_json ?? data.result ?? data.output ?? "";
        appendBatch(sessionID, [{
          tool_name: data.tool_name,
          tool_input: data.tool_input ?? {},
          tool_use_id: data.tool_use_id,
          tool_response: response,
        }]);
      }
    } catch (err) {
      console.error(`[thatch buffer-tool] failed: ${err}`);
    }
  },
};

export const flushTools: Subcommand = {
  name: "flush-tools",
  summary: "Peek the queue + print an extraction nudge (hook only)",
  usage: () => ({
    synopsis: "thatch flush-tools [--json]",
    flags: [{ long: "--json", short: null, description: "Wrap output as { additional_context } for Cursor hooks." }],
  }),
  async run(args, ctx) {
    const hh = createHookHelpers(ctx.dbPath);
    // UserPromptSubmit (Claude Code) / beforeSubmitPrompt (Cursor) hook.
    // Three priority tiers:
    //   1. Extraction nudge - buffered tool interactions are queued for
    //      fact extraction (Claude Code: the payload printed inline for
    //      in-context processing; Cursor: the session ID for the
    //      dispatched extractor's get_extraction_payload fetch).
    //   2. Recall nudge - the user's prompt semantically matches existing
    //      memories. Uses the sideband socket to ask the warm MCP server to
    //      embed the prompt and search, avoiding a cold model load here.
    //   3. Write nudge - static "did you learn anything?" fallback for
    //      conversational turns with no tool use and no memory matches.
    // --json wraps output as { additional_context: "..." } for Cursor hooks.
    // Without --json, stdout is plain text (Claude Code style).
    const isJson = args.includes("--json");
    try {
      const raw = await Bun.stdin.text();
      hh.logHookPayload("flush-tools", raw);
      const data = JSON.parse(raw) as {
        session_id?: string;
        conversation_id?: string;
        transcript_path?: string;
        prompt?: string;
        message?: string;
        text?: string;
        user_input?: string;
        input?: string;
      };
      const sessionID = data.session_id ?? data.conversation_id;

      const { peekQueue, getMissedCount, incrementMissedCount } = await import("../../extract-queue");
      const { detectFlushHost, buildExtractionStage } = await import("../../flush");
      const { claudeWriteNudge, claudeRecallNudge, predictionNudge, behaviorNudge, mcpToolName } = await import("../../prompts");
      const { detectSkew, readNpmCacheForUpdate } = await import("../../version-check");

      let repo = "unknown";
      try { repo = await detectRepo(undefined, repoPathCache(ctx.db)); } catch {}
      if (repo === "unknown") repo = "global";

      // Version checks (best-effort, no network, instant):
      //   - Skew: the running MCP server's version file differs from this
      //     binary's version. Means the user upgraded but didn't restart.
      //   - Update: the npm cache file (written by the MCP server's
      //     background poll) says a newer version is published.
      // The warning is prepended to whatever nudge the tiers below produce.
      // This is the primary delivery channel for version warnings because
      // flush-tools fires on every prompt, including conversational turns
      // with no tool calls.
      const skew = detectSkew(ctx.dbPath);
      const versionWarning = skew ?? readNpmCacheForUpdate(ctx.dbPath);
      // Server-stale gate (issue #6's residual): under SKEW the running
      // MCP server predates the upgrade, so its compiled-at-start tool
      // list may lack the tools the nudges reference. The extraction tier
      // is the only one that names a tool for the model to call
      // (get_extraction_payload) - it degrades to a single restart
      // instruction, and the missed-count is not incremented (the
      // escalation counter counts ignored nudges; none was delivered).
      // The queue is file-backed and peek-not-drain, so nothing is lost:
      // it extracts after the restart. Tiers 2/3 reference only
      // long-standing tools and the sideband is the old server's own warm
      // model - both keep firing under skew.
      const serverStale = skew !== null;
      // Chat check: with a hook session ID this always prints the caller's
      // assigned identity (and its unread count), so the model knows who it
      // is before any chat tool call; with no mail the line says so.
      const chatLine = await hh.chatHookLine(ctx.db, sessionID, data.transcript_path);
      // Claude Code identity anchor (see reminder): record the
      // parent-process mapping for session_id-bearing (Claude Code)
      // payloads; Cursor's conversation_id stays on the `as` path.
      if (data.session_id && chatLine && sessionID) {
        try {
          ctx.db.recordChatHostPid(process.ppid, mcpSessionID(sessionID));
        } catch (err) {
          console.error(`[thatch] chat host-pid anchor failed: ${err}`);
        }
      }

      // Tier 1: extraction nudge. Peek (don't drain) - the queue persists
      // until the extractor completes (extraction_done with the parent's
      // session_id) or the parent writes a memory itself. The parent's
      // dispatch-time ack resets the escalation counter but does NOT drain:
      // a drain at ack time deleted the queue before the sub-agent fetched
      // (the accept-before-fetch loss). If the agent ignores the nudge, the
      // payload grows on the next flush. Stage logic (host detection and
      // the per-host nudge shape) lives in src/flush.ts - this run body
      // is only the dispatcher.
      const interactions = sessionID ? peekQueue(sessionID) : [];
      if (interactions.length > 0 && serverStale) {
        hh.emit(
          `[thatch] The MCP server is stale: the package was upgraded but this session still runs the old server, so extraction is paused until the session restarts. The ${interactions.length} queued interaction${interactions.length === 1 ? "" : "s"} are safe (file-backed) and will extract then. Restart the session to resume.`,
          versionWarning,
          isJson,
          chatLine,
        );
        return;
      }
      if (interactions.length > 0) {
        const missed = sessionID ? getMissedCount(sessionID) : 0;
        if (sessionID) incrementMissedCount(sessionID);
        const host = detectFlushHost(data);
        if (!host || !sessionID) return; // unreachable: interactions implies sessionID implies a host id
        const output = buildExtractionStage({ interactions, missedCount: missed, host, sessionID, repo });
        hh.emit(output, versionWarning, isJson, chatLine);
        return;
      }

      // Tier 2: recall nudge + prediction fire via sideband. The prompt text
      // field name varies by host (Claude Code: "prompt", Cursor: undocumented).
      // Both recall and predictions share the same sideband round-trip.
      const promptText = data.prompt ?? data.message ?? data.text ?? data.user_input ?? data.input;
      if (promptText && promptText.length >= 10) {
        const { sidebandMatch, sidebandPredictions, sidebandBehaviors, sidebandSocketPath } = await import("../../sideband");
        const sockPath = sidebandSocketPath(ctx.dbPath);
        const recallThreshold = parseFloat(process.env.THATCH_RECALL_THRESHOLD ?? "0.55");
        const predThreshold = parseFloat(process.env.THATCH_PREDICTION_THRESHOLD ?? "0.60");
        const behaviorThreshold = parseFloat(process.env.THATCH_BEHAVIOR_THRESHOLD ?? "0.60");

        const [matches, predictions, behaviors] = await Promise.all([
          sidebandMatch(sockPath, promptText, [repo, "global"], recallThreshold, 5),
          sidebandPredictions(sockPath, promptText, [repo, "global"], predThreshold, 5),
          sidebandBehaviors(sockPath, promptText, [repo, "global"], behaviorThreshold, 5),
        ]);

        const parts: string[] = [];
        if (matches && matches.length > 0) {
          parts.push(claudeRecallNudge(matches));
        }
        if (predictions && predictions.length > 0) {
          parts.push(predictionNudge(predictions, mcpToolName));
        }
        if (behaviors && behaviors.length > 0) {
          parts.push(behaviorNudge(behaviors, mcpToolName));
        }

        if (parts.length > 0) {
          const output = parts.join("\n\n");
          hh.emit(output, versionWarning, isJson, chatLine);
          return;
        }
      }

      // Tier 3: static write nudge.
      const output = claudeWriteNudge();
      hh.emit(output, versionWarning, isJson, chatLine);
    } catch (err) {
      console.error(`[thatch flush-tools] failed: ${err}`);
      try {
        const { claudeWriteNudge } = await import("../../prompts");
        const fallback = claudeWriteNudge();
        if (isJson) {
          console.log(JSON.stringify({ additional_context: fallback }));
        } else {
          console.log(fallback);
        }
      } catch {
        // If even the fallback import fails, do nothing - silent failure is
        // preferable to blocking the user's prompt over an unrelated hook.
      }
    }
  },
};

export const chatNotify: Subcommand = {
  name: "chat-notify",
  summary: "Print a chat follow-up message when mail is unread (Cursor stop hook)",
  usage: () => ({ synopsis: "thatch chat-notify", flags: [] }),
  async run(_args, ctx) {
    const hh = createHookHelpers(ctx.dbPath);
    // Stop hook for BOTH MCP hosts; the payload shape tells them apart:
    // Claude Code sends session_id (+ stop_hook_active, background_tasks),
    // Cursor sends conversation_id (+ status, loop_count).
    //
    // Output shapes: Cursor consumes { followup_message } (auto-submitted
    // as the next user message); Claude Code consumes hookSpecificOutput.
    // additionalContext on Stop - a reminder that continues the turn,
    // rendered as hook feedback rather than a hook error. Pointer-only:
    // sender names and a count, never bodies (bodies flow only through
    // the framed chat_read). The nudge text carries the system-
    // notification framing because a follow-up arrives as user input.
    try {
      const hookInput = await hh.readHookInput("chat-notify");
      if (!chatEnabled(loadConfig(ctx.dbPath).config)) {
        console.log("{}");
        return;
      }
      const claudeID = typeof hookInput?.session_id === "string" && hookInput.session_id ? String(hookInput.session_id) : null;
      const cursorID = typeof hookInput?.conversation_id === "string" && hookInput.conversation_id ? String(hookInput.conversation_id) : null;

      // Host-specific loop guards.
      if (claudeID) {
        // Never fight the host's loop protections: a stop-hook continuation
        // already in flight ends the turn, and a session paused on
        // background work gets its wake when that work's turn ends -
        // injecting now would interject mid-flight (the mid-turn injection
        // incident class).
        if (hookInput?.stop_hook_active === true) {
          console.log("{}");
          return;
        }
        if (Array.isArray(hookInput?.background_tasks) && hookInput.background_tasks.length > 0) {
          console.log("{}");
          return;
        }
      } else if (cursorID) {
        // Cursor: never auto-continue an aborted or errored turn (the
        // user's stop key wins).
        if (hookInput?.status !== "completed") {
          console.log("{}");
          return;
        }
      } else {
        console.log("{}");
        return;
      }

      // Lookup, not ensure-register: registration exists by the time stop
      // fires (the prompt hooks anchored the conversation), and minting
      // rows from contexts we do not understand is how the throwaway
      // sessionStart identities happened.
      const anchor = mcpSessionID(claudeID ?? cursorID!);
      if (!ctx.db.findChatSession(anchor)) {
        console.log("{}");
        return;
      }
      const pending = ctx.db
        .pendingChatNotifications([anchor], isoMinutesAgo(CHAT_RENUDGE_MINUTES))
        .filter((m) => m.to_session === anchor);
      if (pending.length === 0) {
        console.log("{}");
        return;
      }
      const senders = [
        ...new Set(pending.map((m) => renderChatParticipant(m.from_name, m.from_session))),
      ];
      // Same sender-kind rule as the poller's nudge: CLI-sent rows are the
      // user's own words, not agent mail.
      const userRows = pending.filter((m) => m.from_session === CHAT_CLI_SENDER);
      // Stamp before emitting: the re-nudge window (not the model's
      // obedience) bounds repeats when the mail goes ignored.
      ctx.db.markChatDelivered(pending.map((m) => m.id));
      const nudge = chatNotificationNudge(senders, pending.length, {
        fromUser: userRows.length > 0,
        mixed: userRows.length > 0 && userRows.length < pending.length,
      });
      console.log(
        JSON.stringify(
          claudeID
            ? { hookSpecificOutput: { hookEventName: "Stop", additionalContext: nudge } }
            : { followup_message: nudge },
        ),
      );
    } catch (err) {
      console.error(`[thatch chat-notify] failed: ${err}`);
      console.log("{}");
    }
  },
};

export const flushPredictions: Subcommand = {
  name: "flush-predictions",
  summary: "Query predictions for the prompt (hook only)",
  usage: () => ({
    synopsis: "thatch flush-predictions [--json]",
    flags: [{ long: "--json", short: null, description: "Wrap output as { additional_context } for Cursor hooks." }],
  }),
  async run(args, ctx) {
    // UserPromptSubmit (Claude Code) / beforeSubmitPrompt (Cursor) hook.
    // Standalone prediction fire: queries the sideband for scored
    // predictions matching the prompt text, prints the prediction nudge
    // if any matchers fire. --json wraps as { additional_context: "..." }
    // for Cursor hooks. Without --json, stdout is plain text.
    //
    // NOTE: flush-tools already fires predictions alongside the recall
    // nudge in its tier 2 block. This subcommand exists for testing and
    // for hosts that want prediction-only output without the recall or
    // extraction nudges.
    const isJson = args.includes("--json");
    try {
      const raw = await Bun.stdin.text();
      const data = JSON.parse(raw) as {
        prompt?: string;
        message?: string;
        text?: string;
        user_input?: string;
        input?: string;
      };

      const promptText = data.prompt ?? data.message ?? data.text ?? data.user_input ?? data.input;
      if (!promptText || promptText.length < 10) {
        if (isJson) console.log(JSON.stringify({ additional_context: "" }));
        return;
      }

      let repo = "unknown";
      try { repo = await detectRepo(undefined, repoPathCache(ctx.db)); } catch {}
      if (repo === "unknown") repo = "global";

      const { sidebandPredictions, sidebandSocketPath } = await import("../../sideband");
      const { predictionNudge, mcpToolName } = await import("../../prompts");
      const sockPath = sidebandSocketPath(ctx.dbPath);
      const threshold = parseFloat(process.env.THATCH_PREDICTION_THRESHOLD ?? "0.60");
      const predictions = await sidebandPredictions(sockPath, promptText, [repo, "global"], threshold, 5);

      if (predictions && predictions.length > 0) {
        const output = predictionNudge(predictions, mcpToolName);
        if (isJson) console.log(JSON.stringify({ additional_context: output }));
        else console.log(output);
      } else {
        if (isJson) console.log(JSON.stringify({ additional_context: "" }));
      }
    } catch (err) {
      console.error(`[thatch flush-predictions] failed: ${err}`);
    }
  },
};
