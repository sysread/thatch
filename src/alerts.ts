// LLM alerts: desktop notification when the LLM pauses for human input or
// finishes a round of real work. SDK-free by the isolation rule in
// src/index.ts - the runtime (src/runtime.ts) feeds it events, and delivery
// goes through the same per-platform dispatcher as notify_user (src/notify.ts),
// so one code path serves both opencode lines.
//
// The brain is deliberately a plain in-memory state machine owned by the
// plugin runtime. The runtime is a single instance per project directory in
// the shared server no matter how many TUIs are attached, so per-session
// deduplication is exact by construction - delivering from the TUI side
// instead would fire once per attached TUI. State is rebuilt empty on
// plugin setup: a v2 reload mid-turn loses that turn's transition and the
// alert stays silent (accepted; see docs/plans/llm-alerts.md).
//
// What makes a round "real work" is split across two sources, on purpose:
// - the TOOL side comes from live bookkeeping: the runtime marks real work
//   exactly where the extraction buffer pushes (the buffer's non-bufferable
//   filter already knows the meta tools and unwraps execute-wrapped thatch
//   calls), so the execute-unwrap lesson lives in one place;
// - the TRIGGER side (was the turn started by a real user prompt, or by a
//   synthetic delivery?) and the round's error come from the message list,
//   via deriveRoundShape. Messages cannot answer the tool side (tool args -
//   the execute code - are not in message parts), and live bookkeeping
//   cannot answer the trigger side. Neither source alone is sufficient.

import { alertMode, type AlertEventKind, type Config } from "./config";

/**
 * What the message list says about the round that just ended. Derived by
 * deriveRoundShape from the capabilities layer's message view; null means
 * the shape is unknown (empty/failed fetch) and the alert stays silent.
 */
export interface RoundShape {
  /**
   * The turn was triggered by synthetic input only - a thatch nudge, a
   * background-task completion, a watcher wake-up. Such rounds are
   * bookkeeping, not work the user asked for, and never notify - even when
   * they end up doing real tool work (e.g. a watcher wake that merges a
   * branch: the watcher already announced itself).
   */
  syntheticTrigger: boolean;
  /**
   * The round ended in an error (message-level: abort, stall, provider
   * failure). Routes to the error alert instead of done. Null when the
   * round ended cleanly.
   */
  roundError?: string | null;
}

/** One outbound alert; the injected notify implementation delivers it. */
export interface AlertInput {
  kind: AlertEventKind;
  title: string;
  message: string;
}

/** Structural message view - the capabilities layer's sessionMessages shape. */
export interface RoundMessage {
  info: { role: string; error?: string };
  parts?: { type: string; text?: string; tool?: string; synthetic?: boolean }[];
}

export interface AlertsDeps {
  /** Current user config (the alerts section decides the channel). */
  config(): Config;
  /** Derive the finished round's shape from the message list. */
  roundShape(sessionID: string): Promise<RoundShape | null>;
  /** Session title for the source label; undefined when unknown. */
  sessionTitle(sessionID: string): Promise<string | undefined>;
  /**
   * Delivery. The production impl wraps sendNotification; tests inject a
   * synchronous spy. Fire-and-forget from the machine's side - a voice
   * delivery awaits `say` for seconds and must never delay the event pump.
   */
  notify(input: AlertInput): Promise<void>;
}

interface SessionAlertState {
  /** Seen busy since the last verdict. */
  active: boolean;
  /** Real tool work observed this busy period (the extraction-push signal). */
  realWork: boolean;
  /** Error recorded by session.error / execution failure, by error name. */
  lastError: string | null;
  /** Pause requests already notified, awaiting their reply event. */
  pendingAsks: Set<string>;
}

/**
 * Error names that never alert: the user aborted the turn themselves
 * (MessageAbortedError, and v2's user-reason interrupt translation), the
 * process is shutting down and there is nobody left to notify
 * (SessionShutdownError), or the execution was superseded by a newer one
 * (SessionInterruptedError catch-all - a new busy period is taking over).
 */
function isSilentError(error: string | null | undefined): boolean {
  return !!error && /abort|shutdown|interrupt/i.test(error);
}

/**
 * Which tool calls count as real work for the ALERT classifier, on top of
 * the extraction buffer's push (which already excludes isMetaToolName and
 * execute-wrapped thatch calls). todowrite and question are intentionally
 * NOT in isMetaToolName - the extraction buffer must buffer them (they
 * carry extractable facts) - but a round made of only them did nothing the
 * user is waiting for: a todo write has no outcome to announce, and a
 * question is announced by its own pause alert. Do not move them into the
 * shared helper; that would silently stop the buffer from queueing them.
 */
export function isNoWorkTool(tool: string): boolean {
  const t = tool.toLowerCase();
  return t === "todowrite" || t === "question";
}

/**
 * Derive the round shape from the message list (oldest first, the
 * capabilities layer's sessionMessages order).
 *
 * Round delimiter: on v2 the host appends an `{type: "idle"}` marker
 * message at every turn end (SessionMessage.Idle, projected before
 * subscribers are notified), so the round is everything after the previous
 * idle marker - the host's own turn definition, immune to mid-round
 * steers. V1 has no markers: fall back to "the newest non-assistant message
 * triggered the round" (a mid-round steer under-classifies the round there;
 * accepted v1 limitation).
 */
export function deriveRoundShape(messages: RoundMessage[] | null | undefined): RoundShape | null {
  if (!messages?.length) return null;
  // The CURRENT turn's idle marker is the last message on v2 (projected
  // before subscribers see the terminal event) - it terminates the round,
  // so trim trailing markers first, then the round is everything after the
  // PREVIOUS marker.
  let end = messages.length;
  while (end > 0 && messages[end - 1].info.role === "idle") end--;
  let start = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (messages[i].info.role === "idle") {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    // No markers (v1): the newest non-assistant message triggered the round.
    for (let i = end - 1; i >= 0; i--) {
      if (messages[i].info.role !== "assistant") {
        start = i;
        break;
      }
    }
  }
  if (start < 0) return null; // only assistant messages - no trigger, no round
  const round = messages.slice(start, end);
  const trigger = round.find((m) => m.info.role !== "assistant" && m.info.role !== "idle");
  const lastAssistant = [...round].reverse().find((m) => m.info.role === "assistant");
  const textParts = (trigger?.parts ?? []).filter((p) => p.type === "text");
  const syntheticTrigger =
    trigger?.info.role === "synthetic" ||
    (trigger?.info.role === "user" && textParts.length > 0 && textParts.every((p) => p.synthetic === true));
  return { syntheticTrigger: !!syntheticTrigger, roundError: lastAssistant?.info.error ?? null };
}

/**
 * Whether the finished round did real work and deserves a done alert.
 * Unknown shape stays silent (alerts are best-effort; the same fetch
 * failure also breaks the wrap-up greenlight check, so the session
 * degrades consistently). A round triggered by synthetic input stays
 * silent even when it did real work - see the RoundShape.syntheticTrigger
 * doc for why.
 */
export function roundDidRealWork(shape: RoundShape | null, realWork: boolean): boolean {
  if (!shape || shape.syntheticTrigger || shape.roundError) return false;
  return realWork;
}

/**
 * The reply-event bookkeeping: all reply events on both lines carry
 * requestID (verified against v1.18.9's schema - despite the v1 SDK's
 * stale types showing a legacy permissionID spelling, the v1 host's active
 * permission publisher uses the v1 schema's requestID).
 */
export function replyRequestID(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) return undefined;
  const id = properties.requestID;
  return typeof id === "string" ? id : undefined;
}

export function createAlerts(deps: AlertsDeps) {
  const sessions = new Map<string, SessionAlertState>();

  function stateFor(sessionID: string): SessionAlertState {
    let state = sessions.get(sessionID);
    if (!state) {
      state = { active: false, realWork: false, lastError: null, pendingAsks: new Set() };
      sessions.set(sessionID, state);
    }
    return state;
  }

  function titleFor(sessionID: string): Promise<string> {
    return deps
      .sessionTitle(sessionID)
      .catch(() => undefined)
      .then((t) => t ?? "opencode");
  }

  function deliver(input: AlertInput): void {
    // One INFO line per actual delivery - a notification feature must be
    // able to answer "did the alert fire?" from the server log, and the
    // verdict log below covers the suppressed cases.
    console.info(`[thatch] alert: ${input.kind} -> "${input.message}" (${input.title})`);
    // Fire-and-forget: a voice delivery awaits the sentence for seconds,
    // and the caller (the event pump) must not stall other sessions'
    // events behind it. Delivery failures are logged, never surfaced.
    deps.notify(input).catch((err) => console.error(`[thatch] alert delivery failed: ${err}`));
  }

  /** One ask of any kind. Deduped per request id; duplicates stay silent. */
  async function asked(sessionID: string, requestID: string | undefined, message: string): Promise<void> {
    try {
      const state = stateFor(sessionID);
      // No id (never observed in the wild): dedup per session+kind. Two
      // concurrent id-less asks of the same kind dedup to one alert -
      // over-clearing on reply is the accepted cost.
      const key = requestID ?? `anon:${message}`;
      if (state.pendingAsks.has(key)) return;
      state.pendingAsks.add(key);
      if (alertMode(deps.config(), "pause") === "none") return;
      deliver({ kind: "pause", title: await titleFor(sessionID), message });
    } catch (err) {
      console.error(`[thatch] pause alert failed: ${err}`);
    }
  }

  function resolved(sessionID: string, requestID: string | undefined): void {
    const state = sessions.get(sessionID);
    if (!state) return;
    if (requestID) state.pendingAsks.delete(requestID);
    // No id: clear all - the reply event dropped the request payload, and
    // a stuck pending ask would suppress a future genuine alert.
    else state.pendingAsks.clear();
  }

  return {
    /** Interactive question blocking the LLM (question.asked). */
    questionAsked: (sessionID: string, requestID: string | undefined) =>
      asked(sessionID, requestID, "Question needs your answer"),

    /** Permission prompt blocking the LLM (permission.asked). */
    permissionAsked: (sessionID: string, requestID: string | undefined) =>
      asked(sessionID, requestID, "Permission needs your approval"),

    /** The ask was answered; re-asks of the same id may notify again. */
    questionResolved: resolved,
    permissionResolved: resolved,

    /** The session started work (status busy). Resets the round. */
    sessionBusy(sessionID: string): void {
      const state = stateFor(sessionID);
      state.active = true;
      state.realWork = false;
      state.lastError = null;
    },

    /**
     * A retry (status retry, v1 only - v2 never publishes session.error
     * for a retried attempt). Clears a recorded error - opencode recovered
     * on its own - but PRESERVES the real-work flag: the tool calls before
     * the retry happened, and the recovered tail is often text-only, so a
     * reset here would make the done alert under-fire.
     */
    sessionRetry(sessionID: string): void {
      const state = stateFor(sessionID);
      state.active = true;
      state.lastError = null;
    },

    /**
     * Real tool work happened this busy period. The runtime calls this
     * exactly where the extraction buffer pushes - the buffer's filter is
     * the single classification of "this call was not bookkeeping" (meta
     * tools excluded, execute-wrapped thatch calls unwrapped). todowrite
     * and question are additionally excluded here (see isNoWorkTool).
     */
    sessionRealWork(sessionID: string): void {
      stateFor(sessionID).realWork = true;
    },

    /** The session failed (session.error / execution failure). */
    sessionError(sessionID: string, errorName: string | null | undefined): void {
      const state = stateFor(sessionID);
      state.active = true;
      state.lastError = errorName ?? "unknown";
    },

    /**
     * The session went idle (busy -> idle transition). The verdict: error
     * alert, done alert, or silence. On both lines every busy period ends
     * with an idle event - v2's execution.failed is translated to
     * session.error + idle by the adapter, so this is the single verdict
     * path.
     */
    async sessionIdle(sessionID: string): Promise<void> {
      const state = sessions.get(sessionID);
      if (!state?.active) return;
      state.active = false;
      try {
        const recorded = state.lastError;
        state.lastError = null;
        // A recorded error delivers its verdict WITHOUT the message fetch:
        // the fetch rides the same host API whose failure plausibly
        // accompanied the execution failure, and silence must not land
        // exactly when the needs-attention alert matters most.
        if (recorded) {
          if (isSilentError(recorded)) return; // user abort or shutdown
          if (alertMode(deps.config(), "error") !== "none") {
            deliver({
              kind: "error",
              title: await titleFor(sessionID),
              message: `Session needs attention - the last round failed (${recorded})`,
            });
          }
          return;
        }
        const shape = await deps.roundShape(sessionID).catch(() => null);
        if (!shape) {
          console.info(`[thatch] alert verdict ${sessionID}: silent (round shape unavailable)`);
          return; // unknown shape: silent (best-effort)
        }
        if (isSilentError(shape.roundError)) return; // user abort or shutdown
        if (shape.roundError) {
          if (alertMode(deps.config(), "error") !== "none") {
            deliver({
              kind: "error",
              title: await titleFor(sessionID),
              message: `Session needs attention - the last round failed (${shape.roundError})`,
            });
          }
          return;
        }
        if (!roundDidRealWork(shape, state.realWork)) {
          console.info(
            `[thatch] alert verdict ${sessionID}: silent (${shape.syntheticTrigger ? "synthetic-triggered round" : "no real tool work"})`,
          );
          return;
        }
        if (alertMode(deps.config(), "done") === "none") return;
        deliver({ kind: "done", title: await titleFor(sessionID), message: "Work finished" });
      } catch (err) {
        console.error(`[thatch] idle alert failed: ${err}`);
      }
    },

    /** The session is gone; drop its state. */
    sessionDeleted(sessionID: string): void {
      sessions.delete(sessionID);
    },
  };
}

export type Alerts = ReturnType<typeof createAlerts>;
