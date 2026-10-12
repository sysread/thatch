import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_TAB_CLOSED_OVERRIDE_MS,
  effectiveOpenTabs,
  openTabsStateRoot,
  readOpenTabSessions,
} from "../src/tab-state";

/** Builds a fake opencode state root with one tabs.json per channel.
 *  Pass null as the payload to skip the file entirely for that channel. */
function makeStateRoot(channels: Record<string, object | null>): string {
  const root = mkdtempSync(join(tmpdir(), "thatch-tab-state-"));
  for (const [channel, payload] of Object.entries(channels)) {
    const dir = join(root, channel, "tui");
    mkdirSync(dir, { recursive: true });
    if (payload !== null) writeFileSync(join(dir, "tabs.json"), JSON.stringify(payload));
  }
  return root;
}

// cwd-scope shape (this machine's mode): tabs live under cwd["<path>"].
const cwdScope = (...ids: string[]) => ({
  global: { tabs: [], unread: {} },
  cwd: {
    "/Users/x/project": { tabs: ids.map((sessionID) => ({ sessionID, title: "t" })), unread: {} },
  },
});

describe("readOpenTabSessions", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("reads cwd-scope tabs and ignores the session-less remainder", () => {
    const root = makeStateRoot({ latest: cwdScope("ses_a", "ses_b") });
    roots.push(root);
    expect([...readOpenTabSessions(root)].sort()).toEqual(["ses_a", "ses_b"]);
  });

  test("honors the global scope (tabs.scope: global)", () => {
    const root = makeStateRoot({
      latest: { global: { tabs: [{ sessionID: "ses_g" }, { sessionID: "ses_h" }], unread: {} }, cwd: {} },
    });
    roots.push(root);
    expect([...readOpenTabSessions(root)].sort()).toEqual(["ses_g", "ses_h"]);
  });

  test("unions every channel directory - the channel name is never hardcoded", () => {
    const root = makeStateRoot({
      latest: cwdScope("ses_a"),
      dev: { global: { tabs: [{ sessionID: "ses_dev" }], unread: {} }, cwd: {} },
    });
    roots.push(root);
    const open = readOpenTabSessions(root);
    expect(open.has("ses_a")).toBe(true);
    expect(open.has("ses_dev")).toBe(true);
  });

  test("no state tree, missing files, or bad JSON degrade to an empty set", () => {
    // Root does not exist at all.
    expect(readOpenTabSessions(join(tmpdir(), "thatch-tab-state-absent"))).toEqual(new Set());
    // A channel with no tabs.json next to a readable one.
    const root = makeStateRoot({ latest: cwdScope("ses_a"), broken: null });
    roots.push(root);
    expect([...readOpenTabSessions(root)]).toEqual(["ses_a"]);
    // Unparseable JSON contributes nothing.
    const badRoot = mkdtempSync(join(tmpdir(), "thatch-tab-state-"));
    roots.push(badRoot);
    mkdirSync(join(badRoot, "latest", "tui"), { recursive: true });
    writeFileSync(join(badRoot, "latest", "tui", "tabs.json"), "{not json");
    expect(readOpenTabSessions(badRoot)).toEqual(new Set());
  });

  test("malformed sections and rows are tolerated", () => {
    const root = makeStateRoot({
      latest: {
        global: { tabs: [{}, { sessionID: "" }, { sessionID: "ses_ok" }, "junk"], unread: {} },
        cwd: { "/p": { tabs: "not-an-array" } },
      } as any,
    });
    roots.push(root);
    expect([...readOpenTabSessions(root)]).toEqual(["ses_ok"]);
  });
});

describe("effectiveOpenTabs (confirmed-close override)", () => {
  test("a fresh closure removes the session; an expired one does not", () => {
    const now = Date.now();
    const open = new Set(["ses_a", "ses_b", "ses_c"]);
    const closures = [
      { sessionID: "ses_a", at: new Date(now - 1_000).toISOString() },
      { sessionID: "ses_b", at: new Date(now - CHAT_TAB_CLOSED_OVERRIDE_MS - 5_000).toISOString() },
      { sessionID: "ses_d", at: new Date(now - 1_000).toISOString() },
      { sessionID: "ses_e", at: "not-a-timestamp" },
    ];
    const effective = effectiveOpenTabs(open, closures, now);
    expect(effective.has("ses_a")).toBe(false);
    expect(effective.has("ses_b")).toBe(true);
    expect(effective.has("ses_c")).toBe(true);
    // A closure for a session with no tab row is a no-op, not an error.
    expect(effective.size).toBe(2);
  });

  test("does not mutate the input set", () => {
    const open = new Set(["ses_a"]);
    effectiveOpenTabs(open, [{ sessionID: "ses_a", at: new Date().toISOString() }]);
    expect(open.has("ses_a")).toBe(true);
  });
});

describe("openTabsStateRoot", () => {
  test("derives from XDG_STATE_HOME, honors the test override", () => {
    expect(openTabsStateRoot({ XDG_STATE_HOME: "/s" })).toBe(join("/s", "opencode"));
    // No XDG_STATE_HOME: the ~/.local/state default (whatever the home is).
    expect(openTabsStateRoot({})).toMatch(/\.local\/state\/opencode$/);
    const env = {};
    (env as any)[`THATCH_OPENCODE_STATE_ROOT`] = "/custom/root";
    expect(openTabsStateRoot(env)).toBe("/custom/root");
  });
});
