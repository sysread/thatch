import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { setup } from "../src/opencode/v2";
import { TOAST_EVENT, tabClosedEventType, tabOpenedEventType } from "../src/session-tab-shared";
import {
  dbDir,
  makeContext,
  PROJECT_DIR,
  queueEvent,
  rpcEmitted,
  SESSION_DIR,
  sessionCreateCalls,
  sessionGetCalls,
  sessionPromptCalls,
  sessionSyntheticCalls,
  setupTestEnv,
  teardownTestEnv,
  toolAfterHook,
  waitFor,
} from "./mocks/opencode-v2-harness";

// The v2 adapter's bus-event pump: instance/directory filtering, tab rpc
// routing (open caching, close routing by the closed session's own
// location), the session.get resolver's input shape, and handler-throw
// isolation.

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
  test("event pump drops events from other directories and serves matching ones", async () => {
    const context = makeContext();
    cleanup = (await setup(context as any)) as () => Promise<void>;

    // Buffer an interaction so the matching idle event triggers direct
    // extraction (session.create) - the observable for "the runtime got it".
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_v2_new",
      input: { file_path: "/src/app.ts" },
      status: "completed",
      result: { content: "const x = 1;" },
    });

    // v2 bus shape: payload in `data`; the pump translates the execution
    // lifecycle into the runtime's v1-shaped events.
    // Foreign-directory event: the pump must drop it.
    await queueEvent({
      type: "session.execution.started",
      location: { directory: "/some/other/dir" },
      data: { sessionID: "ses_v2_new" },
    });
    // Location-less event: dropped (v1's server-side filter shape) - the
    // resolver runs but the mock's session.get returns no location, so the
    // event's directory cannot be established.
    await queueEvent({
      type: "session.execution.started",
      data: { sessionID: "ses_v2_new" },
    });

    // Only a matching-directory event reaches the runtime, whose idle
    // handler triggers direct extraction through the capabilities. v2's
    // create has no parentID: a top-level session in the parent's project
    // directory (the runtime sets the child mapping eagerly).
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_new" },
    });
    await waitFor("direct extraction for ses_v2_new", () => sessionCreateCalls.length === 1);
    expect(sessionCreateCalls[0].title).toBe("thatch-extraction");
    expect(sessionCreateCalls[0].location.directory).toBe(PROJECT_DIR);
  });

  test("pump: tab rpc events carry the payload's own directory, never the publisher's location stamp", async () => {
    // Regression (M2): tab-opened/tab-closed events are stamped with the
    // PUBLISHING instance's location. Caching that against the
    // subordinate's sessionID pinned its location-less execution events to
    // the coordinator's instance - the worktree instance that owns the
    // subordinate dropped its idle signal, and the coordinator
    // double-processed it. The payload's directory field (the subordinate's
    // final, post-move directory) is the authoritative cache source.
    const WORKTREE_DIR = "/tmp/thatch-v2-test-sub-worktree";
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;

    // A tab-opened stamped by a coordinator elsewhere, carrying the
    // subordinate's FINAL directory (here: another directory entirely -
    // the directory-variant spawn). Its location-less idle event must
    // resolve to that directory and be DROPPED by this instance.
    await queueEvent({
      type: tabOpenedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_wt", directory: WORKTREE_DIR },
    });
    await queueEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_sub_wt" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(sessionCreateCalls.length).toBe(0);
    // The rpc envelope's location must not have leaked into the cache
    // either: a resolver fallback would still have dropped this, so assert
    // the resolver did not run (the cache miss fell through to get).
    expect(sessionGetCalls.some((c: any) => c?.sessionID === "ses_sub_wt")).toBe(false);

    // The positive: a tab-opened whose payload directory IS this instance's
    // directory caches the subordinate here, so its later location-less
    // idle event routes to this instance and drives extraction.
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_sub_local",
      input: { file_path: "/src/app.ts" },
      status: "completed",
      result: { content: "const x = 1;" },
    });
    await queueEvent({
      type: tabOpenedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_local", directory: SESSION_DIR },
    });
    await queueEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_sub_local" } });
    await waitFor("extraction for the locally-owned subordinate", () => sessionCreateCalls.length === 1);
    expect(sessionCreateCalls[0].title).toBe("thatch-extraction");
  });

  test("pump: tab_closed death is care-routed - a busy coordinator's row survives, no peer is prompted", async () => {
    // Regression (M3): the tab-closed event is stamped with the publisher's
    // (coordinator's) directory, so only the coordinator's instance passed
    // the instance filter and its registry held none of the subordinate's
    // watchers - the confirmed close silently no-oped. Routing now keys on
    // the CLOSED session's own directory. The death notice itself is
    // care-routed: only the coordinator named in the dead subordinate's
    // spawn metadata is a candidate recipient - never an arbitrary
    // same-project peer.
    const { ThatchDB } = await import("../src/db");
    const db = new ThatchDB(join(dbDir, "test.db"));
    db.runtimeStatePut(
      "watchers",
      "ses_sub_close",
      [{
        id: "watch_sub", source: "pr", sessionID: "ses_sub_close", repo: "acme/widgets", pr: 7,
        events: ["pr_commit"], once: false, expiresAt: Date.now() + 600_000,
        createdAt: Date.now(), state: { headSha: "aaaa1111" },
      }],
      SESSION_DIR,
    );
    db.close();

    cleanup = (await setup(makeContext({
      // The dead subordinate's spawn stamp: the coordinator link the death
      // delivery reads from session metadata.
      get: async (input: any) =>
        input?.sessionID === "ses_sub_close"
          ? { title: "subordinate", metadata: { thatch: { coordinatorSessionID: "ses_coord" } } }
          : { title: "some title" },
    }) as any)) as () => Promise<void>;
    // The coordinator is mid-turn: the push gate stays closed, so the
    // stamped row survives for the coordinator-scoped pickup.
    await queueEvent({
      type: "session.execution.started",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_coord" },
    });
    // The tab-opened cached the subordinate under THIS instance's directory
    // (a directory-variant spawn: the subordinate lives here).
    await queueEvent({
      type: tabOpenedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_close", directory: SESSION_DIR },
    });
    // The close event: the PUBLISHER's stamp points elsewhere (the
    // coordinator emitted it from another location); the closed session's
    // cached location decides.
    await queueEvent({
      type: tabClosedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_close", chatName: "rosie-unit-one-00007" },
    });
    await waitFor("watcher_death row stamped with the coordinator", () => {
      const check = new ThatchDB(join(dbDir, "test.db"));
      const death = check.runtimeStateAll().find((r) => r.kind === "watcher_death" && r.sessionID === "ses_sub_close");
      check.close();
      return (death?.value as any)?.coordinatorSessionID === "ses_coord";
    });
    const check = new ThatchDB(join(dbDir, "test.db"));
    // The confirmed close cancelled the subordinate's watchers...
    expect(check.runtimeStateAll().some((r) => r.kind === "watchers" && r.sessionID === "ses_sub_close")).toBe(false);
    // ...and the death row carries the targets for the coordinator pickup.
    const death = check.runtimeStateAll().find((r) => r.kind === "watcher_death" && r.sessionID === "ses_sub_close");
    expect((death?.value as any)?.targets).toContain("acme/widgets#7");
    // No delivery of any kind went to a session: the busy coordinator's
    // closed gate means no push, and no arbitrary peer is ever consulted.
    expect(sessionSyntheticCalls).toEqual([]);
    expect(sessionPromptCalls).toEqual([]);
    // The user's banner still fired (source-labeled toast).
    expect(rpcEmitted.some((e) => e.name === TOAST_EVENT && String(e.data?.message).includes("watcher died"))).toBe(true);
    // The roster's demotion record rides the same event: a chat_tab_closed
    // marker lets every reader (roster render, broadcast targeting) distrust
    // a residue tab row for this session instantly.
    const closure = check.runtimeStateAll().find((r) => r.kind === "chat_tab_closed" && r.sessionID === "ses_sub_close");
    expect(typeof (closure?.value as any)?.at).toBe("string");
    check.close();
  });

  test("pump: a reachable coordinator gets the death push; the row is deleted on success", async () => {
    // Delete-on-success: a surviving row would make the coordinator-scoped
    // pickup re-inject the identical notice on the coordinator's next
    // message - double delivery.
    const { ThatchDB } = await import("../src/db");
    const db = new ThatchDB(join(dbDir, "test.db"));
    db.runtimeStatePut(
      "watchers",
      "ses_sub_push",
      [{
        id: "watch_push", source: "pr", sessionID: "ses_sub_push", repo: "acme/widgets", pr: 9,
        events: ["pr_commit"], once: false, expiresAt: Date.now() + 600_000,
        createdAt: Date.now(), state: { headSha: "aaaa1111" },
      }],
      SESSION_DIR,
    );
    db.close();

    cleanup = (await setup(makeContext({
      get: async (input: any) =>
        input?.sessionID === "ses_sub_push"
          ? { title: "subordinate", metadata: { thatch: { coordinatorSessionID: "ses_coord" } } }
          : { title: "some title" },
    }) as any)) as () => Promise<void>;
    await queueEvent({
      type: tabOpenedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_push", directory: SESSION_DIR },
    });
    await queueEvent({
      type: tabClosedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_push", chatName: null },
    });
    await waitFor("the death push to the coordinator", () =>
      sessionSyntheticCalls.some((c: any) => c?.sessionID === "ses_coord" && String(c?.text).includes("acme/widgets#9")),
    );
    // The push went ONLY to the coordinator.
    expect(sessionSyntheticCalls.length).toBe(1);
    expect(sessionPromptCalls).toEqual([]);
    await waitFor("death row deleted after the successful push", () => {
      const check = new ThatchDB(join(dbDir, "test.db"));
      const left = check.runtimeStateAll().some((r) => r.kind === "watcher_death" && r.sessionID === "ses_sub_push");
      check.close();
      return !left;
    });
    // The user's banner fired too - it is their watch.
    expect(rpcEmitted.some((e) => e.name === TOAST_EVENT && String(e.data?.message).includes("watcher died"))).toBe(true);
  });

  test("pump: a death with no coordinator link is banner-only - the row is deleted after the attempt", async () => {
    // Non-subordinate death (no spawn metadata): the user banner is the
    // whole delivery. The row could never be picked up (pickup matches the
    // coordinator id only), so it is deleted rather than stranded.
    const { ThatchDB } = await import("../src/db");
    const db = new ThatchDB(join(dbDir, "test.db"));
    db.runtimeStatePut(
      "watchers",
      "ses_sub_orphan",
      [{
        id: "watch_orphan", source: "pr", sessionID: "ses_sub_orphan", repo: "acme/widgets", pr: 10,
        events: ["pr_commit"], once: false, expiresAt: Date.now() + 600_000,
        createdAt: Date.now(), state: { headSha: "aaaa1111" },
      }],
      SESSION_DIR,
    );
    db.close();

    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await queueEvent({
      type: tabOpenedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_orphan", directory: SESSION_DIR },
    });
    await queueEvent({
      type: tabClosedEventType,
      location: { directory: "/some/coordinator/dir" },
      data: { sessionID: "ses_sub_orphan", chatName: "lone-wolf-00001" },
    });
    await waitFor("the death banner", () =>
      rpcEmitted.some((e) => e.name === TOAST_EVENT && String(e.data?.message).includes("watcher died")),
    );
    // No prompt of any kind: an arbitrary peer is never the recipient.
    expect(sessionSyntheticCalls).toEqual([]);
    expect(sessionPromptCalls).toEqual([]);
    await waitFor("death row deleted after the banner-only attempt", () => {
      const check = new ThatchDB(join(dbDir, "test.db"));
      const left = check.runtimeStateAll().some((r) => r.kind === "watcher_death" && r.sessionID === "ses_sub_orphan");
      check.close();
      return !left;
    });
  });

  test("pump: tab_closed for a session owned elsewhere is ignored", async () => {
    // The other side of the M3 routing: this instance must not run the
    // death path for a subordinate whose owning instance lives in another
    // directory (the old code ran it against the publisher's stamp and
    // silently deleted a death row nobody received).
    const { ThatchDB } = await import("../src/db");
    const db = new ThatchDB(join(dbDir, "test.db"));
    db.runtimeStatePut(
      "watchers",
      "ses_sub_foreign",
      [{
        id: "watch_foreign", source: "pr", sessionID: "ses_sub_foreign", repo: "acme/widgets", pr: 8,
        events: ["pr_commit"], once: false, expiresAt: Date.now() + 600_000,
        createdAt: Date.now(), state: { headSha: "aaaa1111" },
      }],
      SESSION_DIR,
    );
    db.close();

    cleanup = (await setup(makeContext({
      get: async () => ({ data: { title: "t", location: { directory: "/tmp/thatch-v2-test-elsewhere" } } }),
    }) as any)) as () => Promise<void>;
    // No cache entry: the pump resolves the closed session's directory live
    // (a session in another location) and drops the close.
    await queueEvent({
      type: tabClosedEventType,
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_sub_foreign", chatName: null },
    });
    await new Promise((r) => setTimeout(r, 50));
    const check = new ThatchDB(join(dbDir, "test.db"));
    expect(check.runtimeStateAll().some((r) => r.kind === "watcher_death" && r.sessionID === "ses_sub_foreign")).toBe(false);
    // The watcher row survives - its owning instance owns the close.
    expect(check.runtimeStateAll().some((r) => r.kind === "watchers" && r.sessionID === "ses_sub_foreign")).toBe(true);
    check.close();
  });

  test("session get resolves by sessionID and location-less events survive handler throws", async () => {
    const context = makeContext({
      // A shared-DB hiccup under v2 (SQLITE_BUSY etc.) surfaces as a throw
      // from the get endpoint; the pump must log and keep consuming.
      get: async (input: any) => {
        if (input?.sessionID === "ses_v2_dead") throw new Error("database is locked");
        return { data: { title: "t" } };
      },
    });
    cleanup = (await setup(context as any)) as () => Promise<void>;

    // Location-less event for a session whose get throws: the per-event
    // catch swallows it, and - critically - the loop continues.
    await queueEvent({ type: "session.execution.started", data: { sessionID: "ses_v2_dead" } });
    // The resolver must be using the v2 input shape ({sessionID}, not {id}).
    expect(sessionGetCalls.length).toBe(1);
    expect(sessionGetCalls[0]).toEqual({ sessionID: "ses_v2_dead" });

    // A subsequent event for a session whose get succeeds still lands.
    await toolAfterHook!({
      tool: "Read",
      sessionID: "ses_v2_alive",
      input: { file_path: "/src/app.ts" },
      status: "completed",
      result: { content: "const x = 1;" },
    });
    await queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_v2_alive" },
    });
    await waitFor("extraction after a handler throw", () => sessionCreateCalls.length === 1);
  });
});
