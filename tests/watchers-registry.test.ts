import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  WatcherRegistry,
  type Watcher,
  type WatcherEvent,
  type WatcherRegistryOptions,
} from "../src/watchers";
import { silenceConsoleError } from "./mocks/console-error";
import {
  TGT,
  URL,
  mockGh,
  prResponse,
  quietGh,
  quietRoutes,
  RE_PULL,
  RE_ISSUE_COMMENTS,
  RE_REVIEW_COMMENTS,
  RE_CHECK_RUNS,
  RE_GRAPHQL,
} from "./mocks/watchers-harness";

// ---------------------------------------------------------------------------
// WatcherRegistry
// ---------------------------------------------------------------------------

describe("WatcherRegistry", () => {
  let delivered: Array<{ sessionID: string; events: WatcherEvent[] }>;
  let canDeliver: boolean;
  let registry: WatcherRegistry;

  const makeRegistry = (overrides: { ttlMinutes?: number; maxPerSession?: number } = {}) => {
    registry = new WatcherRegistry({
      deliver: async (sessionID, events) => {
        delivered.push({ sessionID, events });
      },
      canDeliver: () => canDeliver,
      ghRunner: quietGh(),
      pollIntervalMs: 60_000,
      ...overrides,
    });
    return registry;
  };

  beforeEach(() => {
    delivered = [];
    canDeliver = true;
  });

  afterEach(() => {
    registry?.dispose();
  });

  test("create captures baseline state and returns the watcher", async () => {
    const reg = makeRegistry();
    const result = await reg.createPr("s1", "acme/widgets", 7, ["pr_comment"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.watcher.sessionID).toBe("s1");
    expect(result.watcher.repo).toBe("acme/widgets");
    expect(result.watcher.pr).toBe(7);
    expect(result.watcher.state.headSha).toBe("aaaa1111");
    expect(reg.listForSession("s1")).toHaveLength(1);
  });

  test("create reports gh failures as errors", async () => {
    const reg = new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => true,
      ghRunner: async () => {
        throw new Error("gh: not authenticated");
      },
      pollIntervalMs: 60_000,
    });
    const result = await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("gh: not authenticated");
  });

  test("pollSeconds surfaces the poll cadence for tool output and notifications", () => {
    const reg = makeRegistry();
    expect(reg.pollSeconds).toBe(60);
    const custom = new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => true,
      ghRunner: quietGh(),
      pollIntervalMs: 90_000,
    });
    expect(custom.pollSeconds).toBe(90);
    custom.dispose();
  });

  test("create enforces the per-session watcher limit", async () => {
    const reg = makeRegistry({ maxPerSession: 2 });
    expect((await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"])).ok).toBe(true);
    expect((await reg.createPr("s1", "acme/widgets", 8, ["pr_commit"])).ok).toBe(true);
    const third = await reg.createPr("s1", "acme/widgets", 9, ["pr_commit"]);
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error).toContain("limit");
    // A different session is not affected by s1's limit.
    expect((await reg.createPr("s2", "acme/widgets", 9, ["pr_commit"])).ok).toBe(true);
  });

  test("cancel is session-scoped", async () => {
    const reg = makeRegistry();
    const result = await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    if (!result.ok) throw new Error("unreachable");
    expect(reg.cancel("s2", result.watcher.id)).toBe(false);
    expect(reg.cancel("s1", result.watcher.id)).toBe(true);
    expect(reg.listForSession("s1")).toHaveLength(0);
  });

  test("poll detects events, filters by watched types, and delivers", async () => {
    let changed = false;
    const reg = new WatcherRegistry({
      deliver: async (sessionID, events) => {
        delivered.push({ sessionID, events });
      },
      canDeliver: () => canDeliver,
      ghRunner: mockGh([
        [RE_PULL, () => changed ? prResponse({ head: { sha: "ffff0000" } }) : prResponse()],
        ...quietRoutes(),
      ]),
      pollIntervalMs: 60_000,
    });
    await reg.createPr("s1", "acme/widgets", 7, ["pr_commit", "pr_status"]);
    // First poll sees no change (baseline was just captured).
    await reg.poll();
    expect(delivered).toHaveLength(0);
    expect(reg.pendingCount("s1")).toBe(0);

    // Simulate the PR changing: the mocked gh returns the new head once
    // the flag flips.
    changed = true;
    await reg.poll();
    expect(reg.pendingCount("s1")).toBe(0); // delivered already
    expect(delivered).toHaveLength(1);
    expect(delivered[0].sessionID).toBe("s1");
    expect(delivered[0].events.map((e) => e.type)).toEqual(["pr_commit"]);
  });

  test("a rebuild that rehydrates the journal does not replay delivered events", async () => {
    const journaled: Watcher[][] = [];
    let changed = false;
    const build = () =>
      new WatcherRegistry({
        deliver: async (sessionID, events) => {
          delivered.push({ sessionID, events });
        },
        canDeliver: () => canDeliver,
        ghRunner: mockGh([
          [RE_PULL, () => (changed ? prResponse({ head: { sha: "ffff0000" } }) : prResponse())],
          ...quietRoutes(),
        ]),
        journal: (_sessionID, watchers) => journaled.push([...watchers]),
        pollIntervalMs: 60_000,
      });
    const reg = build();
    await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    changed = true;
    await reg.poll();
    expect(delivered).toHaveLength(1);
    // The poll journaled the ADVANCED state, not the creation baseline -
    // this journal row is what a reload rehydrates.
    const baseline = journaled.at(-1)?.[0];
    if (!baseline || baseline.source !== "pr") throw new Error("expected a journaled pr watcher");
    expect(baseline.state.headSha).toBe("ffff0000");

    // A fresh registry (v2 reload rehydration, the watch tools' reconcile)
    // hydrates the journal and polls again: no events may re-fire.
    reg.dispose();
    const rebuilt = build();
    rebuilt.hydrate(journaled.at(-1) ?? []);
    await rebuilt.poll();
    expect(delivered).toHaveLength(1);
    expect(rebuilt.pendingCount("s1")).toBe(0);
    rebuilt.dispose();
  });

  test("events for unwatched types are filtered out", async () => {
    const reg = new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => true,
      ghRunner: quietGh(),
      pollIntervalMs: 60_000,
    });
    await reg.createPr("s1", "acme/widgets", 7, ["pr_ci"]);
    // Force a state change that produces only a pr_commit event.
    const prWatcher = reg.listForSession("s1")[0];
    if (prWatcher.source !== "pr") throw new Error("expected a pr watcher");
    prWatcher.state.headSha = "old";
    await reg.poll();
    expect(delivered).toHaveLength(0);
    expect(reg.pendingCount("s1")).toBe(0);
  });

  test("delivery waits for canDeliver and succeeds later", async () => {
    canDeliver = false;
    const reg = makeRegistry();
    await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    const prWatcher = reg.listForSession("s1")[0];
    if (prWatcher.source !== "pr") throw new Error("expected a pr watcher");
    prWatcher.state.headSha = "old";
    await reg.poll();
    expect(delivered).toHaveLength(0);
    expect(reg.pendingCount("s1")).toBe(1);

    canDeliver = true;
    await reg.deliverPending();
    expect(delivered).toHaveLength(1);
    expect(reg.pendingCount("s1")).toBe(0);
  });

  test("failed delivery stays pending and retries", async () => {
    let fail = true;
    // The production retry path logs each failed delivery; the scope
    // swallows it so the expected failure does not leak into the output.
    const reg = new WatcherRegistry({
      deliver: async (sessionID, events) => {
        if (fail) throw new Error("busy");
        delivered.push({ sessionID, events });
      },
      canDeliver: () => true,
      ghRunner: quietGh(),
      pollIntervalMs: 60_000,
    });
    await silenceConsoleError(async () => {
      await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
      const prWatcher = reg.listForSession("s1")[0];
      if (prWatcher.source !== "pr") throw new Error("expected a pr watcher");
      prWatcher.state.headSha = "old";
      await reg.poll();
      expect(reg.pendingCount("s1")).toBe(1);

      fail = false;
      await reg.deliverPending();
      expect(delivered).toHaveLength(1);
      expect(reg.pendingCount("s1")).toBe(0);
    });
  });

  test("expired watchers report their expiry to the session and are dropped", async () => {
    const reg = makeRegistry();
    await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    const prWatcher = reg.listForSession("s1")[0];
    if (prWatcher.source !== "pr") throw new Error("expected a pr watcher");
    // Age the watch past its TTL by hand: a 480-minute life that just ended.
    prWatcher.createdAt = Date.now() - 480 * 60_000;
    prWatcher.expiresAt = Date.now() - 1;
    await reg.poll();
    expect(reg.listForSession("s1")).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].events.map((e) => e.type)).toEqual(["watch_expired"]);
    expect(delivered[0].events[0].summary).toContain("acme/widgets#7");
    expect(delivered[0].events[0].summary).toContain("480 min");
    // The expiry is reported once - later polls stay quiet.
    await reg.poll();
    expect(delivered).toHaveLength(1);
  });

  test("cancelSession drops watchers and pending events", async () => {
    canDeliver = false;
    const reg = makeRegistry();
    await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    const prWatcher = reg.listForSession("s1")[0];
    if (prWatcher.source !== "pr") throw new Error("expected a pr watcher");
    prWatcher.state.headSha = "old";
    await reg.poll();
    expect(reg.pendingCount("s1")).toBe(1);
    reg.cancelSession("s1");
    expect(reg.listForSession("s1")).toHaveLength(0);
    expect(reg.pendingCount("s1")).toBe(0);
  });

  test("dispose stops the poller and clears state", () => {
    const reg = makeRegistry();
    reg.start();
    expect(reg.running).toBe(true);
    reg.dispose();
    expect(reg.running).toBe(false);
  });

  test("one watcher's poll failure does not block the others", async () => {
    const reg = new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => true,
      ghRunner: (apiArgs) => {
        if (apiArgs.join(" ").includes("/pulls/7")) throw new Error("boom");
        return mockGh([
          [RE_PULL, prResponse({ head: { sha: "bbbb0000" } })],
          [RE_ISSUE_COMMENTS, []],
          [RE_REVIEW_COMMENTS, []],
          [RE_CHECK_RUNS, { check_runs: [] }],
          [RE_GRAPHQL, { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }],
        ])(apiArgs);
      },
      pollIntervalMs: 60_000,
    });
    await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    await reg.createPr("s1", "acme/widgets", 8, ["pr_commit"]);
    reg.listForSession("s1").forEach((w) => {
      if (w.source !== "pr") return;
      w.state.headSha = w.pr === 7 ? "aaaa1111" : "old";
    });
    await reg.poll();
    // Watcher 7 failed (no state change anyway), watcher 8 delivered.
    expect(delivered).toHaveLength(1);
    expect(delivered[0].events[0].type).toBe("pr_commit");
  });
});

describe("watcher death detection", () => {
  let clock = 1_000_000;
  const now = () => clock;
  let errorLog: typeof console.error;
  // The death path logs each failed delivery; silence the expected errors
  // so the test output stays readable.
  beforeEach(() => {
    errorLog = console.error;
    console.error = () => {};
  });
  afterEach(() => {
    console.error = errorLog;
  });
  const notFound = () => {
    const e = new Error("HTTP 404: session not found") as Error & { statusCode: number };
    e.statusCode = 404;
    return e;
  };

  const makeRegistry = (overrides: Partial<WatcherRegistryOptions> = {}) => {
    const reg = new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => true,
      ghRunner: mockGh([[RE_PULL, prResponse()], ...quietRoutes()]),
      pollIntervalMs: 60_000,
      now,
      ...overrides,
    });
    return reg;
  };

  const seedPending = async (reg: WatcherRegistry, sessionID = "s1") => {
    await reg.createPr(sessionID, "acme/widgets", 7, ["pr_commit"]);
    const w = reg.listForSession(sessionID)[0];
    if (w.source !== "pr") throw new Error("expected a pr watcher");
    w.state.headSha = "old";
    await reg.poll(); // detect + queue + (throwing) delivery attempt
  };

  test("aged pending + consecutive 404 deliveries declare death once", async () => {
    const deaths: Array<{ sessionID: string; death: { chatName: string | null; targets: string[] } }> = [];
    const reg = makeRegistry({
      deliver: async () => { throw notFound(); },
      onSessionDeath: (sessionID, death) => deaths.push({ sessionID, death }),
      isHostedSession: () => true,
      deathMinutes: 120,
    });
    await seedPending(reg);
    expect(deaths).toHaveLength(0);
    clock += 121 * 60_000;
    for (let i = 0; i < 5; i++) await reg.poll(); // throws accumulate to MIN_DEATH_THROWS
    expect(deaths).toHaveLength(1);
    expect(deaths[0].sessionID).toBe("s1");
    expect(deaths[0].death.targets).toContain("acme/widgets#7");
    expect(reg.listForSession("s1")).toHaveLength(0);
    expect(reg.pendingCount("s1")).toBe(0);
    await reg.poll();
    expect(deaths).toHaveLength(1); // fires once
  });

  test("skipped deliveries reset the chain - a busy or compacting session never dies", async () => {
    let deliverable = true;
    const deaths: unknown[] = [];
    const reg = makeRegistry({
      deliver: async () => { throw notFound(); },
      canDeliver: () => deliverable,
      onSessionDeath: (sessionID, death) => deaths.push({ sessionID, death }),
      isHostedSession: () => true,
      deathMinutes: 1,
    });
    await seedPending(reg);
    for (let i = 0; i < 12; i++) {
      await reg.poll(); // alternates throw / skip - every skip resets
      deliverable = !deliverable;
      clock += 10 * 60_000;
    }
    expect(deaths).toHaveLength(0);
  });

  test("5xx delivery errors never declare death (a wedged server is not a dead session)", async () => {
    const deaths: unknown[] = [];
    const reg = makeRegistry({
      deliver: async () => { throw new Error("HTTP 502: bad gateway"); },
      onSessionDeath: (sessionID, death) => deaths.push({ sessionID, death }),
      isHostedSession: () => true,
      deathMinutes: 1,
    });
    await seedPending(reg);
    clock += 3 * 60 * 60_000;
    for (let i = 0; i < 8; i++) await reg.poll();
    expect(deaths).toHaveLength(0);
  });

  test("sessions this process does not host are never declared dead", async () => {
    const deaths: unknown[] = [];
    const reg = makeRegistry({
      deliver: async () => { throw notFound(); },
      onSessionDeath: (sessionID, death) => deaths.push({ sessionID, death }),
      isHostedSession: () => false,
      deathMinutes: 1,
    });
    await seedPending(reg);
    clock += 3 * 60 * 60_000;
    for (let i = 0; i < 8; i++) await reg.poll();
    expect(deaths).toHaveLength(0);
    // The watcher survives (the death path must not have touched it).
    expect(reg.listForSession("s1")).toHaveLength(1);
  });

  test("the confirmed-close fast path (sessionDied) skips the threshold", async () => {
    const deaths: Array<{ sessionID: string; death: { chatName: string | null; targets: string[] } }> = [];
    const reg = makeRegistry({
      onSessionDeath: (sessionID, death) => deaths.push({ sessionID, death }),
    });
    await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    clock += 1000; // no aging at all
    reg.sessionDied("s1", { chatName: "rosie-unit-one-00007" });
    expect(deaths).toHaveLength(1);
    expect(deaths[0].death.chatName).toBe("rosie-unit-one-00007");
    expect(reg.listForSession("s1")).toHaveLength(0);
  });

  test("pending events survive a reload through the pending journal", async () => {
    const watcherJournals: Array<{ sessionID: string; watchers: Watcher[] }> = [];
    const pendingJournals: Array<{ sessionID: string; pending: { event: WatcherEvent; queuedAt: number }[] | undefined }> = [];
    const delivered: Array<{ sessionID: string; events: WatcherEvent[] }> = [];
    const build = () =>
      new WatcherRegistry({
        deliver: async (sessionID, events) => { delivered.push({ sessionID, events }); },
        canDeliver: () => false, // the session is busy - the queue never drains
        ghRunner: mockGh([[RE_PULL, prResponse()], ...quietRoutes()]),
        pollIntervalMs: 60_000,
        journal: (sessionID, watchers) => watcherJournals.push({ sessionID, watchers }),
        journalPending: (sessionID, pending) => pendingJournals.push({ sessionID, pending }),
        now,
      });
    const reg = build();
    await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    const w = reg.listForSession("s1")[0];
    if (w.source !== "pr") throw new Error("expected a pr watcher");
    w.state.headSha = "old";
    await reg.poll();
    expect(pendingJournals.at(-1)?.pending).toBeDefined();

    // The reload: a fresh registry rehydrates definitions AND pending.
    reg.dispose();
    const lastWatchers = watcherJournals.at(-1);
    const lastPending = pendingJournals.at(-1);
    if (!lastWatchers || !lastPending || !lastPending.pending) throw new Error("journal rows missing");
    const rebuilt = new WatcherRegistry({
      deliver: async (sessionID, events) => { delivered.push({ sessionID, events }); },
      canDeliver: () => true, // the session goes idle after the reload
      ghRunner: mockGh([[RE_PULL, prResponse()], ...quietRoutes()]),
      pollIntervalMs: 60_000,
      now,
    });
    rebuilt.hydrate(lastWatchers.watchers);
    rebuilt.hydratePending(lastPending.sessionID, lastPending.pending);
    await rebuilt.poll();
    expect(delivered.at(-1)?.events[0].type).toBe("pr_commit");
    rebuilt.dispose();
  });

  test("hydratePending re-journals the queue so it stays durable until delivery", () => {
    // The rehydrate loop and the dormant scan delete the durable row as
    // they hand it over; hydration must write it straight back, or a
    // SECOND reload before delivery loses the events again.
    const pendingJournals: Array<{ sessionID: string; pending: { event: WatcherEvent; queuedAt: number }[] | undefined }> = [];
    const reg = new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => false,
      ghRunner: mockGh([[RE_PULL, prResponse()], ...quietRoutes()]),
      pollIntervalMs: 60_000,
      journalPending: (sessionID, pending) => pendingJournals.push({ sessionID, pending }),
      now,
    });
    reg.hydratePending("s1", [{ event: { type: "pr_commit", target: TGT, summary: "new commit", url: URL }, queuedAt: 5 }]);
    const last = pendingJournals.at(-1);
    expect(last?.sessionID).toBe("s1");
    expect(last?.pending).toHaveLength(1);
    expect(last?.pending?.[0].queuedAt).toBe(5);
    reg.dispose();
  });
});

describe("WatcherRegistry live handoff (per location)", () => {
  const handoffRegistry = (directory?: string) =>
    new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => false,
      ghRunner: async () => {
        throw new Error("no network in test");
      },
      pollIntervalMs: 60_000,
      ...(directory !== undefined ? { directory } : {}),
    });

  test("a second per-location instance does not stop the coordinator's poller", () => {
    // The worktree-subordinate flow boots a second per-location thatch
    // instance in the SAME serve process; its registry constructor must not
    // stop the coordinator location's poller (the old global handoff did).
    const coordinator = handoffRegistry("/proj");
    coordinator.start();
    const subordinate = handoffRegistry("/proj-wt-main");
    subordinate.start();
    expect(coordinator.running).toBe(true);
    expect(subordinate.running).toBe(true);
    subordinate.dispose();
    coordinator.dispose();
  });

  test("a same-directory reload still hands the poller off", () => {
    const first = handoffRegistry("/proj");
    first.start();
    const reloaded = handoffRegistry("/proj");
    reloaded.start();
    expect(first.running).toBe(false);
    expect(reloaded.running).toBe(true);
    reloaded.dispose();
  });

  test("disposing a replaced registry does not clear the replacement's live slot", () => {
    const first = handoffRegistry("/proj");
    first.start();
    const reloaded = handoffRegistry("/proj");
    reloaded.start();
    first.dispose();
    expect(reloaded.running).toBe(true);
    reloaded.dispose();
  });
});

describe("branch watchers in the registry", () => {
  let delivered: Array<{ sessionID: string; events: WatcherEvent[] }>;
  let canDeliver: boolean;

  beforeEach(() => {
    delivered = [];
    canDeliver = true;
  });

  test("createBranch captures the baseline and poll delivers branch events", async () => {
    let pushed = false;
    const reg = new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => canDeliver,
      ghRunner: mockGh([
        [/\/branches\/main$/, () => ({ commit: { sha: pushed ? "dddd7777" : "aaaa1111" } })],
        [/\/actions\/runs\?/, { workflow_runs: [] }],
        ...quietRoutes(),
      ]),
      pollIntervalMs: 60_000,
    });
    const result = await reg.createBranch("s1", "acme/widgets", "main", ["branch_commit", "branch_workflow"]);
    expect(result.ok).toBe(true);
    await reg.poll();
    expect(delivered).toHaveLength(0);

    pushed = true;
    await reg.poll();
    expect(reg.pendingCount("s1")).toBe(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].events.map((e) => e.type)).toEqual(["branch_commit"]);
    reg.dispose();
  });

  test("the workflow-name filter narrows branch_workflow events only", async () => {
    let headMoved = false;
    const reg = new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => canDeliver,
      ghRunner: mockGh([
        [/\/branches\/main$/, () => ({ commit: { sha: headMoved ? "dddd7777" : "aaaa1111" } })],
        [/\/actions\/runs\?/, { workflow_runs: [] }],
        ...quietRoutes(),
      ]),
      pollIntervalMs: 60_000,
    });
    await reg.createBranch("s1", "acme/widgets", "main", ["branch_commit", "branch_workflow"], ["release"]);
    const w = reg.listForSession("s1")[0];
    expect(w.source).toBe("branch");
    if (w.source !== "branch") return;

    // A CI-named workflow run does not match the "release" filter - dropped.
    w.state.workflowRuns["77"] = { name: "CI", status: "in_progress", conclusion: null, url: "https://x/77", event: "push", headBranch: "main", headSha: "aaaa1111" };
    await reg.poll();
    expect(delivered).toHaveLength(0);
    expect(reg.pendingCount("s1")).toBe(0);

    // But a commit landing passes the filter unfiltered - a watch filtered
    // to "Publish" still reports that main moved.
    headMoved = true;
    await reg.poll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].events.map((e) => e.type)).toEqual(["branch_commit"]);
    reg.dispose();
  });

  test("a one-shot watcher auto-cancels after its first event, and the event still delivers", async () => {
    let headMoved = false;
    const reg = new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => canDeliver,
      ghRunner: mockGh([
        [/\/branches\/main$/, () => ({ commit: { sha: headMoved ? "dddd7777" : "aaaa1111" } })],
        [/\/actions\/runs\?/, { workflow_runs: [] }],
        ...quietRoutes(),
      ]),
      pollIntervalMs: 60_000,
    });
    const result = await reg.createBranch("s1", "acme/widgets", "main", ["branch_commit"], [], { once: true });
    expect(result.ok).toBe(true);

    // No event yet - the watcher survives.
    await reg.poll();
    expect(reg.listForSession("s1")).toHaveLength(1);

    // First event: the watcher self-cancels at detection, but the event
    // still queues and delivers through the normal pending path.
    headMoved = true;
    await reg.poll();
    expect(reg.listForSession("s1")).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].events.map((e) => e.type)).toEqual(["branch_commit"]);

    // No second event even if the target moves again.
    headMoved = false;
    await reg.poll();
    expect(delivered).toHaveLength(1);
    reg.dispose();
  });

  test("standing watchers are not cancelled by firing", async () => {
    let headMoved = false;
    const reg = new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => canDeliver,
      ghRunner: mockGh([
        [/\/branches\/main$/, () => ({ commit: { sha: headMoved ? "dddd7777" : "aaaa1111" } })],
        [/\/actions\/runs\?/, { workflow_runs: [] }],
        ...quietRoutes(),
      ]),
      pollIntervalMs: 60_000,
    });
    await reg.createBranch("s1", "acme/widgets", "main", ["branch_commit"]);
    headMoved = true;
    await reg.poll();
    expect(reg.listForSession("s1")).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    reg.dispose();
  });
});

// ---------------------------------------------------------------------------
// Command watchers in the registry
// ---------------------------------------------------------------------------

describe("command watchers in the registry", () => {
  let delivered: Array<{ sessionID: string; events: WatcherEvent[] }>;
  let canDeliver: boolean;

  beforeEach(() => {
    delivered = [];
    canDeliver = true;
  });

  /** Builds a fake CommandRunner whose exit code comes from this closure. */
  const makeRegistry = (
    exits: number[],
    overrides: { maxPerSession?: number; commandTimeoutMs?: number } = {},
  ) => {
    let run = 0;
    return new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => canDeliver,
      ghRunner: quietGh(),
      commandRunner: async () => {
        const exitCode = exits[Math.min(run, exits.length - 1)];
        run++;
        return { exitCode, timedOut: false, stderr: exitCode === 127 ? "bash: nope: command not found" : "", durationMs: 1200 };
      },
      commandTimeoutMs: 30_000,
      pollIntervalMs: 60_000,
      ...overrides,
    });
  };

  test("createCommand captures the baseline and fires on the first exit 0", async () => {
    // Baseline exits 1; the first poll exits 1 (no event); the second exits 0.
    const reg = makeRegistry([1, 1, 0]);
    const result = await reg.createCommand("s1", "test -f /tmp/marker", "/tmp");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.watcher.once).toBe(true);
    expect(result.watcher.state.lastExit).toBe(1);

    await reg.poll();
    expect(delivered).toHaveLength(0);
    expect(reg.listForSession("s1")).toHaveLength(1);

    await reg.poll();
    expect(reg.listForSession("s1")).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].events).toHaveLength(1);
    const event = delivered[0].events[0];
    expect(event.type).toBe("command_success");
    expect(event.summary).toContain("exited 0");
    expect(event.summary).toContain("1.2s");
    expect(event.url).toBe("");
    reg.dispose();
  });

  test("a command that already exits 0 is refused - the condition is already met", async () => {
    const reg = makeRegistry([0]);
    const result = await reg.createCommand("s1", "true", "/tmp");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already exits 0");
    expect(reg.listForSession("s1")).toHaveLength(0);
  });

  test("a command that exits 127 is refused - nothing exists to wait for", async () => {
    const reg = makeRegistry([127]);
    const result = await reg.createCommand("s1", "nope", "/tmp");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("127");
    expect(result.error).toContain("command not found");
    expect(reg.listForSession("s1")).toHaveLength(0);
  });

  test("a spawn failure is refused with a real error", async () => {
    const reg = new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => canDeliver,
      ghRunner: quietGh(),
      commandRunner: async () => {
        throw new Error("bash exploded");
      },
      pollIntervalMs: 60_000,
    });
    const result = await reg.createCommand("s1", "anything", "/tmp");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bash exploded");
    expect(reg.listForSession("s1")).toHaveLength(0);
  });

  test("a timed-out run means not-done-yet: no event, watcher survives", async () => {
    let run = 0;
    const reg = new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => canDeliver,
      ghRunner: quietGh(),
      commandRunner: async () => {
        run++;
        return run === 1
          ? { exitCode: 1, timedOut: false, stderr: "", durationMs: 100 }
          : { exitCode: 124, timedOut: true, stderr: "", durationMs: 30_000 };
      },
      pollIntervalMs: 60_000,
    });
    const result = await reg.createCommand("s1", "slow thing", "/tmp");
    expect(result.ok).toBe(true);
    await reg.poll();
    expect(delivered).toHaveLength(0);
    expect(reg.listForSession("s1")).toHaveLength(1);
    // The timed-out run left the last-seen exit untouched.
    const cmdWatcher = reg.listForSession("s1")[0];
    if (cmdWatcher.source !== "command") throw new Error("expected a command watcher");
    expect(cmdWatcher.state.lastExit).toBe(1);
    reg.dispose();
  });

  test("a persistent non-zero exit keeps polling without events", async () => {
    const reg = makeRegistry([1, 1, 1, 1]);
    await reg.createCommand("s1", "test -f /tmp/marker", "/tmp");
    for (let i = 0; i < 3; i++) await reg.poll();
    expect(delivered).toHaveLength(0);
    expect(reg.listForSession("s1")).toHaveLength(1);
    reg.dispose();
  });

  test("command watchers share the per-session limit with other sources", async () => {
    const reg = makeRegistry([1, 1], { maxPerSession: 2 });
    await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
    const result = await reg.createCommand("s1", "test -f /tmp/marker", "/tmp");
    expect(result.ok).toBe(true);
    const second = await reg.createCommand("s1", "test -f /tmp/other", "/tmp");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain("Watcher limit reached");
    reg.dispose();
  });
});
