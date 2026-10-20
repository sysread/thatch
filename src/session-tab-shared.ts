/**
 * Cross-entry contract for the session-tab feature: the single module both
 * the opencode v2 server adapter (src/opencode/v2.ts) and the v2 TUI CLI
 * plugin (src/opencode/tui-plugin.ts) import. SDK-free under the same
 * isolation rule as src/index.ts - the TUI entry may import only
 * @opencode/plugin/tui and this module, and the server entry graph must
 * never evaluate the v1 SDK.
 *
 * The transport is the v2 plugin rpc surface: the server adapter registers
 * this definition and emits events; the TUI CLI plugin receives them on the
 * ordinary event feed (isOpenCodeEvent passes any `rpc.` type) and acts on
 * them with the TUI-only tab primitives. Events are ephemeral - a missed
 * event means "no tab", never "no session" (the session exists before the
 * first emit and the tool response words the tab as requested, not
 * guaranteed).
 *
 * The schemas are literal JSON Schema objects because
 * Rpc.PortableEventValueSchema accepts StandardSchemaV1 or a JSON Schema
 * object with type "object"; a literal object keeps this module
 * dependency-free. The registration is the server-to-TUI transport for
 * everything thatch pushes at the TUI (tab lifecycle plus toasts), so its
 * id says "tabs" only historically. One event has a consumer beyond the
 * TUI plugin's tab strip: the v2 pump (src/opencode/v2.ts) translates
 * tab-closed into the runtime's confirmed-death path (the
 * session_tab_close tool's only route to it), so that shape must change
 * jointly with all consumers (docs/dev/features/session-tabs.md).
 * exit-tab-closed is deliberately TUI-only: the wrap-up exit records the
 * session's watcher deaths synchronously before emitting
 * (src/runtime.ts), so the pump ignores it - a pump translation would run
 * the death path a second time and erase the durable death row the first
 * pass wrote. toast is TUI-only by nature (nobody else consumes it).
 */

import { realpathSync } from "node:fs";
import { EXTRACTION_CHILD_TITLE } from "./chat";
import { resolveMainCheckout } from "./git";

export const SESSION_TAB_RPC_ID = "thatch-tabs";
export const TAB_OPENED_EVENT = "tab-opened";
export const TAB_CLOSED_EVENT = "tab-closed";
export const EXIT_TAB_CLOSED_EVENT = "exit-tab-closed";
export const TOAST_EVENT = "toast";

/** Full wire type of an emitted event, e.g. "rpc.thatch-tabs.tab-opened". */
export const tabOpenedEventType = `rpc.${SESSION_TAB_RPC_ID}.${TAB_OPENED_EVENT}`;

/** Full wire type of the tab-closed event - the generalized-session-
 *  heartbeat plan's confirmed-close consumer matches on this. */
export const tabClosedEventType = `rpc.${SESSION_TAB_RPC_ID}.${TAB_CLOSED_EVENT}`;

/** Full wire type of the wrap-up exit's TUI-only close event. */
export const exitTabClosedEventType = `rpc.${SESSION_TAB_RPC_ID}.${EXIT_TAB_CLOSED_EVENT}`;

/** Full wire type of the toast request event. */
export const toastEventType = `rpc.${SESSION_TAB_RPC_ID}.${TOAST_EVENT}`;

export const SESSION_TAB_RPC = {
  id: SESSION_TAB_RPC_ID,
  methods: {},
  events: {
    [TAB_OPENED_EVENT]: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          // The subordinate's final (post-move) directory: the v2 pump caches
          // it so the subordinate's later location-less execution events
          // resolve to the instance that owns it. The OPEN guard never reads
          // this field - it routes by the rpc envelope's location stamp.
          directory: { type: "string" },
          // The id of the session that called the tool (host.sessionID), when
          // the runtime reports the calling session. The TUI guard prefers
          // it: the window holding the coordinator's tab is the routing
          // anchor that survives both tab switching and worktree-resident
          // coordinators. An older server process emits without it and the
          // guard falls back to directory matching.
          coordinatorSessionID: { type: ["string", "null"] },
        },
        required: ["sessionID", "directory"],
        additionalProperties: false,
      },
    },
    [TAB_CLOSED_EVENT]: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          // Nullable: the chat roster row may have been reaped by the time
          // the close fires. Consumers address death notices by name when
          // present and fall back to the session id.
          chatName: { type: ["string", "null"] },
        },
        required: ["sessionID", "chatName"],
        additionalProperties: false,
      },
    },
    [EXIT_TAB_CLOSED_EVENT]: {
      // TUI-only (see the module header): carries just the tab to close.
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
    [TOAST_EVENT]: {
      // TUI-only by nature. The payload is thatch's ToastInput verbatim
      // (all three fields required there, so required here).
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          variant: { type: "string", enum: ["info", "success", "warning", "error"] },
          duration: { type: "number" },
        },
        required: ["message", "variant", "duration"],
        additionalProperties: false,
      },
    },
  },
} as const;

/**
 * The coordinator-authority framing delivered as the subordinate's first
 * user message. The wording is the feature's contract with the subordinate
 * LLM (docs/dev/features/session-tabs.md): coordinator instructions outrank
 * nothing the user says directly.
 */
export function buildSubordinatePrompt(coordinatorName: string, task: string): string {
  const preamble =
    `Your work session was created by ${coordinatorName}, who is coordinating your actions. ` +
    "Please treat their instructions as accepted priority, unless they conflict with the user's " +
    "explicit preferences or instructions. If the user prompts you directly, their instructions " +
    "supersede the coordinating LLM's.";
  return `${preamble}\n\n${task}`;
}

/** Result of validating the session_tab title arg. */
export type TitleValidation = { ok: true; title: string } | { ok: false; error: string };

/**
 * Titles render in the tab strip: soft target ~50 characters, hard max 80.
 * opencode imposes no length limit (title is an unbounded optional string)
 * and the strip truncates visually, so a hard fail at 50 would only cost
 * retry friction - hence the loose cap.
 *
 * EXTRACTION_CHILD_TITLE is rejected because the chat auto-register paths
 * treat that exact title as plugin machinery and refuse the session
 * (src/chat.ts isMachinerySessionTitle) - a subordinate titled into
 * machinery would silently lose its roster row and with it the
 * coordination loop's addressing.
 */
export function validateTitle(raw: unknown): TitleValidation {
  if (typeof raw !== "string") return { ok: false, error: "title must be a string." };
  const title = raw.trim();
  if (!title) return { ok: false, error: "title must not be empty (it was blank after trimming)." };
  if (title.length > 80) {
    return {
      ok: false,
      error: `title is too long: ${title.length} characters against a hard max of 80. Aim for about 50 - it renders in the session tab strip.`,
    };
  }
  if (title === EXTRACTION_CHILD_TITLE) {
    return { ok: false, error: "that title is reserved for plugin machinery sessions; pick a task title." };
  }
  return { ok: true, title };
}

/** Result of validating the exactly-one-of worktree/directory rule. */
export type LocationValidation =
  | { ok: true; kind: "worktree" | "directory"; path: string }
  | { ok: false; error: string };

/**
 * The tool takes exactly one location arg. The two kinds differ in
 * validation and intent, not in tab placement: either way the tab opens in
 * the coordinator's window (the tab-open event anchors on the coordinator
 * session, never on the subordinate's location).
 */
export function validateLocationArgs(args: { worktree?: unknown; directory?: unknown }): LocationValidation {
  const hasWorktree = typeof args.worktree === "string" && args.worktree.trim() !== "";
  const hasDirectory = typeof args.directory === "string" && args.directory.trim() !== "";
  if (hasWorktree && hasDirectory) {
    return { ok: false, error: "Pass exactly ONE location: worktree (a git worktree of the current repository) or directory (any existing directory), not both." };
  }
  if (hasWorktree) return { ok: true, kind: "worktree", path: (args.worktree as string).trim() };
  if (hasDirectory) return { ok: true, kind: "directory", path: (args.directory as string).trim() };
  return { ok: false, error: "Pass exactly one location: worktree (a git worktree of the current repository) or directory (any existing directory)." };
}

/**
 * Whether two directories belong to the same repository, by main-checkout
 * identity (the parent of the absolute git common dir) rather than path
 * equality - the coordinator may itself run in a worktree of the repo the
 * candidate worktree hangs off. Realpaths on both sides: on macOS /tmp
 * resolves to /private/tmp, and the two resolutions must agree on the
 * comparison. Null (outside git, bare repo, spawn failure) never matches.
 */
export async function isSameMainCheckout(a: string, b: string): Promise<boolean> {
  const [mainA, mainB] = await Promise.all([resolveMainCheckout(a), resolveMainCheckout(b)]);
  if (!mainA || !mainB) return false;
  try {
    return realpathSync(mainA) === realpathSync(mainB);
  } catch {
    return false;
  }
}

/** TUI-side, pure so the session-tab tests can run without the TUI runtime. */

/** The event-type filter the TUI CLI plugin applies to every fed event. */
export function isTabOpenedEvent(type: string): boolean {
  return type === tabOpenedEventType;
}

/** The close-request filter: same transport, opposite action. */
export function isTabClosedEvent(type: string): boolean {
  return type === tabClosedEventType;
}

/** The wrap-up exit's close filter: same TUI action, no pump translation. */
export function isExitTabClosedEvent(type: string): boolean {
  return type === exitTabClosedEventType;
}

/** The toast-request filter: TUI-only by nature. */
export function isToastEvent(type: string): boolean {
  return type === toastEventType;
}

/**
 * Directory equality with fail-closed semantics: an event with no location
 * (theirs or the window's) never acts, the same as the built-in tui.*
 * handlers' inequality check. Callers pass the window directory identity the
 * event class routes by - viewed directory for toasts, default directory for
 * the open fallback (see actsOnTabEvent).
 */
export function passesDirectoryGuard(eventDirectory: string | undefined, windowDirectory: string | undefined): boolean {
  if (!eventDirectory || !windowDirectory) return false;
  return eventDirectory === windowDirectory;
}

/** Named inputs to actsOnTabEvent - three same-typed directories would
 * transpose silently as positional args. */
export interface TabEventRoute {
  /** The fully-qualified rpc event type (e.g. "rpc.thatch-tabs.tab-opened"). */
  type: string;
  /** The rpc envelope's location stamp (the emitting instance's directory). */
  eventDirectory: string | undefined;
  /** The directory of the session the window is viewing (follows tab switches). */
  viewedDirectory: string | undefined;
  /** The window's own cwd - the directory the tab strip keys its tabs by. */
  defaultDirectory: string | undefined;
  /** Whether this window's strip holds a tab for the coordinator session
   *  (matched by root id). */
  windowHoldsCoordinatorTab: boolean;
}

/**
 * Whether a fed rpc event should act in the window that received it.
 *
 * CLOSE events (tab-closed, exit-tab-closed) always act: the close is
 * session-scoped. A session that moved after its tab was opened (root ->
 * worktree via session.move) stamps its exit with the NEW directory while
 * the tab lives in the ORIGINAL window, so the directory guard would drop
 * every moved session's close (observed live 2026-10-15: an exit-tab-closed
 * stamped /wt-thog/<branch> reached the /thog window holding the tab and was
 * dropped; the tab stayed open). Matching by sessionID within the window's
 * own tab list is the scoping that matters - a window can only close tabs
 * it actually holds.
 *
 * TOAST events keep the viewed-directory guard: a toast is attached to the
 * session whose runtime emitted it, so "show it where that session is on
 * screen" is the right routing, and the built-in tui.* guard (which compares
 * the event's location against the window's current location context) is
 * exactly that.
 *
 * OPEN events anchor on the COORDINATOR, in two steps. A viewed-directory
 * guard would drop a spawn whenever the coordinator window is
 * viewing another tab: the TUI's location context follows the viewed
 * session's directory, and worktree or foreign-repo tabs never match the
 * coordinator instance's directory. Observed live 2026-10-20: every spawn
 * from a coordinator window parked on a worktree or thog-deployments tab
 * produced no tab anywhere. (The same no-tab symptom also arises from the
 * dead-listener race - docs/dev/gotchas.md, "A TUI started during a daemon
 * replacement".) Step 1: a window holding a tab for the
 * coordinator session itself acts - the coordinator's tab is the stable
 * identity of "the coordinator's window" and survives both tab switching
 * and a coordinator session that lives in a worktree. Step 2: the window
 * whose default directory (its own cwd - the directory the tab strip keys
 * its tabs by) matches the event's location. This covers a coordinator
 * whose own tab is closed or was never opened, and an older server process
 * that emits no coordinatorSessionID; same-cwd windows share one tab list,
 * so both windows acting is the normal shared-strip outcome, not a bug.
 * There is NO viewed-directory fallback: it would leak a spawn into a
 * foreign-project window that happens to be viewing a same-directory
 * session.
 */
export function actsOnTabEvent(route: TabEventRoute): boolean {
  const { type, eventDirectory, viewedDirectory, defaultDirectory, windowHoldsCoordinatorTab } = route;
  if (isTabClosedEvent(type) || isExitTabClosedEvent(type)) return true;
  if (isToastEvent(type)) return passesDirectoryGuard(eventDirectory, viewedDirectory);
  if (windowHoldsCoordinatorTab) return true;
  return passesDirectoryGuard(eventDirectory, defaultDirectory);
}
