// LLM alerts: desktop notification when the LLM pauses for human input or
// finishes a round of real work. SDK-free by the isolation rule in
// src/index.ts - the runtime (src/runtime.ts) feeds it events, and delivery
// goes through the same per-platform dispatcher as notify_user (src/notify.ts),
// so one code path serves both opencode lines.
//
// The brain is deliberately a plain in-memory state machine owned by the
// plugin runtime. The runtime is a single instance per project directory in
// the shared server no matter how many TUIs are attached, so per-session
// deduplication and debouncing are exact by construction - delivering from
// the TUI side instead would fire once per attached TUI. State is rebuilt
// empty on plugin setup: a v2 reload mid-turn loses the busy->idle
// transition for that turn and the alert stays silent (accepted; see
// docs/plans/llm-alerts.md).

import { alertMode, type AlertEventKind, type Config } from "./config";
import { isMetaToolName } from "./extraction";

/**
 * What the runtime can observe about the round that just ended. Shapes come
 * from the capabilities layer's message list, so both opencode lines map
 * into this one view.
 */
export interface RoundShape {
  /**
   * The turn was triggered by synthetic input only - a thatch nudge, a
   * background-task completion, a watcher wake-up. Such rounds are
   * bookkeeping, not work the user asked for, and never notify.
   */
  syntheticTrigger: boolean;
  /** Tool names invoked by the round's last assistant message, in order. */
  toolCalls: string[];
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

export interface AlertsDeps {
  /** Current user config (the alerts section decides the channel). */
  config(): Config;
  /** Fetch the finished round's shape; null when the fetch fails. */
  roundShape(sessionID: string): Promise<RoundShape | null>;
  /** Session title for the source label; undefined when unknown. */
  sessionTitle(sessionID: string): Promise<string | undefined>;
  /** Delivery. The production impl wraps sendNotification; tests inject a spy. */
  notify(input: AlertInput): Promise<void>;
}

interface SessionAlertState {
  /** Seen busy since the last idle. */
  active: boolean;
  /** Error recorded by session.error / execution failure, by error name. */
  lastError: string | null;
  /** Pause requests already notified, awaiting their reply event. */
  pendingAsks: Set<string>;
}

/** Errors that mean the human aborted the turn themselves - never notify. */
function isAbortError(error: string | null | undefined): boolean {
  return !!error && /abort/i.test(error);
}

/**
 * Whether the finished round did real work and deserves a done alert. A
 * null shape (message fetch failed) counts as real work: a spurious banner
 * costs less than a silently missed completion. Rounds driven by synthetic
 * input, or made of only meta tools (thatch bookkeeping, dispatch, todo and
 * question bookkeeping), stay silent.
 */
export function roundDidRealWork(shape: RoundShape | null): boolean {
  if (!shape) return true;
  if (shape.syntheticTrigger) return false;
  if (shape.roundError) return false;
  return shape.toolCalls.some((tool) => !isMetaToolName(tool) && tool !== "todowrite" && tool !== "question");
}

/**
 * Whether the reply-event bookkeeping matches the ask-event bookkeeping for
 * the same request. V1 replies carry permissionID (legacy surface), v2 and
 * question replies carry requestID - both resolve here.
 */
export function replyRequestID(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) return undefined;
  const id = properties.requestID ?? properties.permissionID;
  return typeof id === "string" ? id : undefined;
}

export function createAlerts(deps: AlertsDeps) {
  const sessions = new Map<string, SessionAlertState>();

  function stateFor(sessionID: string): SessionAlertState {
    let state = sessions.get(sessionID);
    if (!state) {
      state = { active: false, lastError: null, pendingAsks: new Set() };
      sessions.set(sessionID, state);
    }
    return state;
  }

  /** One ask of any kind. Deduped per request id; duplicates stay silent. */
  async function asked(sessionID: string, requestID: string | undefined, message: string): Promise<void> {
    try {
      const state = stateFor(sessionID);
      const key = requestID ?? `anon:${message}`;
      if (state.pendingAsks.has(key)) return;
      state.pendingAsks.add(key);
      if (alertMode(deps.config(), "pause") === "none") return;
      const title = (await deps.sessionTitle(sessionID).catch(() => undefined)) ?? "opencode";
      await deps.notify({ kind: "pause", title, message });
    } catch (err) {
      console.error(`[thatch] pause alert failed: ${err}`);
    }
  }

  function resolved(sessionID: string, requestID: string | undefined): void {
    const state = sessions.get(sessionID);
    if (!state) return;
    if (requestID) state.pendingAsks.delete(requestID);
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

    /** The session started or resumed work (status busy or retry). */
    sessionBusy(sessionID: string): void {
      const state = stateFor(sessionID);
      state.active = true;
      // A retry means opencode recovered on its own - the failure was not
      // terminal, so the turn's outcome decides the alert again.
      state.lastError = null;
    },

    /** The session failed (session.error / execution failure). */
    sessionError(sessionID: string, errorName: string | null | undefined): void {
      const state = stateFor(sessionID);
      state.active = true;
      state.lastError = errorName ?? "unknown";
    },

    /** The session went idle (busy -> idle transition). The turn verdict. */
    async sessionIdle(sessionID: string): Promise<void> {
      const state = sessions.get(sessionID);
      if (!state?.active) return;
      state.active = false;
      try {
        const recordedError = state.lastError;
        state.lastError = null;
        // The user aborted this turn themselves; they know.
        if (isAbortError(recordedError)) return;
        if (recordedError) {
          if (alertMode(deps.config(), "error") !== "none") {
            const title = (await deps.sessionTitle(sessionID).catch(() => undefined)) ?? "opencode";
            await deps.notify({
              kind: "error",
              title,
              message: "Session needs attention - the last round failed",
            });
          }
          return;
        }
        const shape = await deps.roundShape(sessionID).catch(() => null);
        if (isAbortError(shape?.roundError)) return;
        if (shape?.roundError) {
          if (alertMode(deps.config(), "error") !== "none") {
            const title = (await deps.sessionTitle(sessionID).catch(() => undefined)) ?? "opencode";
            await deps.notify({
              kind: "error",
              title,
              message: "Session needs attention - the last round failed",
            });
          }
          return;
        }
        if (!roundDidRealWork(shape)) return;
        if (alertMode(deps.config(), "done") === "none") return;
        const title = (await deps.sessionTitle(sessionID).catch(() => undefined)) ?? "opencode";
        await deps.notify({ kind: "done", title, message: "Work finished" });
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
