// Chat auto-registration and tombstone tests from plugin.test.ts, re-based
// onto the v2 harness (the drop-v1 plan's Phase A-prime): idle, prompt, and
// startup registration paths, the argv/session-resolution helpers, and the
// session.deleted tombstone guarantee. The v1 custom mock clients map to
// makeContext option overrides; toasts ride the rpc bridge's toast event;
// the -c continue resolution re-pins onto the db-read path
// (mostRecentTopLevelSessionId reads opencode.db from OPENCODE_DB - the v2
// plugin context has no session.list).

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setup } from "../src/opencode/v2";
import { EXTRACTION_CHILD_TITLE } from "../src/chat";
import { saveConfig } from "../src/config";
import { ThatchDB } from "../src/db";
import { TOAST_EVENT } from "../src/session-tab-shared";
import {
  osProcessArgs,
  startupSessionId,
  startupSessionIdFromArgv,
  continuesLastSessionFromArgv,
  continuesLastSessionId,
} from "../src/index";
import {
  makeContext,
  promptHook,
  queueEvent,
  rpcEmitted,
  SESSION_DIR,
  sessionListCalls,
  sessionSyntheticCalls,
  setupTestEnv,
  teardownTestEnv,
  waitFor,
} from "./mocks/opencode-v2-harness";

// These tests pump async events through the v2 adapter harness; under a
// loaded CI runner the pump can lag. Bun's default per-test timeout is 5s
// with no margin for that (the 2026-11-03 fleet-contention CI reds). 90s =
// expected (ms-scale pump handling) x ~900 headroom, above the harness
// waitFor deadline so real hangs report the poll message.
setDefaultTimeout(90_000);

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  setupTestEnv();
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  await teardownTestEnv();
});

// The v2 bus envelope for a session event: payload in `data`, and a
// location so the pump's directory filter routes it to this instance.
const sessionEvent = (type: string, data: Record<string, unknown>) => ({
  type,
  location: { directory: SESSION_DIR },
  data: { ...data },
});

// The parent's idle: v2's execution lifecycle event (the idle signal).
const parentIdle = (sessionID: string) => sessionEvent("session.execution.succeeded", { sessionID });

// Toasts ride the rpc bridge's toast event (data: the ToastInput).
const toasts = () => rpcEmitted.filter((e) => e.name === TOAST_EVENT);
const toastWith = (needle: string) => toasts().find((e) => String(e.data?.message).includes(needle));

// The auto-register IIFE fetches the live title via session.get; these
// tests vary only that title, so a factory keeps each test's variable
// explicit. (On v1 the auto-register client was a custom mock; on v2 the
// makeContext `get` override plays that role.)
let arTitle = "New session - 2026-09-13T10:00:00Z";
const autoRegisterContext = () => makeContext({ get: async () => ({ title: arTitle }) });

const dbRow = (sessionID: string): { name: string; topic: string | null; last_seen: string } | undefined =>
  new ThatchDB(process.env.THATCH_DB_PATH!).listChatSessions().find((r) => r.session_id === sessionID) as
    | { name: string; topic: string | null; last_seen: string }
    | undefined;

describe("chat auto-registration (idle, prompt, startup)", () => {
  test("first idle registers a top-level session with a pool-slug name; a later idle converges the topic", async () => {
    cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;

    // First idle: placeholder title -> registers with a pool-slug base and
    // no topic.
    await queueEvent(parentIdle("ses_ar1"));
    await waitFor("first idle registration", () => dbRow("ses_ar1") !== undefined);
    const row1 = dbRow("ses_ar1")!;
    expect(row1.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
    expect(row1.topic).toBeNull();
    // First registration toasts; it must not say anything on later idles.
    await waitFor("the registration toast", () => toastWith("registered in chat as") !== undefined);

    // The auto-titler lands a real title; the next idle must converge the
    // topic (and keep the name - names never re-slug).
    arTitle = "Fix the auth bug";
    await queueEvent(parentIdle("ses_ar1"));
    await waitFor("the topic convergence", () => dbRow("ses_ar1")!.topic === "Fix the auth bug");
    const row2 = dbRow("ses_ar1")!;
    expect(row2.name).toBe(row1.name);

    // chat_unregister tombstones; the NEXT idle must not re-register.
    const arDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    arDb.unregisterChatSession("ses_ar1");
    expect(arDb.hasChatLeaveTombstone("ses_ar1")).toBe(true);
    arDb.close();
    await queueEvent(parentIdle("ses_ar1"));
    // Negative wait: the pump's handler is async; settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(dbRow("ses_ar1")).toBeUndefined();
    expect(new ThatchDB(process.env.THATCH_DB_PATH!).hasChatLeaveTombstone("ses_ar1")).toBe(true);
  });

  test("osProcessArgs reads this process's real command line", () => {
    // The plugin loads in a worker thread whose argv is just the worker
    // script - the real CLI flags are only visible on the OS-level command
    // line for our own pid. With the real readers, the helper must return
    // that command line here (the bun test invocation), which carries no
    // session flag.
    const args = osProcessArgs();
    expect(args.length).toBeGreaterThan(0);
    expect(startupSessionIdFromArgv(args)).toBeNull();
  });

  test("osProcessArgs: /proc cmdline is NUL-split; ps is the fallback; failures yield []", () => {
    const noProc = () => {
      throw new Error("ENOENT");
    };
    // Linux: NUL-separated, trailing NUL dropped, ps never consulted.
    expect(
      osProcessArgs({ readFile: () => "opencode\0-s\0ses_linux\0", ps: () => { throw new Error("must not run"); } }),
    ).toEqual(["opencode", "-s", "ses_linux"]);
    // macOS: no /proc, ps output is whitespace-split.
    expect(osProcessArgs({ readFile: noProc, ps: () => ({ exitCode: 0, stdout: "  opencode -s ses_mac\n" }) }, 4242)).toEqual([
      "opencode", "-s", "ses_mac",
    ]);
    // ps failing (nonzero exit, or throwing when the binary is missing)
    // reads as "no command line", never as an exception at plugin init.
    expect(osProcessArgs({ readFile: noProc, ps: () => ({ exitCode: 1, stdout: "" }) })).toEqual([]);
    expect(osProcessArgs({ readFile: noProc, ps: () => { throw new Error("spawn failed"); } })).toEqual([]);
    // ps receives the pid it was asked about.
    let asked = -1;
    osProcessArgs({ readFile: noProc, ps: (pid) => { asked = pid; return { exitCode: 0, stdout: "" }; } }, 777);
    expect(asked).toBe(777);
  });

  test("startupSessionId prefers thread-local argv, then the OS command line", () => {
    // The real harness path: the worker's argv has no -s, the OS command
    // line does. Under test the thread argv is bun's, so the OS list wins.
    expect(startupSessionId(["opencode", "-s", "ses_from_os"])).toBe("ses_from_os");
    expect(startupSessionId([])).toBeNull();
    const argvSave = process.argv;
    process.argv = [...argvSave, "--session=ses_thread"];
    try {
      expect(startupSessionId(["opencode", "-s", "ses_from_os"])).toBe("ses_thread");
    } finally {
      process.argv = argvSave;
    }
  });

  test("continuesLastSessionFromArgv parses -c/--continue; continuesLastSessionId picks the newest top-level session", () => {
    expect(continuesLastSessionFromArgv(["opencode", "-c"])).toBe(true);
    expect(continuesLastSessionFromArgv(["opencode", "--continue"])).toBe(true);
    expect(continuesLastSessionFromArgv(["opencode", "--continue=true"])).toBe(true);
    expect(continuesLastSessionFromArgv(["opencode", "--continue=false"])).toBe(false);
    expect(continuesLastSessionFromArgv(["opencode"])).toBe(false);
    expect(continuesLastSessionFromArgv(["opencode", "-s", "ses_x"])).toBe(false);

    // Newest time.updated wins; children (parentID set) are never picked -
    // the TUI's own -c resolution skips them.
    const sessions = [
      { id: "ses_old_top", time: { updated: 100 } },
      { id: "ses_child", parentID: "ses_old_top", time: { updated: 300 } },
      { id: "ses_new_top", time: { updated: 200 } },
    ];
    expect(continuesLastSessionId(sessions)).toBe("ses_new_top");
    expect(continuesLastSessionId([])).toBeNull();
    expect(continuesLastSessionId([{ id: "s1", parentID: "p" }])).toBeNull();
  });

  test("chat.autoRegister: false suppresses auto-registration but not chat_register", async () => {
    arTitle = "Real Title Here";
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    saveConfig({ chat: { autoRegister: false } });
    try {
      cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;

      await queueEvent(parentIdle("ses_ar2"));
      // Negative wait: the pump's handler is async; settle before asserting.
      await new Promise((r) => setTimeout(r, 300));
      expect(dbRow("ses_ar2")).toBeUndefined();
    } finally {
      // The config file is shared across this suite's tests (one dbDir):
      // restore the default (no file) even on failure, so later tests
      // auto-register again.
      rmSync(configPath);
    }
  });

  test("-s resume reclaims the row, refreshes its heartbeat, delivers asleep-mail", async () => {
    // A session continued via `opencode -s <id>`: its row exists from a
    // PREVIOUS harness (heartbeat long lapsed) with mail that queued while
    // it was down. Startup registration must reclaim the row (same name -
    // names are owned by the session id), refresh its heartbeat, and wake
    // it with the asleep-mail at init.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_resume", "thatch-resume", "Continued session", "opencode");
    seedDb.registerChatSession("ses_rsnd", "thatch-resume", null, "opencode", "resender");
    seedDb.sendChatMessage("ses_rsnd", "ses_resume", "while you were asleep");
    seedDb.close();
    new Database(process.env.THATCH_DB_PATH!).run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_resume'");

    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_resume"];
    try {
      cleanup = (await setup(makeContext({ get: async () => ({ title: "Continued session" }) }) as any)) as () => Promise<void>;
      await waitFor("the -s startup registration", () => dbRow("ses_resume") !== undefined);
      const row = dbRow("ses_resume")!;
      // Same row, SAME NAME (owned by the session id), heartbeat fresh again.
      expect(row.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
      expect(Date.now() - Date.parse(row.last_seen)).toBeLessThan(60_000);
      expect(row.topic).toBe("Continued session");
      // The asleep-mail woke it at init - a WAKING synthetic (no resume
      // key; a noReply delivery would carry resume: false).
      await waitFor("the asleep-mail wake", () =>
        sessionSyntheticCalls.some((c: any) => c?.sessionID === "ses_resume" && String(c?.text).includes("1 unread message from resender-00001")),
      );
      const wake = sessionSyntheticCalls.find((c: any) => c?.sessionID === "ses_resume");
      expect(wake?.resume).toBeUndefined();
      // The delivery stamp is written after the wake resolves; poll for it.
      const stamped = (): boolean =>
        ((new Database(process.env.THATCH_DB_PATH!)
          .query("SELECT delivered_at FROM chat_messages WHERE to_session = 'ses_resume'")
          .get() as any)?.delivered_at ?? null) !== null;
      await waitFor("the asleep-mail delivery stamp", () => stamped());
      expect(stamped()).toBe(true);
      // The reclaim announcement waits for the first prompt - the TUI is
      // not connected at init, so an immediate toast would drop silently.
      expect(toastWith("rejoined chat as")).toBeUndefined();
      await promptHook!({ sessionID: "ses_resume", messageID: "msg_resume", prompt: { text: "hello, what is your chat name?" } });
      await waitFor("the rejoin toast", () => toastWith("rejoined chat as") !== undefined);
      expect(toastWith("rejoined chat as")!.data.message).toContain(row.name);
    } finally {
      process.argv = argvSave;
    }
  });

  test("-s startup registration honors chat.autoRegister: false", async () => {
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    saveConfig({ chat: { autoRegister: false } });
    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_noauto"];
    try {
      cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
      // Negative wait: the pump's handler is async; settle before asserting.
      await new Promise((r) => setTimeout(r, 300));
      expect(dbRow("ses_noauto")).toBeUndefined();
    } finally {
      process.argv = argvSave;
      rmSync(configPath);
    }
  });

  test("-s startup registration honors a leave tombstone", async () => {
    // The session left explicitly (chat_unregister or TUI delete) in a
    // previous harness; resuming it must not drag it back into the
    // directory. Only an explicit chat_register clears the tombstone.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_left", "thatch-left", null, "opencode", "leaver");
    seedDb.unregisterChatSession("ses_left");
    expect(seedDb.hasChatLeaveTombstone("ses_left")).toBe(true);
    seedDb.close();
    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_left"];
    try {
      cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
      // Negative wait: the pump's handler is async; settle before asserting.
      await new Promise((r) => setTimeout(r, 300));
      expect(dbRow("ses_left")).toBeUndefined();
      expect(new ThatchDB(process.env.THATCH_DB_PATH!).hasChatLeaveTombstone("ses_left")).toBe(true);
    } finally {
      process.argv = argvSave;
    }
  });

  test("-s startup restore-rejoin clears an exit tombstone and registers", async () => {
    // The session left via the wrap-up exit (the host vanished); resuming
    // it IS the host coming back, so it rejoins instead of staying
    // chat-deaf. The registration is fresh (created: true), so the
    // chatStartupNames toast path announces it.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_restore", "thatch-restore", null, "opencode", "restorer");
    seedDb.unregisterChatSession("ses_restore", "exit");
    expect(seedDb.hasChatLeaveTombstone("ses_restore")).toBe(true);
    seedDb.close();
    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_restore"];
    try {
      cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
      await waitFor("the restore-rejoin registration", () => dbRow("ses_restore") !== undefined);
      expect(new ThatchDB(process.env.THATCH_DB_PATH!).hasChatLeaveTombstone("ses_restore")).toBe(false);
    } finally {
      process.argv = argvSave;
    }
  });

  test("-s startup keeps an explicit tombstone while clearing an exit one", async () => {
    // Both tombstone reasons exist on the same db for different sessions:
    // the explicit leave suppresses, the exit leave rejoins.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_explicit", "thatch-explicit", null, "opencode", "explicit");
    seedDb.unregisterChatSession("ses_explicit", "explicit");
    seedDb.close();
    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_explicit"];
    try {
      cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
      // Negative wait: the pump's handler is async; settle before asserting.
      await new Promise((r) => setTimeout(r, 300));
      expect(dbRow("ses_explicit")).toBeUndefined();
      expect(new ThatchDB(process.env.THATCH_DB_PATH!).hasChatLeaveTombstone("ses_explicit")).toBe(true);
    } finally {
      process.argv = argvSave;
    }
  });

  test("chat.message registers an unregistered top-level session before the model runs", async () => {
    cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
    await promptHook!({ sessionID: "ses_pr1", messageID: "msg_pr1", prompt: { text: "hello, what is your chat name?" } });
    const row = dbRow("ses_pr1");
    expect(row).toBeDefined();
    expect(row!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
    // Placeholder title at prompt time - the topic converges on idle.
    expect(row!.topic).toBeNull();
    expect(toastWith("registered in chat as")).toBeDefined();

    // Second prompt: touch, not a second registration - one toast total.
    await promptHook!({ sessionID: "ses_pr1", messageID: "msg_pr2", prompt: { text: "second prompt" } });
    expect(toasts().filter((e) => String(e.data?.message).includes("registered in chat as")).length).toBe(1);
  });

  test("chat.message does not register a sub-agent child session", async () => {
    cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_pr_child",
      info: { id: "ses_pr_child", parentID: "ses_pr_parent" },
    }));
    await promptHook!({ sessionID: "ses_pr_child", messageID: "msg_child", prompt: { text: "child prompt" } });
    // The child's session.created link is set by the async pump handler;
    // settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(dbRow("ses_pr_child")).toBeUndefined();
  });

  test("first idle does not register a sub-agent child session", async () => {
    // The idle auto-register path (the backstop for sessions whose TUI was
    // not connected at init) had no child check: every fact-extractor run
    // registered a roster row on its terminal idle - the "thatch-extraction"
    // corpse flood (September 2026). Children are machinery, not chat
    // participants, on BOTH registration paths.
    cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_idle_child",
      info: { id: "ses_idle_child", parentID: "ses_idle_parent" },
    }));
    // The child's run ends: its terminal idle must not register it.
    await queueEvent(parentIdle("ses_idle_child"));
    // Negative wait: the pump's handler is async; settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(dbRow("ses_idle_child")).toBeUndefined();
  });

  test("machinery marker blocks auto-registration on both paths and self-heals a corpse row", async () => {
    // The childToParent map is in-memory and lost to a plugin reload or
    // daemon restart; the observed thatch-extraction corpse rows (81 by
    // 2026-10-07) came from an instance whose mapping was gone when the
    // extraction child's events landed. The durable chat_machinery marker
    // (written by triggerExtraction at child creation) closes that window:
    // it must block the prompt path, and the idle path must also delete a
    // corpse row an earlier race already registered.
    cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
    const machDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    machDb.markChatMachinery("ses_mach", "extraction");

    // Prompt path: the marker alone refuses registration (no row, no
    // tombstone - this session never left, it was never a participant).
    await promptHook!({ sessionID: "ses_mach", messageID: "msg_mach", prompt: { text: "hello" } });
    expect(dbRow("ses_mach")).toBeUndefined();

    // Idle path, corpse variant: a row exists from the mapping-less race.
    // The marker short-circuits registration AND deletes the corpse.
    machDb.registerChatSession("ses_mach", "thatch-machinery", EXTRACTION_CHILD_TITLE, "opencode");
    machDb.close();
    await queueEvent(parentIdle("ses_mach"));
    await new Promise((r) => setTimeout(r, 300));
    expect(dbRow("ses_mach")).toBeUndefined();
  });

  test("idle auto-register skips a session titled as the extraction child even without a marker", async () => {
    // Belt-and-suspenders for a machinery session whose marker aged out or
    // was never written: the fetched title alone refuses registration.
    const savedTitle = arTitle;
    arTitle = EXTRACTION_CHILD_TITLE;
    try {
      cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
      await queueEvent(parentIdle("ses_title_mach"));
      // Negative wait: the auto-register IIFE runs after session.get;
      // settle before asserting.
      await new Promise((r) => setTimeout(r, 300));
      expect(dbRow("ses_title_mach")).toBeUndefined();
    } finally {
      arTitle = savedTitle;
    }
  });

  test("chat.message honors an explicit leave tombstone", async () => {
    // unregisterChatSession's default reason is "explicit" (the
    // chat_unregister tool's leave): a deliberate leave persists - the
    // restored session's next prompt does NOT undo it. Only an explicit
    // chat_register rejoin clears it.
    cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
    const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    prDb.registerChatSession("ses_pr_left", "thatch-pr", null, "opencode", "leaver");
    prDb.unregisterChatSession("ses_pr_left");
    await promptHook!({ sessionID: "ses_pr_left", messageID: "msg_left", prompt: { text: "hello" } });
    expect(dbRow("ses_pr_left")).toBeUndefined();
    expect(prDb.hasChatLeaveTombstone("ses_pr_left")).toBe(true);
    prDb.close();
  });

  test("chat.message restore-rejoin clears an exit tombstone and registers", async () => {
    // A restored session's first real user message clears the wrap-up
    // exit's tombstone (the host is back) and rejoins the directory.
    cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
    const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    prDb.registerChatSession("ses_pr_restore", "thatch-pr", null, "opencode", "restorer");
    prDb.unregisterChatSession("ses_pr_restore", "exit");
    expect(prDb.hasChatLeaveTombstone("ses_pr_restore")).toBe(true);
    await promptHook!({ sessionID: "ses_pr_restore", messageID: "msg_restore", prompt: { text: "hello" } });
    const row = dbRow("ses_pr_restore");
    expect(row).toBeDefined();
    expect(prDb.hasChatLeaveTombstone("ses_pr_restore")).toBe(false);
    prDb.close();
  });

  test("chat.message restore-rejoin clears a deleted-reason tombstone (resumed subordinate)", async () => {
    // session.deleted tombstones are "deleted" reason: a dispatched
    // subordinate is deleted routinely, and resuming one should rejoin on
    // the next prompt rather than stay roster-deaf forever.
    cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
    const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    prDb.registerChatSession("ses_pr_deleted", "thatch-pr", null, "opencode", "deleted");
    prDb.unregisterChatSession("ses_pr_deleted", "deleted");
    await promptHook!({ sessionID: "ses_pr_deleted", messageID: "msg_deleted", prompt: { text: "hello" } });
    expect(dbRow("ses_pr_deleted")).toBeDefined();
    expect(prDb.hasChatLeaveTombstone("ses_pr_deleted")).toBe(false);
    prDb.close();
  });

  test("chat.message registration honors chat.autoRegister: false", async () => {
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    saveConfig({ chat: { autoRegister: false } });
    try {
      cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;
      await promptHook!({ sessionID: "ses_pr_noauto", messageID: "msg_noauto", prompt: { text: "hello" } });
      expect(dbRow("ses_pr_noauto")).toBeUndefined();
    } finally {
      rmSync(configPath);
    }
  });
});

describe("session.deleted tombstones auto-registration", () => {
  test("a deleted session's late auto-register IIFE cannot resurrect the row", async () => {
    // Register via a first idle, then delete the session in the TUI: the
    // session.deleted handler must tombstone, so a late/second idle event
    // cannot silently re-register a dead session.
    cleanup = (await setup(autoRegisterContext() as any)) as () => Promise<void>;

    await queueEvent(parentIdle("ses_dl1"));
    await waitFor("the first idle registration", () => dbRow("ses_dl1") !== undefined);

    // User deletes the session in the TUI.
    await queueEvent(sessionEvent("session.deleted", { sessionID: "ses_dl1" }));
    await waitFor("the tombstone", () => dbRow("ses_dl1") === undefined);
    expect(new ThatchDB(process.env.THATCH_DB_PATH!).hasChatLeaveTombstone("ses_dl1")).toBe(true);

    // A straggler idle event (the in-flight IIFE's race window, or a late
    // duplicate) must not resurrect the row.
    await queueEvent(parentIdle("ses_dl1"));
    // Negative wait: the pump's handler is async; settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(dbRow("ses_dl1")).toBeUndefined();
  });
});

// -c startup chat registration, re-pinned onto the v2 session.list path
// (the drop-v1 plan's A-prime fix: the adapter's sessionList scopes
// session.list by this instance's directory - live-probed 2026-11-05 - so
// the continue-target resolution works on v2 exactly as v1's client.list
// did).
describe("-c startup chat registration (v2 session.list path)", () => {
  // The IIFE is fire-and-forget; give the microtask queue a beat.
  const settle = () => new Promise((r) => setTimeout(r, 50));

  test("-c resume reclaims the most recent top-level session at startup", async () => {
    // `opencode -c` continues the most recent top-level session in this
    // directory. The plugin resolves the same target through the v2
    // session.list, so the row's heartbeat is fresh and the poller hosts it
    // before the user's first prompt - the roster shows it Active
    // immediately.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_cont", "thatch-continue", "Continued last", "opencode");
    seedDb.close();
    new Database(process.env.THATCH_DB_PATH!).run(
      "UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_cont'",
    );

    // Directory-scoped list; the child is newer but must never be picked
    // (children are not top-level sessions). The adapter passes this
    // instance's directory as the filter (v1's client.list semantics).
    const contContext = makeContext({
      get: async () => ({ title: "Continued last" }),
      list: async () => ({
        data: [
          { id: "ses_cont_child", parentID: "ses_cont", time: { updated: 300 } },
          { id: "ses_cont", time: { updated: 200 } },
        ],
        cursor: {},
      }),
    });
    const argvSave = process.argv;
    try {
      process.argv = [...argvSave, "-c"];
      cleanup = (await setup(contContext as any)) as () => Promise<void>;
      await settle();
      // The adapter scoped the query to THIS instance's directory (the
      // v1-semantics pin).
      expect(sessionListCalls[0]?.directory).toBe(SESSION_DIR);
      const row = dbRow("ses_cont");
      expect(row).toBeDefined();
      // Same row, same never-reused name shape, heartbeat fresh again,
      // topic converged from the title fetch.
      expect(row!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
      expect(Date.now() - Date.parse(row!.last_seen)).toBeLessThan(60_000);
      // The newer child session is not registered (not top-level).
      expect(dbRow("ses_cont_child")).toBeUndefined();
    } finally {
      process.argv = argvSave;
    }
  });

  test("-c startup registration honors a leave tombstone and chat.autoRegister: false", async () => {
    // Tombstone case: seed a left session; -c resolves it but must not
    // re-register it. The list resolves it as the continue target, so the
    // tombstone (not a missing list) is what blocks.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_cont_left", "thatch-continue", null, "opencode", "leaver");
    seedDb.unregisterChatSession("ses_cont_left");
    seedDb.close();

    const contLeftContext = makeContext({
      list: async () => ({ data: [{ id: "ses_cont_left", time: { updated: 1 } }], cursor: {} }),
    });
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    const argvSave = process.argv;
    try {
      process.argv = [...argvSave, "-c"];
      cleanup = (await setup(contLeftContext as any)) as () => Promise<void>;
      await settle();
      expect(dbRow("ses_cont_left")).toBeUndefined();
      expect(new ThatchDB(process.env.THATCH_DB_PATH!).hasChatLeaveTombstone("ses_cont_left")).toBe(true);

      // autoRegister: false case: a -c restart must not register either.
      cleanup = undefined;
      saveConfig({ chat: { autoRegister: false } });
      cleanup = (await setup(contLeftContext as any)) as () => Promise<void>;
      await settle();
      expect(dbRow("ses_cont_left")).toBeUndefined();
    } finally {
      process.argv = argvSave;
      rmSync(configPath, { force: true });
    }
  });
});
