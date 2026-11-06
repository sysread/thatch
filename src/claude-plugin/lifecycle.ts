import { createAlerts, isNoWorkTool, alertDelivery, type AlertInput, type RoundShape } from "../alerts";
import { isMetaToolName } from "../extraction";
import { appendBatch, consumeQueue, resetMissedCount } from "../extract-queue";
import { MEMORY_SAVED_MARKER } from "../tool-defs";
import { alertMode, loadConfig, type Config } from "../config";
import { sendNotification, defaultSpawner } from "../notify";
import type { WatcherRegistry } from "../watchers";
import { stampModLiveness } from "../version-check";
import type { ThatchDB } from "../db";
import type { EmbeddingModel } from "../embeddings";

/** The two regime spellings of our own tool namespace: the standalone
 *  registration (mcp__thatch__*) and the plugin regime's bundled server
 *  (mcp__plugin_thatch_thatch__*). One helper so the filter and the save
 *  gate cannot drift apart when a third spelling arrives. */
const THATCH_TOOL_PREFIXES = ["mcp__thatch__", "mcp__plugin_thatch_thatch__"];

function isThatchOwnToolCall(tool: string | undefined): boolean {
  // The caller short-circuits on !event.tool first; the guard is for the
  // helper's own safety.
  return !!tool && THATCH_TOOL_PREFIXES.some((p) => tool.startsWith(p));
}

function isThatchMemoryRememberCall(tool: string | undefined): boolean {
  // The caller short-circuits on !event.tool first; the guard is for the
  // helper's own safety.
  return !!tool && THATCH_TOOL_PREFIXES.some((p) => tool === `${p}memory_remember`);
}

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
  /** The watcher registry (bundled mode): session.end deaths route here. */
  watchers?: WatcherRegistry;
}

/** The lifecycle events the mod forwards, one per host event. The wide
 *  shape (every field optional except event/sessionID) is deliberate: the
 *  CoreContext seam passes the mod's parsed tool arguments as one object,
 *  and the discriminated narrowing happens in handle(). */
export type PluginLifecycleEvent = {
  event: "busy" | "realwork" | "error" | "complete" | "arm" | "greenlight" | "ask" | "resolved" | "session-end";
  sessionID: string;
  tool?: string;
  error?: string;
  isAborted?: boolean;
  kind?: "compact" | "exit" | "question" | "permission";
  requestID?: string;
  /** The tool's input fields (the realwork/buffer event): forwarded to the
   *  server-side buffer push. */
  args?: Record<string, unknown>;
  /** The tool's result text (the buffer event), serialized by the mod. */
  result?: string;
  /** Main-conversation call (the mod's agentId filter) - gates the WORK
   * mark; the BUFFER takes every non-meta call either way. */
  isMain?: boolean;
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
          // The liveness stamp rides the lifecycle too: a 30+ minute turn
          // would otherwise self-trip the disabled-mod warning (the stage
          // only stamps at prompt time).
          stampModLiveness(deps.dbPath);
          wakeBySession.set(sid, event.wake === true);
          alerts.sessionBusy(sid);
          return { text: "" };

        case "realwork": {
          // The buffer push and the alert bookkeeping share this site (the
          // opencode coupling: the extraction buffer's push is where real
          // work is marked). The mod forwards EVERY tool call with its
          // input and result; the server owns ALL the filtering:
          // - the buffer takes every non-meta tool under the SESSION key
          //   (subagent calls included - they carry extractable facts,
          //   issue #22's NOTES: arguably desirable);
          // - the WORK mark is main-conversation-only (isMain, the mod's
          //   agentId filter) and excludes the no-work tools on top
          //   (todowrite/question did nothing the user waits for).
          stampModLiveness(deps.dbPath);
          // Our OWN tool traffic: the spellings are REGIME-KEYED - the
          // standalone registration spells mcp__thatch__*, the PLUGIN
          // regime's bundled server mcp__plugin_thatch_thatch__* (the
          // round-3 finding: the mcp__thatch__-only filter let our own
          // plugin calls land IN the extraction queue and a real save
          // never drained it). startsWith matches the prefix class (a
          // spoofed tool name carrying the prefix deeper still matches,
          // which is correct - the name IS ours).
          if (!event.tool || isMetaToolName(event.tool) || isThatchOwnToolCall(event.tool)) {
            // The SAVE gate: a memory_remember that actually saved drains
            // the queue and resets the counter (the opencode hook's drain
            // semantics, server-side; the fallback path gets it inside
            // appendBatch's meta branch, which this skip never reaches).
            if (isThatchMemoryRememberCall(event.tool) && (event.result ?? "").includes(MEMORY_SAVED_MARKER)) {
              resetMissedCount(sid);
              consumeQueue(sid);
            }
            return { text: "" };
          }
          appendBatch(sid, [{
            tool_name: event.tool,
            tool_input: event.args ?? {},
            tool_response: event.result ?? "",
          }]);
          if (event.isMain !== false && !isNoWorkTool(event.tool)) alerts.sessionRealWork(sid);
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
          // An aborted turn does NOT resolve the wrap-up: the user's ESC
          // after greenlight means not-now - the arm survives for the
          // next turn end.
          const kind = event.isAborted ? undefined : greenlit.get(`${sid}:wrapup`);
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

        case "session-end": {
          // A REAL session end (the mod branches on session.end's e.reason:
          // not /clear, /resume, /branch). The watcher registry declares
          // the death: registry + journal CLEANUP only - the opencode
          // path's CARE-BASED death notices ride the dead session's spawn
          // metadata (thatch.coordinatorSessionID), which Claude Code
          // sessions do not have; routing them is a named gap, not wired
          // here. The mod calls this inside session.end's 1.5-second
          // budget - the forward is one in-process call.
          deps.watchers?.sessionDied(sid);
          for (const kind of ["compact", "exit"] as const) armed.delete(`${sid}:${kind}`);
          greenlit.delete(`${sid}:wrapup`);
          wakeBySession.delete(sid);
          return { text: "" };
        }
      }
    },
  };
}
