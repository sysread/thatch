// Chat auto-registration and tombstone tests from plugin.test.ts: idle,
// prompt, and startup registration paths, the argv/session-resolution
// helpers, and the session.deleted tombstone guarantee.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  server,
  setupPluginHarness,
  teardownPluginHarness,
} from "./mocks/plugin-harness";
import { EXTRACTION_CHILD_TITLE } from "../src/chat";
import { saveConfig } from "../src/config";
import { ThatchDB } from "../src/db";
import {
  osProcessArgs,
  startupSessionId,
  startupSessionIdFromArgv,
  continuesLastSessionFromArgv,
  continuesLastSessionId,
} from "../src/index";

beforeAll(async () => {
  await setupPluginHarness();
});

afterAll(() => {
  teardownPluginHarness();
});

describe("chat auto-registration (idle, prompt, startup)", () => {
  // The auto-register IIFE fetches the live title via client.session.get;
  // these tests vary only that title (and the settle beat for the
  // fire-and-forget IIFE), so a factory keeps each test's variable explicit.
  let arTitle = "New session - 2026-09-13T10:00:00Z";
  const toastCalls: any[] = [];
  const autoRegisterClient = () => ({
    session: {
      prompt: async () => {},
      promptAsync: async () => {},
      create: async () => ({ data: { id: "child_ar" } }),
      delete: async () => {},
      get: async () => ({ data: { title: arTitle } }),
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async (opts: any) => { toastCalls.push(opts); } },
  });
  // The IIFE is fire-and-forget; give the microtask queue a beat.
  const settle = () => new Promise((r) => setTimeout(r, 20));

  test("first idle registers a top-level session with a pool-slug name; a later idle converges the topic", async () => {
    const arHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-ar" } as any);

    // First idle: placeholder title -> registers with a pool-slug base and
    // no topic.
    await arHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_ar1", status: { type: "idle" } } } as any,
    });
    await settle();
    const arDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    const row1 = arDb.listChatSessions().find((r) => r.session_id === "ses_ar1");
    expect(row1).toBeDefined();
    expect(row1!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
    expect(row1!.topic).toBeNull();
    // First registration toasts; it must not say anything on later idles.
    const reg = toastCalls.find((t) => t.body.message.includes("registered in chat as"));
    expect(reg).toBeDefined();

    // The auto-titler lands a real title; the next idle must converge the
    // topic (and keep the name - names never re-slug).
    arTitle = "Fix the auth bug";
    await arHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_ar1", status: { type: "idle" } } } as any,
    });
    await settle();
    const row2 = arDb.listChatSessions().find((r) => r.session_id === "ses_ar1")!;
    expect(row2.name).toBe(row1!.name);
    expect(row2.topic).toBe("Fix the auth bug");

    // chat_unregister tombstones; the NEXT idle must not re-register.
    arDb.unregisterChatSession("ses_ar1");
    expect(arDb.hasChatLeaveTombstone("ses_ar1")).toBe(true);
    await arHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_ar1", status: { type: "idle" } } } as any,
    });
    await settle();
    expect(arDb.listChatSessions().find((r) => r.session_id === "ses_ar1")).toBeUndefined();
    expect(arDb.hasChatLeaveTombstone("ses_ar1")).toBe(true);
    arDb.close();

    arHooks.dispose?.();
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
      const arHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-ar2" } as any);

      await arHooks.event!({ event: {
        type: "session.status",
        properties: { sessionID: "ses_ar2", status: { type: "idle" } } } as any,
      });
      await settle();
      const arDb2 = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(arDb2.listChatSessions().find((r) => r.session_id === "ses_ar2")).toBeUndefined();
      arDb2.close();

      arHooks.dispose?.();
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

    const promptAsyncs: any[] = [];
    const resumeClient = {
      ...autoRegisterClient(),
      session: {
        ...autoRegisterClient().session,
        get: async () => ({ data: { title: "Continued session" } }),
        promptAsync: async (args: any) => {
          promptAsyncs.push(args);
        },
      },
    };
    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_resume"];
    let resumeHooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      resumeHooks = await server({ client: resumeClient, worktree: "/tmp/thatch-resume" } as any);
      await settle();
      const row = new ThatchDB(process.env.THATCH_DB_PATH!).listChatSessions().find((r) => r.session_id === "ses_resume");
      expect(row).toBeDefined();
      // Same row, SAME NAME (owned by the session id), heartbeat fresh again.
      expect(row!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
      expect(Date.now() - Date.parse(row!.last_seen)).toBeLessThan(60_000);
      expect(row!.topic).toBe("Continued session");
      // The asleep-mail woke it at init.
      const wake = promptAsyncs.find((p) => p.path.id === "ses_resume");
      expect(wake).toBeDefined();
      expect(JSON.stringify(wake.body)).toContain("1 unread message from resender-00001");
      const stamp = new Database(process.env.THATCH_DB_PATH!)
        .query("SELECT delivered_at FROM chat_messages WHERE to_session = 'ses_resume'")
        .get() as any;
      expect(stamp?.delivered_at).not.toBeNull();
      // The reclaim announcement waits for the first prompt - the TUI is
      // not connected at init, so an immediate toast would drop silently.
      expect(toastCalls.some((t) => t.body.message.includes("rejoined chat as"))).toBe(false);
      await resumeHooks["chat.message"]!({ sessionID: "ses_resume", messageID: "msg_resume" } as any, promptOutput("msg_resume"));
      const rejoin = toastCalls.find((t) => t.body.message.includes("rejoined chat as"));
      expect(rejoin).toBeDefined();
      expect(rejoin!.body.message).toContain(row!.name);
    } finally {
      process.argv = argvSave;
      resumeHooks?.dispose?.();
    }
  });

  test("-s startup registration honors chat.autoRegister: false", async () => {
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    saveConfig({ chat: { autoRegister: false } });
    const argvSave = process.argv;
    process.argv = [...argvSave, "-s", "ses_noauto"];
    let hooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      hooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-noauto" } as any);
      await settle();
      const db = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(db.listChatSessions().find((r) => r.session_id === "ses_noauto")).toBeUndefined();
      db.close();
    } finally {
      process.argv = argvSave;
      hooks?.dispose?.();
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
    let hooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      hooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-left" } as any);
      await settle();
      const db = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(db.listChatSessions().find((r) => r.session_id === "ses_left")).toBeUndefined();
      expect(db.hasChatLeaveTombstone("ses_left")).toBe(true);
      db.close();
    } finally {
      process.argv = argvSave;
      hooks?.dispose?.();
    }
  });

  test("-c resume reclaims the most recent top-level session at startup", async () => {
    // `opencode -c` continues the most recent top-level session in this
    // directory. The plugin resolves the same target through the SDK at
    // init, so the row's heartbeat is fresh and the poller hosts it before
    // the user's first prompt - the roster shows it Active immediately.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_cont", "thatch-continue", "Continued last", "opencode");
    seedDb.close();
    new Database(process.env.THATCH_DB_PATH!).run(
      "UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_cont'",
    );

    const contClient = {
      ...autoRegisterClient(),
      session: {
        ...autoRegisterClient().session,
        // Directory-scoped list; the child is newer but must never be
        // picked (children are not top-level sessions).
        list: async () => ({
          data: [
            { id: "ses_cont_child", parentID: "ses_cont", time: { updated: 300 } },
            { id: "ses_cont", time: { updated: 200 } },
          ],
        }),
        get: async () => ({ data: { title: "Continued last" } }),
      },
    };
    const argvSave = process.argv;
    process.argv = [...argvSave, "-c"];
    let contHooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      contHooks = await server({ client: contClient, worktree: "/tmp/thatch-cont" } as any);
      await settle();
      const row = new ThatchDB(process.env.THATCH_DB_PATH!)
        .listChatSessions()
        .find((r) => r.session_id === "ses_cont");
      expect(row).toBeDefined();
      // Same row, same never-reused name shape, heartbeat fresh again,
      // topic converged from the title fetch.
      expect(row!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
      expect(Date.now() - Date.parse(row!.last_seen)).toBeLessThan(60_000);
      expect(row!.topic).toBe("Continued last");
      // The child session must not have been registered instead.
      const childRow = new ThatchDB(process.env.THATCH_DB_PATH!)
        .listChatSessions()
        .find((r) => r.session_id === "ses_cont_child");
      expect(childRow).toBeUndefined();
    } finally {
      process.argv = argvSave;
      contHooks?.dispose?.();
    }
  });

  test("-c startup registration honors a leave tombstone and chat.autoRegister: false", async () => {
    // Tombstone case: seed a left session; -c resolves it but must not
    // re-register it. The client's list mock resolves it as the continue
    // target, so the tombstone (not a missing list) is what blocks.
    const seedDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    seedDb.registerChatSession("ses_cont_left", "thatch-continue", null, "opencode", "leaver");
    seedDb.unregisterChatSession("ses_cont_left");
    seedDb.close();

    const contLeftClient = {
      ...autoRegisterClient(),
      session: {
        ...autoRegisterClient().session,
        list: async () => ({ data: [{ id: "ses_cont_left", time: { updated: 1 } }] }),
      },
    };
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    const argvSave = process.argv;
    let hooks: Awaited<ReturnType<typeof server>> | undefined;
    try {
      process.argv = [...argvSave, "-c"];
      hooks = await server({ client: contLeftClient, worktree: "/tmp/thatch-cont-left" } as any);
      await settle();
      const db = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(db.listChatSessions().find((r) => r.session_id === "ses_cont_left")).toBeUndefined();
      expect(db.hasChatLeaveTombstone("ses_cont_left")).toBe(true);
      db.close();
      hooks.dispose?.();
      hooks = undefined;

      // autoRegister: false case: a -c restart must not register either.
      saveConfig({ chat: { autoRegister: false } });
      hooks = await server({ client: contLeftClient, worktree: "/tmp/thatch-cont-noauto" } as any);
      await settle();
      const db2 = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(db2.listChatSessions().find((r) => r.session_id === "ses_cont_left")).toBeUndefined();
      db2.close();
    } finally {
      process.argv = argvSave;
      hooks?.dispose?.();
      rmSync(configPath);
    }
  });

  // Reuses the client factory and toast sink (above): the prompt path
  // registers with the same pool-name model and the same quiet toast.
  const promptOutput = (id: string, text = "hello, what is your chat name?"): any => ({
    message: { id },
    parts: [{ type: "text", text }],
  });

  test("chat.message registers an unregistered top-level session before the model runs", async () => {
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr" } as any);
    try {
      const regToastsBefore = toastCalls.filter((t) => t.body.message.includes("registered in chat as")).length;
      await prHooks["chat.message"]!({ sessionID: "ses_pr1", messageID: "msg_pr1" } as any, promptOutput("msg_pr1"));
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      const row = prDb.listChatSessions().find((r) => r.session_id === "ses_pr1");
      expect(row).toBeDefined();
      expect(row!.name).toMatch(/^[\p{L}\p{N}-]+-\d{5}$/u);
      // Placeholder title at prompt time - the topic converges on idle.
      expect(row!.topic).toBeNull();

      // Second prompt: touch, not a second registration - one toast total.
      await prHooks["chat.message"]!({ sessionID: "ses_pr1", messageID: "msg_pr2" } as any, promptOutput("msg_pr2", "second prompt"));
      const regToasts = toastCalls.filter((t) => t.body.message.includes("registered in chat as"));
      expect(regToasts.length).toBe(regToastsBefore + 1);
      prDb.close();
    } finally {
      prHooks.dispose?.();
    }
  });

  test("chat.message does not register a sub-agent child session", async () => {
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr-child" } as any);
    try {
      await prHooks.event!({ event: {
        type: "session.created",
        properties: { info: { id: "ses_pr_child", parentID: "ses_pr_parent" } } } as any,
      });
      await prHooks["chat.message"]!({ sessionID: "ses_pr_child", messageID: "msg_child" } as any, promptOutput("msg_child", "child prompt"));
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_pr_child")).toBeUndefined();
      prDb.close();
    } finally {
      prHooks.dispose?.();
    }
  });

  test("first idle does not register a sub-agent child session", async () => {
    // The idle auto-register path (the backstop for sessions whose TUI was
    // not connected at init) had no child check: every fact-extractor run
    // registered a roster row on its terminal idle - the "thatch-extraction"
    // corpse flood (September 2026). Children are machinery, not chat
    // participants, on BOTH registration paths.
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr-child-idle" } as any);
    try {
      await prHooks.event!({ event: {
        type: "session.created",
        properties: { info: { id: "ses_idle_child", parentID: "ses_idle_parent" } } } as any,
      });
      // The child's run ends: its terminal idle must not register it.
      await prHooks.event!({ event: {
        type: "session.status",
        properties: { sessionID: "ses_idle_child", status: { type: "idle" } } } as any,
      });
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_idle_child")).toBeUndefined();
      prDb.close();
    } finally {
      prHooks.dispose?.();
    }
  });

  test("machinery marker blocks auto-registration on both paths and self-heals a corpse row", async () => {
    // The childToParent map is in-memory and lost to a plugin reload or
    // daemon restart; the observed thatch-extraction corpse rows (81 by
    // 2026-10-07) came from an instance whose mapping was gone when the
    // extraction child's events landed. The durable chat_machinery marker
    // (written by triggerExtraction at child creation) closes that window:
    // it must block the prompt path, and the idle path must also delete a
    // corpse row an earlier race already registered.
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-machinery" } as any);
    try {
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      prDb.markChatMachinery("ses_mach", "extraction");

      // Prompt path: the marker alone refuses registration (no row, no
      // tombstone - this session never left, it was never a participant).
      await prHooks["chat.message"]!({ sessionID: "ses_mach", messageID: "msg_mach" } as any, promptOutput("msg_mach"));
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_mach")).toBeUndefined();

      // Idle path, corpse variant: a row exists from the mapping-less race.
      // The marker short-circuits registration AND deletes the corpse.
      prDb.registerChatSession("ses_mach", "thatch-machinery", EXTRACTION_CHILD_TITLE, "opencode");
      await prHooks.event!({ event: {
        type: "session.status",
        properties: { sessionID: "ses_mach", status: { type: "idle" } } } as any,
      });
      await settle();
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_mach")).toBeUndefined();
      prDb.close();
    } finally {
      prHooks.dispose?.();
    }
  });

  test("idle auto-register skips a session titled as the extraction child even without a marker", async () => {
    // Belt-and-suspenders for a machinery session whose marker aged out or
    // was never written: the fetched title alone refuses registration.
    const savedTitle = arTitle;
    arTitle = EXTRACTION_CHILD_TITLE;
    const arHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-ar-title" } as any);
    try {
      await arHooks.event!({ event: {
        type: "session.status",
        properties: { sessionID: "ses_title_mach", status: { type: "idle" } } } as any,
      });
      await settle();
      const arDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(arDb.listChatSessions().find((r) => r.session_id === "ses_title_mach")).toBeUndefined();
      arDb.close();
    } finally {
      arTitle = savedTitle;
      arHooks.dispose?.();
    }
  });

  test("chat.message honors a leave tombstone", async () => {
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr-left" } as any);
    try {
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      prDb.registerChatSession("ses_pr_left", "thatch-pr", null, "opencode", "leaver");
      prDb.unregisterChatSession("ses_pr_left");
      await prHooks["chat.message"]!({ sessionID: "ses_pr_left", messageID: "msg_left" } as any, promptOutput("msg_left"));
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_pr_left")).toBeUndefined();
      expect(prDb.hasChatLeaveTombstone("ses_pr_left")).toBe(true);
      prDb.close();
    } finally {
      prHooks.dispose?.();
    }
  });

  test("chat.message registration honors chat.autoRegister: false", async () => {
    const configPath = join(dirname(process.env.THATCH_DB_PATH!), "config.json");
    saveConfig({ chat: { autoRegister: false } });
    const prHooks = await server({ client: autoRegisterClient(), worktree: "/tmp/thatch-pr-noauto" } as any);
    try {
      await prHooks["chat.message"]!({ sessionID: "ses_pr_noauto", messageID: "msg_noauto" } as any, promptOutput("msg_noauto"));
      const prDb = new ThatchDB(process.env.THATCH_DB_PATH!);
      expect(prDb.listChatSessions().find((r) => r.session_id === "ses_pr_noauto")).toBeUndefined();
      prDb.close();
    } finally {
      prHooks.dispose?.();
      rmSync(configPath);
    }
  });
});

describe("session.deleted tombstones auto-registration", () => {
  test("a deleted session's late auto-register IIFE cannot resurrect the row", async () => {
    // Register via a first idle, then delete the session in the TUI: the
    // session.deleted handler must tombstone, so a late/second idle event
    // cannot silently re-register a dead session.
    const dlClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "child_dl" } }),
        delete: async () => {},
        get: async () => ({ data: { title: "Doomed Session" } }),
        status: async () => ({ data: {} }),
      },
      tui: { showToast: async () => {} },
    };
    const dlHooks = await server({ client: dlClient, worktree: "/tmp/thatch-dl" } as any);

    await dlHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_dl1", status: { type: "idle" } } } as any,
    });
    await new Promise((r) => setTimeout(r, 20));
    const dlDb = new ThatchDB(process.env.THATCH_DB_PATH!);
    expect(dlDb.listChatSessions().find((r) => r.session_id === "ses_dl1")).toBeDefined();

    // User deletes the session in the TUI.
    await dlHooks.event!({ event: {
      type: "session.deleted",
      properties: { info: { id: "ses_dl1" } } } as any,
    });
    expect(dlDb.listChatSessions().find((r) => r.session_id === "ses_dl1")).toBeUndefined();
    expect(dlDb.hasChatLeaveTombstone("ses_dl1")).toBe(true);

    // A straggler idle event (the in-flight IIFE's race window, or a late
    // duplicate) must not resurrect the row.
    await dlHooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_dl1", status: { type: "idle" } } } as any,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(dlDb.listChatSessions().find((r) => r.session_id === "ses_dl1")).toBeUndefined();
    dlDb.close();
    dlHooks.dispose?.();
  });
});
