import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAT_STALE_MS } from "./chat";

/**
 * Reader for opencode's per-TUI-instance tab persistence - the roster's
 * OPEN-vs-RECENT signal. Each opencode TUI window records its open tabs in
 * `<XDG_STATE_HOME>/opencode/<channel>/tui/tabs.json` (the middle segment is
 * the release CHANNEL - "latest" today, so a reader must glob, never
 * hardcode). The file answers "which sessions have a tab right now" for
 * roster classification and broadcast targeting; it is READ-ONLY here -
 * the heartbeat stays the only written liveness signal.
 *
 * This is a presence refinement, not a truth source. A killed window leaves
 * its tab rows behind (the file is restart persistence by design), so a row
 * classified OPEN may occasionally be residue; that trade is accepted in
 * exchange for zero new writers. With tabs disabled (or no state tree at
 * all) the reader returns an empty set and every row honestly degrades to
 * RECENT - never a false OPEN.
 */

/** Test/QA override for the opencode state root (the directory that holds
 *  one subdirectory per release channel). Unset means the real location. */
export const OPEN_TABS_STATE_ROOT_ENV = "THATCH_OPENCODE_STATE_ROOT";

/** The opencode state root: the directory containing one directory per
 *  release channel ("latest" today). */
export function openTabsStateRoot(env: Record<string, string | undefined> = process.env): string {
  const override = env[OPEN_TABS_STATE_ROOT_ENV];
  if (override) return override;
  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "opencode");
}

/** Shape of tabs.json (opencode v2.0.25, session-tabs storage): an optional
 *  global section and a per-cwd section, each carrying tab rows with a
 *  sessionID. Both sections are read because the scope depends on the
 *  `tabs.scope` config ("cwd" or "global") and the reader must honor both. */
interface TabsFile {
  global?: { tabs?: { sessionID?: string }[] };
  cwd?: Record<string, { tabs?: { sessionID?: string }[] }>;
}

function collectTabs(rows: { sessionID?: string }[] | undefined, into: Set<string>): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (row && typeof row.sessionID === "string" && row.sessionID) into.add(row.sessionID);
  }
}

/**
 * Every sessionID carrying a tab in ANY channel's tabs.json, from both
 * scope modes (global section and cwd sections). Per-file failures (no
 * file, bad JSON, malformed sections) are swallowed and contribute
 * nothing: a missing or broken signal degrades to empty, never to an
 * error, so roster rendering and broadcast targeting keep working.
 */
export function readOpenTabSessions(stateRoot: string = openTabsStateRoot()): Set<string> {
  const open = new Set<string>();
  let channels: string[];
  try {
    channels = readdirSync(stateRoot).filter((name) => !name.startsWith("."));
  } catch {
    // No state tree (opencode never ran here, or tabs are disabled):
    // empty set, everything degrades to RECENT.
    return open;
  }
  for (const channel of channels) {
    let parsed: TabsFile;
    try {
      parsed = JSON.parse(readFileSync(join(stateRoot, channel, "tui", "tabs.json"), "utf8"));
    } catch {
      continue;
    }
    collectTabs(parsed?.global?.tabs, open);
    const byCwd = parsed?.cwd;
    if (byCwd && typeof byCwd === "object") {
      for (const section of Object.values(byCwd)) collectTabs(section?.tabs, open);
    }
  }
  return open;
}

/** How long a confirmed tab close keeps overriding a residue tab row. The
 *  close's death path stops the heartbeat, so the row can only read fresh
 *  until its frozen last_seen crosses CHAT_STALE_MS; one extra poll
 *  interval covers a beat already in flight at close time. After the
 *  window the marker is moot (the row is stale regardless), and a session
 *  that later regains a tab re-derives OPEN from tabs.json alone. */
export const CHAT_TAB_CLOSED_OVERRIDE_MS = 2 * CHAT_STALE_MS;

/** One confirmed tab close: the session's tab was closed by the
 *  session_tab tool and the bridge event confirmed it. */
export interface ChatTabClosure {
  sessionID: string;
  /** ISO timestamp of the confirmed close. */
  at: string;
}

/**
 * Subtracts fresh confirmed tab closes from the raw tab set, so a residue
 * row in tabs.json (a window that died between the tool's close event and
 * the file write - or before it) cannot read OPEN right after a confirmed
 * close. Closures older than CHAT_TAB_CLOSED_OVERRIDE_MS are ignored.
 */
export function effectiveOpenTabs(openTabs: ReadonlySet<string>, closures: ChatTabClosure[], now = Date.now()): Set<string> {
  const effective = new Set(openTabs);
  for (const closure of closures) {
    const at = Date.parse(closure.at);
    if (Number.isNaN(at)) continue;
    if (now - at < CHAT_TAB_CLOSED_OVERRIDE_MS) effective.delete(closure.sessionID);
  }
  return effective;
}

/**
 * The production open-tabs provider: read tabs.json at call time (never
 * cached - the file changes between renders) and subtract the confirmed
 * closes recorded in thatch.db. `loadClosures` is the ThatchDB lookup,
 * injected so this composes with any database handle.
 */
export function chatOpenTabs(loadClosures: () => ChatTabClosure[]): () => Set<string> {
  return () => effectiveOpenTabs(readOpenTabSessions(), loadClosures());
}
