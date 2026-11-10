import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { setup } from "../src/opencode/v2";
import { EXIT_TAB_CLOSED_EVENT, TAB_CLOSED_EVENT, TOAST_EVENT, exitTabClosedEventType } from "../src/session-tab-shared";
import { captureConsoleError } from "./mocks/console-error";
import { runtimeStateRow } from "./mocks/runtime-state";
import { TOOL_DEFS } from "../src/tool-defs";
import {
  addedCommands,
  addedTools,
  dbDir,
  makeContext,
  PROJECT_DIR,
  queueEvent,
  rpcEmitted,
  SESSION_DIR,
  sessionCompactCalls,
  sessionCreateCalls,
  sessionPromptCalls,
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

// The v2 adapter's registration, wrap-up commands (/thatch/compact,
// /thatch/exit), and the SDK capability floors: greenlight-gated host
// actions on a current host, the blocked path, and the logged no-op
// degrade when the host lacks the rpc surface.

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  setupTestEnv();
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  await teardownTestEnv();
});

describe("opencode v2 adapter", () => {
  test("noReply deliveries route to the resume:false synthetic (the live-probed no-wake path)", async () => {
    // Pins the noReply fix (Phase A of the drop-v1 plan): the re-attach
    // notice is the runtime's noReply delivery on setup, so it must ride
    // session.synthetic({ resume: false }) - enqueue WITHOUT waking
    // execution (live-probed 2026-11-05: no execution events, prompt hook
    // never fires for the item, history materializes at the next turn's
    // inbox delivery). A noReply body reaching session.prompt would start
    // a real model turn in every restored session on every reload.
    const { ThatchDB } = await import("../src/db");
    const db = new ThatchDB(join(dbDir, "test.db"));
    db.runtimeStatePut(
      "watchers",
      "ses_reattach_target",
      [{
        id: "watch_reattach", source: "pr", sessionID: "ses_reattach_target", repo: "acme/widgets", pr: 11,
        events: ["pr_commit"], once: false, expiresAt: Date.now() + 600_000,
        createdAt: Date.now(), state: { headSha: "aaaa1111" },
      }],
      SESSION_DIR,
    );
    db.close();

    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await waitFor("the re-attach notice to the restored session", () =>
      sessionSyntheticCalls.some((c: any) => c?.sessionID === "ses_reattach_target" && String(c?.text).includes("plugin reloaded")),
    );
    const notice = sessionSyntheticCalls.find((c: any) => c?.sessionID === "ses_reattach_target" && String(c?.text).includes("plugin reloaded"));
    // The no-wake contract itself: resume is exactly false.
    expect(notice?.resume).toBe(false);
    // And nothing went through the real-prompt path - a prompt delivery
    // would be a model turn (the feedback loop noReply exists to prevent).
    expect(sessionPromptCalls.filter((c: any) => String(c?.text).includes("plugin reloaded"))).toEqual([]);
  });

  test("session-start reminder delivers via the resume:false synthetic", async () => {
    // The second noReply feature site: the reminder rides the same
    // no-wake synthetic path as the re-attach notice.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await queueEvent({
      type: "session.created",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_new_session", info: { id: "ses_new_session", parentID: null } },
    });
    await waitFor("the session-start reminder", () =>
      sessionSyntheticCalls.some((c: any) => c?.sessionID === "ses_new_session" && String(c?.text).includes("thatch")),
    );
    const reminder = sessionSyntheticCalls.find((c: any) => c?.sessionID === "ses_new_session");
    expect(reminder?.resume).toBe(false);
    expect(sessionPromptCalls.filter((c: any) => c?.sessionID === "ses_new_session")).toEqual([]);
  });

  test("setup registers every TOOL_DEF through the ToolEditor with thatch_ names", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const names = addedTools.map((t) => t.name);
    // bundledOnly tools are the plugin regime's bundled-server components -
    // the v2 registration skips them (the fence contract).
    const registerable = TOOL_DEFS.filter((d) => !d.bundledOnly);
    expect(addedTools.length).toBe(registerable.length);
    for (const def of registerable) expect(names).toContain(`thatch_${def.name}`);
    for (const def of TOOL_DEFS.filter((d) => d.bundledOnly)) expect(names).not.toContain(`thatch_${def.name}`);
    for (const tool of addedTools) expect(tool.description).toBeTruthy();
  });

  test("accept-then-teach keys drop out of the REGISTERED v2 input schema", async () => {
    // Pins the v2 compile site (src/opencode/v2.ts, registerTools): the
    // input must be our own z.toJSONSchema conversion. If registration
    // ever switched to letting v2's converter derive the schema, optionality
    // could be lost and these keys would re-require on v2 - the host would
    // again reject wrong-shape calls before the execute teaching runs.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    for (const [tool, key] of [
      ["thatch_memory_remember", "content"],
      ["thatch_memory_show", "label"],
      ["thatch_memory_forget", "label"],
    ] as const) {
      const registered = addedTools.find((t) => t.name === tool)!;
      const schema = registered.input as { required?: string[] };
      expect(schema.required ?? [], tool).not.toContain(key);
    }
  });

  test("the registered v2 input schema permits unknown keys (typo'd keys reach the guards)", async () => {
    // Pins the v2 declared surface (src/opencode/v2.ts, registerTools):
    // the GUARD-BEARING tools' schemas are built with deepPassthrough so
    // they convert to additionalProperties: {} instead of false.
    // opencode-core validates tool calls against this declared schema; a
    // strict false would strip or reject a typo'd key ("labels") before
    // the accept-then-teach guards could name it. JSON Schema semantics
    // for additionalProperties: {} allow any additional property, which is
    // the strongest pin this repo can make without running opencode-core
    // itself.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const registered = addedTools.find((t) => t.name === "thatch_memory_show")!;
    const schema = registered.input as { additionalProperties?: unknown };
    expect(schema.additionalProperties).not.toBe(false);
    expect(schema.additionalProperties).toEqual({});
  });

  test("v2 declared schemas: non-guard tools stay strict; config_set sections permit unknown fields", async () => {
    // Two halves of the same rule: only the four guard-bearing tools
    // (memory_remember/show/forget, config_set) declare passthrough
    // schemas - a permissive additionalProperties renders as a
    // "[key: string]: unknown" index signature in the Code Mode catalog,
    // so every other tool keeps the strict honest signature. And
    // config_set's loosening is DEEP (nested section objects too):
    // opencode-core's tool-input repair strips unknown fields of closed
    // objects, so a strict nested section would eat a typo'd field and
    // execute could never teach the correction.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const strict = addedTools.find((t) => t.name === "thatch_notify_user")!;
    expect((strict.input as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    const configSet = addedTools.find((t) => t.name === "thatch_config_set")!;
    const schema = configSet.input as {
      additionalProperties?: unknown;
      properties?: Record<string, { additionalProperties?: unknown }>;
    };
    expect(schema.additionalProperties).toEqual({});
    expect(schema.properties?.chat?.additionalProperties).toEqual({});
  });

  test("wrap-up commands deliver a real (non-synthetic) prompt", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // The wrap-up body is the user-visible prompt (like v1's command file
    // expansion), so it must go through session.prompt, NOT the synthetic
    // endpoint - the all-synthetic routing is exercised by the wake paths
    // (see the chat wake use case), not here.
    const compact = addedCommands.find((c) => c.name === "thatch/compact");
    const exit = addedCommands.find((c) => c.name === "thatch/exit");
    expect(compact).toBeDefined();
    expect(exit).toBeDefined();
    await compact!.execute({ sessionID: "ses_v2_cmd" });
    await exit!.execute({ sessionID: "ses_v2_cmd" });
    // Both wrapped up through promptSession ("sync" mode, non-synthetic
    // body): the command body is the user-visible prompt, like v1's
    // command file expansion.
    expect(sessionSyntheticCalls.length).toBe(0);
    expect(sessionPromptCalls.length).toBe(2);
    expect(sessionPromptCalls[0].text).toContain("Pre-compact wrap-up");
    expect(sessionPromptCalls[0].text).toContain("thatch_compact");
    expect(sessionPromptCalls[1].text).toContain("Pre-exit wrap-up");
  });

  test("cleanup is idempotent and disposes the runtime once", async () => {
    const context = makeContext();
    const dispose = (await setup(context as any)) as () => Promise<void>;
    await dispose();
    // A second call must not re-run disposal (double db.close would throw).
    await expect(dispose()).resolves.toBeUndefined();
  });

  test("wrap-up commands substitute the user's typed arguments for $ARGUMENTS", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    // v2's session.prompt does no template expansion (v1 expanded
    // $ARGUMENTS from the command file), so the adapter must substitute the
    // invocation's prompt text itself - bare runs get the n/a marker.
    const exit = addedCommands.find((c) => c.name === "thatch/exit");
    await exit!.execute({ sessionID: "ses_v2_args", prompt: { text: "Good work - see you tomorrow" } });
    const delivered = sessionPromptCalls[0].text as string;
    expect(delivered).toContain("Good work - see you tomorrow");
    expect(delivered).not.toContain("$ARGUMENTS");

    // $ sequences in the user's text must survive: a string replacement
    // would interpret them ($$ -> $, $& -> the match).
    sessionPromptCalls.length = 0;
    await exit!.execute({ sessionID: "ses_v2_args", prompt: { text: "costs $$5 and $ARGUMENTS-ish things" } });
    const delivered2 = sessionPromptCalls[0].text as string;
    expect(delivered2).toContain("costs $$5 and $ARGUMENTS-ish things");
    // The template's own placeholder (followed by the section note) is gone.
    expect(delivered2).not.toContain("$ARGUMENTS\n\n");

    // A bare invocation (no prompt) still delivers a usable body.
    sessionPromptCalls.length = 0;
    await exit!.execute({ sessionID: "ses_v2_args" });
    expect(sessionPromptCalls[0].text).not.toContain("$ARGUMENTS");
  });

  // Wrap-up completion actions: the armed journal row is the resolution
  // observable (the greenlit branch deletes it, so its absence proves the
  // branch ran to completion - not that it never ran). The greenlight is
  // the kind's zero-arg tool call, resolved against the armed wrap-up.
  const wrapupArmed = (sessionID: string): boolean => runtimeStateRow(process.env.THATCH_DB_PATH!, "wrapup", sessionID) !== null;

  test("a greenlit /thatch/compact triggers session.compact on the next idle", async () => {
    // The greenlight is the zero-arg thatch_compact tool call; the compact
    // fires on the session's next idle.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const compact = addedCommands.find((c) => c.name === "thatch/compact")!;
    await compact.execute({ sessionID: "ses_v2_wrap_ok" });
    expect(wrapupArmed("ses_v2_wrap_ok")).toBe(true);
    const compactTool = addedTools.find((t) => t.name === "thatch_compact")!;
    await compactTool.execute({}, { sessionID: "ses_v2_wrap_ok", agent: "build" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_wrap_ok" },
    });
    await waitFor("session.compact called", () => sessionCompactCalls.length === 1);
    expect(sessionCompactCalls[0]).toEqual({ sessionID: "ses_v2_wrap_ok" });
    expect(wrapupArmed("ses_v2_wrap_ok")).toBe(false);
    // The greenlit branch returns early: no extraction child spawn.
    expect(sessionCreateCalls.length).toBe(0);
  });

  test("a greenlit /thatch/exit emits the TUI-only close event for the session's own tab", async () => {
    // The greenlight is the zero-arg thatch_exit tool call; the close fires
    // on the session's next idle.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const exit = addedCommands.find((c) => c.name === "thatch/exit")!;
    await exit.execute({ sessionID: "ses_v2_exit_ok" });
    const exitTool = addedTools.find((t) => t.name === "thatch_exit")!;
    await exitTool.execute({}, { sessionID: "ses_v2_exit_ok", agent: "build" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_exit_ok" },
    });
    await waitFor("exit close emitted", () => rpcEmitted.some((e) => e.name === EXIT_TAB_CLOSED_EVENT));
    const closed = rpcEmitted.find((e) => e.name === EXIT_TAB_CLOSED_EVENT)!;
    // TUI-only payload (just the tab to close): the runtime records the
    // session's watcher deaths synchronously before the action, and the
    // pump never translates this event - a session_tab_close-style payload
    // would invite that translation.
    expect(closed.data).toEqual({ sessionID: "ses_v2_exit_ok" });
    expect(wrapupArmed("ses_v2_exit_ok")).toBe(false);
    expect(sessionCreateCalls.length).toBe(0);
  });

  test("an un-greenlit exit arm survives an idle with no host action on v2", async () => {
    // The fix this branch ships: a mid-exit idle (e.g. a background
    // extractor running) must not consume the arm and strand the close.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const exit = addedCommands.find((c) => c.name === "thatch/exit")!;
    await exit.execute({ sessionID: "ses_v2_exit_mid" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_exit_mid" },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(wrapupArmed("ses_v2_exit_mid")).toBe(true);
    expect(rpcEmitted.some((e) => e.name === EXIT_TAB_CLOSED_EVENT)).toBe(false);
    // The arm still resolves: greenlight now, close on the next idle.
    const exitTool = addedTools.find((t) => t.name === "thatch_exit")!;
    await exitTool.execute({}, { sessionID: "ses_v2_exit_mid", agent: "build" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_exit_mid" },
    });
    await waitFor("late exit close emitted", () => rpcEmitted.some((e) => e.name === EXIT_TAB_CLOSED_EVENT));
    expect(wrapupArmed("ses_v2_exit_mid")).toBe(false);
  });

  test("a greenlit /thatch/exit places the session's watcher deaths before unregistering it", async () => {
    // The death row's placement is the load-bearing ordering: onSessionDeath
    // places the row by the session's chat row, and the exit unregisters that
    // row - so the deaths must run FIRST or the row lands unplaceable (a
    // project-null row no coordinator pickup can rescue). The death row is
    // written by the ASYNC enrichment continuation (the coordinator link is
    // read from the session's spawn metadata), so the assertions wait for it.
    cleanup = (await setup(makeContext({
      // The exiting session's spawn stamp: a coordinator link, so the
      // placed row is a care-routed pickup row rather than banner-only.
      get: async (input: any) =>
        input?.sessionID === "ses_v2_exit_watch"
          ? { title: "t", metadata: { thatch: { coordinatorSessionID: "ses_exit_coord" } } }
          : { title: "some title" },
    }) as any)) as () => Promise<void>;
    // The coordinator is mid-turn: the push gate stays closed and the
    // placed row survives for the coordinator-scoped pickup.
    await queueEvent({
      type: "session.execution.started",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_exit_coord" },
    });
    // The watcher's validation run executes the command in the project
    // directory, so it must exist on disk.
    mkdirSync(PROJECT_DIR, { recursive: true });
    const sessionID = "ses_v2_exit_watch";
    const chatRegister = addedTools.find((t) => t.name === "thatch_chat_register")!;
    await chatRegister.execute({}, { sessionID, agent: "general" });
    const watchCreate = addedTools.find((t) => t.name === "thatch_watch_command_create")!;
    // A condition that stays unmet: registers (validation exit != 0) and
    // never fires during the test.
    const registered = await watchCreate.execute(
      { command: "test -f /nonexistent-thatch-exit-watch-marker" },
      { sessionID, agent: "general" },
    );
    expect(String((registered as any).content)).not.toContain("refused");

    const exit = addedCommands.find((c) => c.name === "thatch/exit")!;
    await exit.execute({ sessionID });
    const exitTool = addedTools.find((t) => t.name === "thatch_exit")!;
    await exitTool.execute({}, { sessionID, agent: "build" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID },
    });
    await waitFor("exit close emitted", () => rpcEmitted.some((e) => e.name === EXIT_TAB_CLOSED_EVENT));

    const stateRow = (kind: string): any => runtimeStateRow(process.env.THATCH_DB_PATH!, kind, sessionID);
    // The death row is placed asynchronously (project resolved from the
    // still-registered chat row), carries the cancelled watch as a target,
    // and is stamped with the coordinator from the spawn metadata.
    await waitFor("the stamped death row", () => {
      const death = stateRow("watcher_death") as { coordinatorSessionID?: string } | null;
      return death?.coordinatorSessionID === "ses_exit_coord";
    });
    const death = stateRow("watcher_death") as { project?: string; targets?: string[]; coordinatorSessionID?: string };
    expect(death).not.toBeNull();
    expect(death!.project).toBeTruthy();
    expect(death!.targets).toContain("test -f /nonexistent-thatch-exit-watch-marker");
    // The watcher definition row is gone (cancelled, not dormant).
    expect(stateRow("watchers")).toBeNull();
    // The chat roster row is unregistered.
    const db = new Database(process.env.THATCH_DB_PATH!, { readonly: true });
    try {
      expect(db.query("SELECT 1 FROM chat_sessions WHERE session_id = ?").get(sessionID)).toBeNull();
    } finally {
      db.close();
    }

    // The SSE echo of the emit (the bus feeds a plugin's own events back to
    // it) must not translate into a second death pass: the second pass
    // would write an empty-targets row over the placed one and delete it,
    // erasing the pickup row the coordinator is owed.
    await queueEvent({ type: exitTabClosedEventType, data: { sessionID }, location: { directory: SESSION_DIR } });
    await new Promise((r) => setTimeout(r, 150));
    expect(stateRow("watcher_death")).not.toBeNull();

    // A second greenlit exit (the user reopened the tab and ran the command
    // again) must not erase the placed row either: the second sessionDied
    // finds no watchers, and an empty-targets upsert would overwrite the
    // placed row before the watchless cleanup deletes it. The re-arm
    // resets greenlit, so the model calls the tool again.
    await exit.execute({ sessionID });
    await exitTool.execute({}, { sessionID, agent: "build" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID },
    });
    await waitFor("second exit close emitted", () => rpcEmitted.filter((e) => e.name === EXIT_TAB_CLOSED_EVENT).length === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(stateRow("watcher_death")).not.toBeNull();
  });

  test("an un-greenlit compact arm survives an idle with no host action on v2", async () => {
    // The blocked path died with the token: blockers are prose per the
    // template, and an un-greenlit compact idle (e.g. a background
    // extractor running mid-checklist) must not consume the arm or toast.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const compact = addedCommands.find((c) => c.name === "thatch/compact")!;
    await compact.execute({ sessionID: "ses_v2_wrap_mid" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_wrap_mid" },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(wrapupArmed("ses_v2_wrap_mid")).toBe(true);
    expect(sessionCompactCalls.length).toBe(0);
    // No blocked-path warning toast (find it by variant + command name:
    // the fall-through auto-register may emit its own info toast), and no
    // close event of either kind.
    expect(rpcEmitted.some((e) => e.name === TOAST_EVENT && e.data?.variant === "warning" && String(e.data?.message).includes("/thatch/compact"))).toBe(false);
    expect(rpcEmitted.filter((e) => e.name === TAB_CLOSED_EVENT || e.name === EXIT_TAB_CLOSED_EVENT).length).toBe(0);
    // The arm still resolves: greenlight now, compact on the next idle.
    const compactTool = addedTools.find((t) => t.name === "thatch_compact")!;
    await compactTool.execute({}, { sessionID: "ses_v2_wrap_mid", agent: "build" });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_wrap_mid" },
    });
    await waitFor("late session.compact called", () => sessionCompactCalls.length === 1);
    expect(wrapupArmed("ses_v2_wrap_mid")).toBe(false);
  });

  test("a host without the rpc surface exits greenlit with a logged no-op", async () => {
    // Same floor rule as session.compact, for the exit action: without the
    // session-tab bridge there is no closeable tab surface, so the
    // greenlit exit degrades to a log (the checklist and flush still ran).
    const { lines } = await captureConsoleError(async () => {
      const context = makeContext({
        omitRpc: true,
      });
      cleanup = (await setup(context as any)) as () => Promise<void>;
      const exit = addedCommands.find((c) => c.name === "thatch/exit")!;
      await exit.execute({ sessionID: "ses_v2_exit_floor" });
      const exitTool = addedTools.find((t) => t.name === "thatch_exit")!;
      await exitTool.execute({}, { sessionID: "ses_v2_exit_floor", agent: "build" });
      await queueEvent({
        type: "session.execution.succeeded",
        location: { directory: SESSION_DIR },
        data: { sessionID: "ses_v2_exit_floor" },
      });
      await waitFor("wrap-up resolved without rpc", () => !wrapupArmed("ses_v2_exit_floor"));
      await new Promise((r) => setTimeout(r, 150));
      expect(rpcEmitted.length).toBe(0);
      return;
    });
    // "tab close skipped" pins the ACTION's degrade log, distinct from
    // the setup-time "rpc surface unavailable" line.
    expect(lines.some((line) => line.includes("tab close skipped"))).toBe(true);
  });
});
