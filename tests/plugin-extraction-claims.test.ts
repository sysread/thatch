// Part of the former plugin.test.ts "plugin entry" describe, split by
// topic, re-based onto the v2 harness (the drop-v1 plan's Phase A-prime):
// watcher journal reconcile and extraction claim-scoping races. The wiring
// tests live in plugin-entry.test.ts, the buffering + payload handshake in
// plugin-extraction.test.ts, and the direct-extraction child lifecycle in
// plugin-extraction-direct.test.ts.

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { setup } from "../src/opencode/v2";
import { ThatchDB } from "../src/db";
import {
  addedTools,
  makeContext,
  PROJECT_DIR,
  queueEvent,
  SESSION_DIR,
  setupTestEnv,
  teardownTestEnv,
  toolAfterHook,
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

// The v2 Tool.Result carries the tool's text in `content`.
const textOf = (r: unknown): string => String((r as any)?.content ?? "");

// The v2 bus envelope for a session event: payload in `data`, and a
// location so the pump's directory filter routes it to this instance.
const sessionEvent = (type: string, data: Record<string, unknown>) => ({
  type,
  location: { directory: SESSION_DIR },
  data: { ...data },
});

describe("plugin entry", () => {
  // -----------------------------------------------------------------------
  // Journal reconcile - the watch tools self-heal after a registry rebuild
  // -----------------------------------------------------------------------

  test("watch_list and watch_cancel self-heal from the journal after a registry rebuild", async () => {
    // Simulate a watcher journaled by a previous runtime instance that a
    // session_move or plugin reload orphaned: the journal row exists (same
    // pid), but the live registry the tools query is empty. Before the
    // reconcile, watch_list said "No active watchers" and watch_cancel "No
    // watcher in this session" while the orphaned poller kept delivering.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const watcher = {
      id: "watch_selfheal",
      source: "branch" as const,
      sessionID: "ses_selfheal",
      repo: "acme/widgets",
      branch: "main",
      events: ["branch_commit"],
      workflows: [],
      once: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60_000,
      state: { headSha: "aaaa1111aaaa1111", checkRuns: {}, workflowRuns: {} },
    };
    const jdb = new ThatchDB(process.env.THATCH_DB_PATH!);
    jdb.runtimeStatePut("watchers", "ses_selfheal", [watcher], PROJECT_DIR);

    const watchList = addedTools.find((t) => t.name === "thatch_watch_list")!;
    const watchCancel = addedTools.find((t) => t.name === "thatch_watch_cancel")!;

    // watch_list self-heals: the journaled watcher is hydrated and listed.
    const listed = await watchList.execute({}, { sessionID: "ses_selfheal", agent: "general" });
    expect(textOf(listed)).toContain("watch_selfheal");
    expect(textOf(listed)).toContain("acme/widgets@main");

    // watch_cancel self-heals too: the rehydrated watcher is cancelable.
    const cancelled = await watchCancel.execute(
      { id: "watch_selfheal" }, { sessionID: "ses_selfheal", agent: "general" },
    );
    expect(textOf(cancelled)).toContain("[cancelled] watch_selfheal");

    // Cancel re-journals the empty list - the row is gone, the entry does
    // not resurrect on the next call.
    const listed2 = await watchList.execute({}, { sessionID: "ses_selfheal", agent: "general" });
    expect(textOf(listed2)).toBe("No active watchers.");
  });

  test("reconcile leaves cross-process (dormant) journal rows to the runtime scan", async () => {
    // A row journaled by a DEAD process (a real restart's leftover) must
    // NOT be hydrated by the tool path: its baseline needs the revalidation
    // that only scanDormantWatchers performs.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const watcher = {
      id: "watch_dormant",
      source: "branch" as const,
      sessionID: "ses_dormant",
      repo: "acme/widgets",
      branch: "main",
      events: ["branch_commit"],
      workflows: [],
      once: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60_000,
      state: { headSha: "bbbb2222bbbb2222", checkRuns: {}, workflowRuns: {} },
    };
    const foreignPid = process.pid + 12345;
    const jdb = new ThatchDB(process.env.THATCH_DB_PATH!);
    // A directory that does NOT match the runtime's own: a dead-pid row
    // whose directory matches would banner the user about a watcher death
    // in the next chat.message in this file (test isolation). Delete the
    // row at the end regardless.
    jdb.runtimeStatePut("watchers", "ses_dormant", [watcher], "/tmp/not-the-runtime-dir", foreignPid);

    const watchList = addedTools.find((t) => t.name === "thatch_watch_list")!;
    const listed = await watchList.execute({}, { sessionID: "ses_dormant", agent: "general" });
    expect(textOf(listed)).toBe("No active watchers.");
    jdb.runtimeStateDelete("watchers", "ses_dormant");
  });

  test("reconcile does not clobber a live watcher with stale journal rows", async () => {
    // A command watcher: its baseline (`false`, exit 1) is not yet met, so
    // the create registers it. (Command watchers need no gh; branch
    // watchers would fetch a baseline over the network.) The command runs
    // with cwd = the harness's project directory, which the test env
    // creates.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const watchCreate = addedTools.find((t) => t.name === "thatch_watch_command_create")!;
    const created = await watchCreate.execute(
      { command: "false" }, { sessionID: "ses_live", agent: "general" },
    );
    expect(textOf(created)).toContain("[watching]");
    const stale = {
      id: "watch_stale",
      source: "branch" as const,
      sessionID: "ses_live",
      repo: "acme/other",
      branch: "main",
      events: ["branch_commit"],
      workflows: [],
      once: false,
      createdAt: Date.now() - 1000,
      expiresAt: Date.now() + 60 * 60_000,
      state: { headSha: "cccc3333cccc3333", checkRuns: {}, workflowRuns: {} },
    };
    const jdb = new ThatchDB(process.env.THATCH_DB_PATH!);
    jdb.runtimeStatePut("watchers", "ses_live", [stale], PROJECT_DIR);

    const watchList = addedTools.find((t) => t.name === "thatch_watch_list")!;
    const listed = await watchList.execute({}, { sessionID: "ses_live", agent: "general" });
    // The LIVE watcher survives the reconcile (hydrate never clobbers), and
    // the journaled stale definition legitimately rehydrates alongside it -
    // the journal is reconciled INTO the registry, never over it.
    expect(textOf(listed)).toContain("cmd:");
    expect(textOf(listed)).toContain("watch_stale");
    // Tidy up: the seeded row must not leak into later tests (this file
    // shares one db across tests).
    jdb.runtimeStateDelete("watchers", "ses_live");
  });

  test("sibling sub-agent going idle does not drop the extractor's claimed payload", async () => {
    // THE RACE, pinned: parent acks (accept) immediately after dispatching
    // the extractor, per the nudge's own instruction. A sibling
    // task-dispatched sub-agent (a code-review specialist) goes idle while
    // the extractor is still working. Before claim scoping, the sibling's
    // idle signal dropped the WHOLE accepted set and the extractor's
    // payload fetch came back empty - silent loss, and the nudge loop
    // Jeff saw for a week.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_race",
      input: { command: "git log" },
      status: "completed",
      result: { content: "abc123 the real interaction" },
    });
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_race",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_specialist",
      info: { id: "ses_specialist", parentID: "ses_race" },
    }));
    await queueEvent(sessionEvent("session.execution.succeeded", {
      sessionID: "ses_specialist",
    }));

    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      { session_id: "ses_race" },
      { sessionID: "ses_extractor", agent: "general" },
    );
    expect(textOf(served)).toContain("abc123");
  });

  test("completion consumes only the completing child's claimed delivery", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_two",
      input: { command: "cmd A" },
      status: "completed",
      result: { content: "interaction A" },
    });
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_two",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_ext1",
      info: { id: "ses_ext1", parentID: "ses_two" },
    }));
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    // Fetch through the TOOL (not the after-hook): the execute path records
    // the fetcher's claim - the delivery record completion consumes.
    await payloadTool.execute(
      { session_id: "ses_two" },
      { sessionID: "ses_ext1", agent: "general" },
    );

    // New exhaust accumulates while extractor 1 works; extractor 2 fetches
    // and its claim covers the delivered set.
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_two",
      input: { command: "cmd B" },
      status: "completed",
      result: { content: "interaction B" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_ext2",
      info: { id: "ses_ext2", parentID: "ses_two" },
    }));
    await payloadTool.execute(
      { session_id: "ses_two" },
      { sessionID: "ses_ext2", agent: "general" },
    );

    // Extractor 1 finishes: only ITS delivery (interaction A) completes.
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_ext1",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });

    // Interaction B survives extractor 1's completion.
    const served = await payloadTool.execute(
      { session_id: "ses_two" },
      { sessionID: "ses_ext3", agent: "general" },
    );
    const text = textOf(served);
    expect(text).toContain("interaction B");
    expect(text).not.toContain("interaction A");
  });

  test("DEFECT 2 shape: a parent ack mis-targeting its child's id is harmless, extraction still completes", async () => {
    // The frozen-count loop: the parent, told to ack, passed the CHILD's id
    // as session_id. Old code took the target branch (completeAccepted on a
    // session with nothing accepted - no-op) and never accepted the
    // parent's own buffer, so pending never drained and the same count
    // re-fired forever. Now the pipeline does not depend on the parent's
    // ack at all: the child's fetch + completion drains the parent.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_mistarget",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_mistarget_child",
      info: { id: "ses_mistarget_child", parentID: "ses_mistarget" },
    }));
    // Parent acks with the CHILD's id (the mis-target). Must not drop or
    // strand anything.
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_mistarget",
      input: { session_id: "ses_mistarget_child" },
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    // The child fetches with no id (auto-resolves to the parent) and
    // completes with no id.
    const served = await payloadTool.execute(
      {},
      { sessionID: "ses_mistarget_child", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_mistarget_child",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    const drained = await payloadTool.execute(
      { session_id: "ses_mistarget" },
      { sessionID: "ses_mistarget_other", agent: "general" },
    );
    expect(textOf(drained)).not.toContain("file.txt");
  });

  test("an extraction child's fetch resolves to its parent's queue automatically", async () => {
    // The model should never need to copy a session ID. The plugin always
    // knows the CALLING session's id (every tool call carries it); the
    // parent link for plugin-created extraction children is in
    // childToParent - so an omitted (or self-named) session_id from a
    // linked child retargets to the parent's buffer. The dispatch prompt
    // carries no id at all (the 2026-11-13 corrupted-id fix); the
    // self-named shape is the belt-and-suspenders for a child that
    // mis-parrots one anyway.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_autoparent",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_autoparent_child",
      info: { id: "ses_autoparent_child", parentID: "ses_autoparent" },
    }));

    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    // Child fetches with NO session_id: resolves to its own session, which
    // the provider retargets to the parent via childToParent.
    const served = await payloadTool.execute(
      {},
      { sessionID: "ses_autoparent_child", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");

    // Same with the child's OWN id passed explicitly (mis-parrot shape).
    const served2 = await payloadTool.execute(
      { session_id: "ses_autoparent_child" },
      { sessionID: "ses_autoparent_child", agent: "general" },
    );
    expect(textOf(served2)).toContain("file.txt");

    // The child's no-arg extraction_done (parentID known via
    // childToParent) completes its claim - the parent's buffer drains.
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_autoparent_child",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    const drained = await payloadTool.execute(
      { session_id: "ses_autoparent" },
      { sessionID: "ses_autoparent_other", agent: "general" },
    );
    expect(textOf(drained)).not.toContain("file.txt");
  });

  test("a corrupted session_id copy falls back to the child's parent resolution", async () => {
    // The 2026-11-13 incident shape, verbatim: the dispatch prompt's
    // parent id (ses_e52dd7be) copied wrong by one character
    // (ses_e52rd7be). The corrupted id has no buffer, so the fetch would
    // no-op as an empty queue - and the model cannot catch its own
    // misread by re-reading the prompt. The tool falls back to the
    // host-owned resolution (the child's childToParent link) before
    // reporting empty, the run completes, and the parent drains.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_e52dd7be",
      input: { command: "ls" },
      status: "completed",
      result: { content: "file.txt" },
    });
    await queueEvent(sessionEvent("session.created", {
      sessionID: "ses_e52dd7be_child",
      info: { id: "ses_e52dd7be_child", parentID: "ses_e52dd7be" },
    }));

    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    // The child passes the CORRUPTED copy of the parent's id.
    const served = await payloadTool.execute(
      { session_id: "ses_e52rd7be" },
      { sessionID: "ses_e52dd7be_child", agent: "general" },
    );
    expect(textOf(served)).toContain("file.txt");

    // The corrupted param recorded a claim on a session that does not
    // exist; the fallback's claim on the real parent must REPLACE it, so
    // the child's ack still completes the delivery it actually received.
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_e52dd7be_child",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    const drained = await payloadTool.execute(
      { session_id: "ses_e52dd7be" },
      { sessionID: "ses_e52dd7be_other", agent: "general" },
    );
    expect(textOf(drained)).not.toContain("file.txt");
  });

  test("wrap-up shape: parent-side fetch plus no-save extraction_done completes its own claim", async () => {
    // The /thatch/compact and /thatch/exit checklists have the PARENT
    // fetch its own payload, process inline, and ack. A no-save run writes
    // no memory, so the ack is the only completion signal for the parent's
    // self-claim. Before this branch completed claims, the entries sat
    // held for 15 minutes and were needlessly re-extracted.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_wrapup",
      input: { command: "cmd W" },
      status: "completed",
      result: { content: "interaction W" },
    });
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    const served = await payloadTool.execute(
      {},
      { sessionID: "ses_wrapup", agent: "general" },
    );
    expect(textOf(served)).toContain("interaction W");
    await toolAfterHook!({
      tool: "thatch_extraction_done",
      sessionID: "ses_wrapup",
      input: {},
      status: "completed",
      result: { content: "[acknowledged]" },
    });
    const drained = await payloadTool.execute(
      {},
      { sessionID: "ses_wrapup", agent: "general" },
    );
    expect(textOf(drained)).not.toContain("interaction W");
  });

  test("parent-side direct fetch plus memory write completes its own claim", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "bash",
      sessionID: "ses_direct",
      input: { command: "cmd C" },
      status: "completed",
      result: { content: "interaction C" },
    });
    const payloadTool = addedTools.find((t) => t.name === "thatch_get_extraction_payload")!;
    // The parent fetches its own payload (no sub-agent) and then saves.
    const served = await payloadTool.execute(
      { session_id: "ses_direct" },
      { sessionID: "ses_direct", agent: "general" },
    );
    expect(textOf(served)).toContain("interaction C");
    await toolAfterHook!({
      tool: "thatch_memory_remember",
      sessionID: "ses_direct",
      input: {},
      status: "completed",
      result: { content: "[saved]" },
    });
    const drained = await payloadTool.execute(
      { session_id: "ses_direct" },
      { sessionID: "ses_direct", agent: "general" },
    );
    expect(textOf(drained)).not.toContain("interaction C");
  });
});
