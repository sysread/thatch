// Part of the former plugin.test.ts "plugin entry" describe, split by
// topic: watcher journal reconcile and extraction claim-scoping races.
// The wiring tests live in plugin-entry.test.ts, the buffering + payload
// handshake in plugin-extraction.test.ts, and the direct-extraction child
// lifecycle in plugin-extraction-direct.test.ts.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync } from "node:fs";
import {
  server,
  setupPluginHarness,
  teardownPluginHarness,
} from "./mocks/plugin-harness";
import { ThatchDB } from "../src/db";

let hooks: Awaited<ReturnType<typeof server>>;

beforeAll(async () => {
  hooks = await setupPluginHarness();
});

afterAll(() => {
  teardownPluginHarness();
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
    jdb.runtimeStatePut("watchers", "ses_selfheal", [watcher], "/tmp/thatch-test-worktree");

    // watch_list self-heals: the journaled watcher is hydrated and listed.
    const listed = await (hooks as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_selfheal" });
    expect(listed).toContain("watch_selfheal");
    expect(listed).toContain("acme/widgets@main");

    // watch_cancel self-heals too: the rehydrated watcher is cancelable.
    const cancelled = await (hooks as any).tool.thatch_watch_cancel.execute(
      { id: "watch_selfheal" }, { sessionID: "ses_selfheal" },
    );
    expect(cancelled).toContain("[cancelled] watch_selfheal");

    // Cancel re-journals the empty list - the row is gone, the entry does
    // not resurrect on the next call.
    const listed2 = await (hooks as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_selfheal" });
    expect(listed2).toBe("No active watchers.");
  });

  test("reconcile leaves cross-process (dormant) journal rows to the runtime scan", async () => {
    // A row journaled by a DEAD process (a real restart's leftover) must
    // NOT be hydrated by the tool path: its baseline needs the revalidation
    // that only scanDormantWatchers performs.
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

    const listed = await (hooks as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_dormant" });
    expect(listed).toBe("No active watchers.");
    jdb.runtimeStateDelete("watchers", "ses_dormant");
  });

  test("reconcile does not clobber a live watcher with stale journal rows", async () => {
    // A command watcher: its baseline (`false`, exit 1) is not yet met, so
    // the create registers it. (Command watchers need no gh; branch
    // watchers would fetch a baseline over the network.) The command runs
    // with cwd = the harness's worktree, which nothing else creates.
    mkdirSync("/tmp/thatch-test-worktree", { recursive: true });
    const created = await (hooks as any).tool.thatch_watch_command_create.execute(
      { command: "false" }, { sessionID: "ses_live" },
    );
    expect(created).toContain("[watching]");
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
    jdb.runtimeStatePut("watchers", "ses_live", [stale], "/tmp/thatch-test-worktree");

    const listed = await (hooks as any).tool.thatch_watch_list.execute({}, { sessionID: "ses_live" });
    // The LIVE watcher survives the reconcile (hydrate never clobbers), and
    // the journaled stale definition legitimately rehydrates alongside it -
    // the journal is reconciled INTO the registry, never over it.
    expect(listed).toContain("cmd:");
    expect(listed).toContain("watch_stale");
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
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_race", callID: "rc1", args: { command: "git log" } },
      { title: "log", output: "abc123 the real interaction", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_race", callID: "rc2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_specialist", parentID: "ses_race" } } } as any,
    });
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_specialist", status: { type: "idle" } } } as any,
    });

    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_race" },
      { sessionID: "ses_extractor" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("abc123");
  });

  test("completion consumes only the completing child's claimed delivery", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_two", callID: "t1", args: { command: "cmd A" } },
      { title: "A", output: "interaction A", metadata: {} },
    );
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_two", callID: "t2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_ext1", parentID: "ses_two" } } } as any,
    });
    // Fetch through the TOOL (not the after-hook): the execute path records
    // the fetcher's claim - the delivery record completion consumes.
    await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_two" },
      { sessionID: "ses_ext1" },
    );

    // New exhaust accumulates while extractor 1 works; extractor 2 fetches
    // and its claim covers the delivered set.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_two", callID: "t4", args: { command: "cmd B" } },
      { title: "B", output: "interaction B", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_ext2", parentID: "ses_two" } } } as any,
    });
    await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_two" },
      { sessionID: "ses_ext2" },
    );

    // Extractor 1 finishes: only ITS delivery (interaction A) completes.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_ext1", callID: "t6", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );

    // Interaction B survives extractor 1's completion.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_two" },
      { sessionID: "ses_ext3" },
    );
    const text = typeof served === "string" ? served : JSON.stringify(served);
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
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_mistarget", callID: "mt1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_mistarget_child", parentID: "ses_mistarget" } } } as any,
    });
    // Parent acks with the CHILD's id (the mis-target). Must not drop or
    // strand anything.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_mistarget", callID: "mt2", args: { session_id: "ses_mistarget_child" } },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    // The child fetches with no id (auto-resolves to the parent) and
    // completes with no id.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      {},
      { sessionID: "ses_mistarget_child" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_mistarget_child", callID: "mt3", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_mistarget" },
      { sessionID: "ses_mistarget_other" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("file.txt");
  });

  test("an extraction child's fetch resolves to its parent's queue automatically", async () => {
    // The model should never need to copy a session ID. The plugin always
    // knows the CALLING session's id (every tool call carries it); the
    // parent link for plugin-created extraction children is in
    // childToParent - so an omitted (or self-named) session_id from a
    // linked child retargets to the parent's buffer. This is the safety
    // net for a child that mis-parrots the ID from its dispatch prompt;
    // the prompt still carries the explicit ID.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_autoparent", callID: "ap1", args: { command: "ls" } },
      { title: "list", output: "file.txt", metadata: {} },
    );
    await hooks.event!({ event: {
      type: "session.created",
      properties: { info: { id: "ses_autoparent_child", parentID: "ses_autoparent" } } } as any,
    });

    // Child fetches with NO session_id: resolves to its own session, which
    // the provider retargets to the parent via childToParent.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      {},
      { sessionID: "ses_autoparent_child" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("file.txt");

    // Same with the child's OWN id passed explicitly (mis-parrot shape).
    const served2 = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_autoparent_child" },
      { sessionID: "ses_autoparent_child" },
    );
    expect(typeof served2 === "string" ? served2 : JSON.stringify(served2)).toContain("file.txt");

    // The child's no-arg extraction_done (parentID known via
    // childToParent) completes its claim - the parent's buffer drains.
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_autoparent_child", callID: "ap2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_autoparent" },
      { sessionID: "ses_autoparent_other" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("file.txt");
  });

  test("wrap-up shape: parent-side fetch plus no-save extraction_done completes its own claim", async () => {
    // The /thatch/compact and /thatch/exit checklists have the PARENT
    // fetch its own payload, process inline, and ack. A no-save run writes
    // no memory, so the ack is the only completion signal for the parent's
    // self-claim. Before this branch completed claims, the entries sat
    // held for 15 minutes and were needlessly re-extracted.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_wrapup", callID: "w1", args: { command: "cmd W" } },
      { title: "W", output: "interaction W", metadata: {} },
    );
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      {},
      { sessionID: "ses_wrapup" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("interaction W");
    await hooks["tool.execute.after"]!(
      { tool: "thatch_extraction_done", sessionID: "ses_wrapup", callID: "w2", args: {} },
      { title: "ack", output: "[acknowledged]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      {},
      { sessionID: "ses_wrapup" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("interaction W");
  });

  test("parent-side direct fetch plus memory write completes its own claim", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_direct", callID: "d1", args: { command: "cmd C" } },
      { title: "C", output: "interaction C", metadata: {} },
    );
    // The parent fetches its own payload (no sub-agent) and then saves.
    const served = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_direct" },
      { sessionID: "ses_direct" },
    );
    expect(typeof served === "string" ? served : JSON.stringify(served)).toContain("interaction C");
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_direct", callID: "d2", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );
    const drained = await (hooks as any).tool.thatch_get_extraction_payload.execute(
      { session_id: "ses_direct" },
      { sessionID: "ses_direct" },
    );
    expect(typeof drained === "string" ? drained : JSON.stringify(drained)).not.toContain("interaction C");
  });
});
