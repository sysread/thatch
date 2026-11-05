import { createAlerts, isNoWorkTool, alertDelivery, type AlertInput, type RoundShape } from "../alerts";
import { isMetaToolName } from "../extraction";
import { alertMode, loadConfig, type Config } from "../config";
import { sendNotification, defaultSpawner } from "../notify";
import type { ThatchDB } from "../db";
import type { EmbeddingModel } from "../embeddings";

/**
 * The plugin regime's lifecycle layer: the Claude Code mod reports host
 * events (turn start/complete, tool calls, permission asks) through the
 * bundled server's plugin_lifecycle tool, and THIS module maps them onto
 * the same alert machine the opencode path uses (createAlerts), plus the
 * wrap-up greenlight protocol's server side.
 *
 * Why server-side: the mod has no Node APIs - it cannot shell out to the
 * per-platform notification dispatcher (banner/voice, the user's alert
 * config), and it cannot own durable bookkeeping. The mod is a thin
 * forwarder; classification and delivery live here.
 *
 * The per-field CC mapping (docs/plans/claude-code-holistic-integration.md
 * Step B): turn.complete carries isAborted (the user's own stop - a SILENT
 * error class) but NO provider-error field, so provider failures arrive
 * via the classic.StopFailure event's kind; there are no synthetic parts,
 * so the synthetic-trigger signal is the mod's own wake bookkeeping (the
 * wake map - populated by Step C's prompt-submit channel, empty until
 * then, meaning every turn is user-triggered in Step B).
 */

export interface PluginLifecycleDeps {
  db: ThatchDB;
  model: EmbeddingModel;
  repo: string;
  dbPath: string;
  /** Config override for tests; production reads the user's config. */
  config?: Config;
  /** Notify override for tests; production delivers through the
   *  per-platform dispatcher (sendNotification), the same channel
   *  notify_user uses. */
  notify?: (input: AlertInput) => Promise<void>;
}

/** The lifecycle events the mod forwards, one per host event. The wide
 *  shape (every field optional except event/sessionID) is deliberate: the
 *  CoreContext seam passes the mod's parsed tool arguments as one object,
 *  and the discriminated narrowing happens in handle(). */
export type PluginLifecycleEvent = {
  event: "busy" | "realwork" | "error" | "complete" | "arm" | "greenlight" | "ask" | "resolved";
  sessionID: string;
  tool?: string;
  error?: string;
  isAborted?: boolean;
  kind?: "compact" | "exit" | "question" | "permission";
  requestID?: string;
  /** The turn was started by the mod's own wake submission ($.prompt.submit
   *  after a chat-wake poll hit) - synthetic-trigger provenance for the
   *  alert machine (a wake's round is bookkeeping, never user-waited
   *  work). */
  wake?: boolean;
};

export interface PluginLifecycleResult {
  /** The nudge-free response text the mod shows or acts on. */
  text: string;
  /** The wrap-up action to fire at idle, when a greenlit arm resolves. */
  wrapup?: "compact" | "exit";
}

export function createPluginLifecycle(deps: PluginLifecycleDeps) {
  // The turn-reported round shape: the mod's turn.complete knows
  // syntheticTrigger/error directly (no message-list archaeology exists on
  // this host - the mods events ARE the shape). Keyed by session, consumed
  // by the idle verdict.
  const reportedShape = new Map<string, RoundShape>();
  // Wrap-up arm state: armed (the command ran) -> greenlit (the model
   // called the zero-arg tool) -> resolved at the next turn end. In-memory
  // only: a plugin reload loses one armed wrap-up (the arm is
  // re-runnable), the same accepted loss the opencode path documents for
  // its reload case.
  const armed = new Map<string, true>();
  const greenlit = new Map<string, "compact" | "exit">();
  // The wake provenance: the busy event carries it (the mod knows which
  // turns it started); the complete event consumes it.
  const wakeBySession = new Map<string, boolean>();

  const alerts = createAlerts({
    config: (): Config => deps.config ?? loadConfig().config,
    roundShape: async (sessionID) => reportedShape.get(sessionID) ?? null,
    sessionTitle: async (sessionID) => deps.db.findChatSession(sessionID)?.name ?? "Claude Code",
    notify: deps.notify ?? (async (input: AlertInput) => {
      const prefs = (deps.config ?? loadConfig().config).notifications ?? {};
      // alertDelivery's "none" cast records the machine's per-event gate
      // contract (it never calls here with one) - no runtime "none" check.
      const { voice, sound, tone } = alertDelivery(deps.config ?? loadConfig().config, { voice: prefs.voice, sound: prefs.sound }, input.kind);
      await sendNotification(
        { message: input.message, title: input.title, tone, channel: alertMode(deps.config ?? loadConfig().config, input.kind) as "both" | "banner" | "voice", voice, sound },
        defaultSpawner,
      );
    }),
  });

  return {
    /** The plugin_lifecycle tool's dispatcher. Returns the response text. */
    async handle(event: PluginLifecycleEvent): Promise<PluginLifecycleResult> {
      const sid = event.sessionID;
      switch (event.event) {
        case "busy":
          wakeBySession.set(sid, event.wake === true);
          alerts.sessionBusy(sid);
          return { text: "" };

        case "realwork": {
          // The server owns the work classification (the mod forwards every
          // main-conversation tool call): the meta-tool filter is the same
          // one the extraction buffer uses - here that includes the
          // mcp__thatch__ prefix (the buffer checks it separately; a tool
          // named by that spelling is our own bookkeeping, not work) - and
          // todowrite/question are the alerts-only no-work exclusions. A
          // realwork event without a tool name is unclassifiable - ignore.
          if (!event.tool || isMetaToolName(event.tool) || event.tool.startsWith("mcp__thatch__") || isNoWorkTool(event.tool)) return { text: "" };
          alerts.sessionRealWork(sid);
          return { text: "" };
        }

        case "error":
          alerts.sessionError(sid, event.error ?? "ProviderError");
          return { text: "" };

        case "complete": {
          // The abort mapping: turn.complete's isAborted IS the user's own
          // stop (isSilentError's class - never notifies), recorded as the
          // round error so the idle verdict routes silent.
          if (event.isAborted) alerts.sessionError(sid, "MessageAbortedError");
          const kind = greenlit.get(`${sid}:wrapup`);
          let wrapup: PluginLifecycleResult["wrapup"];
          if (kind) {
            greenlit.delete(`${sid}:wrapup`);
            wrapup = kind;
          }
          reportedShape.set(sid, { syntheticTrigger: wakeBySession.get(sid) === true, roundError: null });
          wakeBySession.delete(sid);
          await alerts.sessionIdle(sid);
          reportedShape.delete(sid);
          return { text: "", ...(wrapup ? { wrapup } : {}) };
        }

        case "arm": {
          armed.set(`${sid}:${event.kind}`, true);
          return {
            text:
              `Wrap-up armed (${event.kind}). Work through your closing checklist, ` +
              `then call the ${event.kind === "compact" ? "compact" : "exit"} tool to greenlight; ` +
              `the action fires when the turn ends.`,
          };
        }

        case "greenlight": {
          if (event.kind !== "compact" && event.kind !== "exit") return { text: "" };
          if (!armed.has(`${sid}:${event.kind}`)) {
            // Accept-then-teach: the tool exists, the arm is missing -
            // teach the contract instead of erroring.
            return { text: `[not armed] The ${event.kind} wrap-up was never armed. The user runs /thatch_${event.kind} to arm it first; then close out and call this tool again.` };
          }
          // The greenlit key is session-scoped (one pending wrap-up per
          // session, whichever kind); the arm is consumed at greenlight.
          armed.delete(`${sid}:${event.kind}`);
          greenlit.set(`${sid}:wrapup`, event.kind);
          return { text: "[greenlit] The wrap-up fires when this turn ends." };
        }

        case "ask": {
          if (event.kind === "question") alerts.questionAsked(sid, event.requestID);
          else alerts.permissionAsked(sid, event.requestID);
          return { text: "" };
        }

        case "resolved":
          alerts.questionResolved(sid, event.requestID);
          alerts.permissionResolved(sid, event.requestID);
          return { text: "" };
      }
    },
  };
}
