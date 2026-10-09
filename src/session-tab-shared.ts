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
 * dependency-free. The tab-closed consumer is live: the v2 pump
 * (src/opencode/v2.ts) translates a confirmed close into the runtime's
 * death path, and the TUI plugin closes the tab - change the shape
 * jointly with both consumers (docs/dev/features/session-tabs.md).
 */

import { realpathSync } from "node:fs";
import { EXTRACTION_CHILD_TITLE } from "./chat";
import { resolveMainCheckout } from "./git";

export const SESSION_TAB_RPC_ID = "thatch-tabs";
export const TAB_OPENED_EVENT = "tab-opened";
export const TAB_CLOSED_EVENT = "tab-closed";

/** Full wire type of an emitted event, e.g. "rpc.thatch-tabs.tab-opened". */
export const tabOpenedEventType = `rpc.${SESSION_TAB_RPC_ID}.${TAB_OPENED_EVENT}`;

/** Full wire type of the tab-closed event - the generalized-session-
 *  heartbeat plan's confirmed-close consumer matches on this. */
export const tabClosedEventType = `rpc.${SESSION_TAB_RPC_ID}.${TAB_CLOSED_EVENT}`;

export const SESSION_TAB_RPC = {
  id: SESSION_TAB_RPC_ID,
  methods: {},
  events: {
    [TAB_OPENED_EVENT]: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          directory: { type: "string" },
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
 * the coordinator's window (the tab-open event routes by the coordinator
 * instance's location, never the session's).
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

/**
 * The directory guard mirrors the built-in tui.* handlers: an event only
 * acts on the window whose directory matches the event's location (the
 * coordinator instance's directory). An event with no location never acts -
 * failing closed, the same as the built-ins' inequality check.
 */
export function passesDirectoryGuard(eventDirectory: string | undefined, windowDirectory: string | undefined): boolean {
  if (!eventDirectory || !windowDirectory) return false;
  return eventDirectory === windowDirectory;
}
