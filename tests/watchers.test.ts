import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watcherNotificationNudge, watcherDeathNotice } from "../src/prompts";
import { runWatchedCommand, drainStreamOutput, withCwdFallback, type CommandRunResult } from "../src/watchers";
import {
  WatcherRegistry,
  diffPrState,
  diffBranchState,
  fetchPrState,
  fetchBranchState,
  describeBaselineCheckRuns,
  commandTargetLabel,
  COMMAND_EVENT_TYPES,
  PR_EVENT_TYPES,
  BRANCH_EVENT_TYPES,
  WATCHER_EVENT_TYPES,
  type GhRunner,
  type PrState,
  type BranchState,
  type Watcher,
  type WatcherEvent,
  type WatcherEventType,
  type WatcherRegistryOptions,
} from "../src/watchers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TGT = "acme/widgets#7";
const URL = "https://github.com/acme/widgets/pull/7";

function baseState(overrides: Partial<PrState> = {}): PrState {
  return {
    headSha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
    state: "open",
    merged: false,
    title: "Add widget",
    bodySha: "body-hash-1",
    lastIssueCommentId: 100,
    lastReviewCommentId: 200,
    issueComments: [{ id: 100, author: "alice", url: "https://github.com/acme/widgets/pull/7#issuecomment-100", isReply: false }],
    reviewComments: [],
    resolvedThreads: [],
    checkRuns: {
      "1": { name: "ci", status: "completed", conclusion: "success", url: "https://example.com/ci" },
    },
    ...overrides,
  };
}

/** Builds a gh runner from regex routes (matched against the joined args). First match wins; unmatched calls throw. Route values may be functions, called with the joined args. */
function mockGh(routes: Array<[RegExp, unknown]>): GhRunner {
  return async (apiArgs: string[]) => {
    const joined = apiArgs.join(" ");
    for (const [pattern, response] of routes) {
      if (!pattern.test(joined)) continue;
      return typeof response === "function" ? (response as (p: string) => unknown)(joined) : response;
    }
    throw new Error(`mockGh: no route for ${joined}`);
  };
}

function prResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    head: { sha: "aaaa1111" },
    state: "open",
    merged: false,
    title: "Add widget",
    body: "description",
    ...overrides,
  };
}

const RE_PULL = /\/pulls\/\d+$/;
const RE_ISSUE_COMMENTS = /\/issues\/\d+\/comments/;
const RE_REVIEW_COMMENTS = /\/pulls\/\d+\/comments/;
const RE_CHECK_RUNS = /\/check-runs/;
const RE_GRAPHQL = /^graphql/;

const quietRoutes = (): Array<[RegExp, unknown]> => [
  [RE_ISSUE_COMMENTS, []],
  [RE_REVIEW_COMMENTS, []],
  [RE_CHECK_RUNS, { check_runs: [] }],
  [RE_GRAPHQL, { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }],
  [RE_PULL, prResponse()],
];

function quietGh(): GhRunner {
  return mockGh(quietRoutes());
}

// ---------------------------------------------------------------------------
// diffPrState
// ---------------------------------------------------------------------------

describe("diffPrState", () => {
  test("no changes produces no events", () => {
    expect(diffPrState(baseState(), baseState(), TGT, URL)).toEqual([]);
  });

  test("head SHA change emits pr_commit", () => {
    const after = baseState({ headSha: "ffff0000ffff0000ffff0000ffff0000ffff0000" });
    const events = diffPrState(baseState(), after, TGT, URL);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("pr_commit");
    expect(events[0].summary).toContain("ffff000");
    expect(events[0].url).toBe(URL);
  });

  test("state change emits pr_status, merged wins in the summary", () => {
    const events = diffPrState(baseState(), baseState({ state: "closed" }), TGT, URL);
    expect(events[0].type).toBe("pr_status");
    expect(events[0].summary).toContain("closed");

    const merged = diffPrState(baseState(), baseState({ merged: true }), TGT, URL);
    expect(merged[0].summary).toContain("merged");
  });

  test("body hash change emits pr_description", () => {
    const events = diffPrState(baseState(), baseState({ bodySha: "body-hash-2" }), TGT, URL);
    expect(events.map((e) => e.type)).toContain("pr_description");
  });

  test("title change emits pr_description", () => {
    const events = diffPrState(baseState(), baseState({ title: "Rename widget" }), TGT, URL);
    expect(events.map((e) => e.type)).toContain("pr_description");
  });

  test("new issue comments emit pr_comment with author, replies emit pr_review_reply", () => {
    const before = baseState();
    const after = baseState({
      lastIssueCommentId: 105,
      issueComments: [
        ...before.issueComments,
        { id: 105, author: "bob", url: "https://github.com/acme/widgets/pull/7#issuecomment-105", isReply: false },
      ],
      lastReviewCommentId: 210,
      reviewComments: [
        { id: 210, author: "carol", url: "https://github.com/acme/widgets/pull/7#discussion_r210", isReply: true },
      ],
    });
    const events = diffPrState(before, after, TGT, URL);
    const types = events.map((e) => e.type);
    expect(types).toContain("pr_comment");
    expect(types).toContain("pr_review_reply");
    const comment = events.find((e) => e.type === "pr_comment")!;
    expect(comment.summary).toContain("bob");
  });

  test("thread resolution transitions emit pr_review_resolved with direction in the summary", () => {
    const resolved = baseState({ resolvedThreads: ["PRRT_1"] });
    const events = diffPrState(baseState(), resolved, TGT, URL);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("pr_review_resolved");
    expect(events[0].summary).toContain("resolved");

    // Resolving again is not an event.
    expect(diffPrState(resolved, baseState({ resolvedThreads: ["PRRT_1"] }), TGT, URL)).toEqual([]);

    // Reopening emits the reopened direction.
    const reopen = diffPrState(resolved, baseState(), TGT, URL);
    expect(reopen).toHaveLength(1);
    expect(reopen[0].summary).toContain("reopened");
  });

  test("check run reaching completion emits pr_ci; already-completed runs do not", () => {
    const before = baseState({
      checkRuns: { "1": { name: "ci", status: "in_progress", conclusion: null, url: "https://example.com/ci" } },
    });
    const after = baseState();
    const events = diffPrState(before, after, TGT, URL);
    const ci = events.find((e) => e.type === "pr_ci");
    expect(ci).toBeDefined();
    expect(ci!.summary).toContain("ci");

    // Same state again - no new event.
    expect(diffPrState(after, baseState(), TGT, URL)).toEqual([]);
  });

  test("a check run that appears already-completed emits pr_ci", () => {
    const before = baseState({ checkRuns: {} });
    const events = diffPrState(before, baseState(), TGT, URL);
    expect(events.map((e) => e.type)).toContain("pr_ci");
  });

  test("comment floods cap at 10 events", () => {
    const before = baseState();
    const fresh = Array.from({ length: 25 }, (_, i) => ({
      id: 101 + i,
      author: `user${i}`,
      url: `https://github.com/acme/widgets/pull/7#issuecomment-${101 + i}`,
      isReply: false,
    }));
    const after = baseState({
      lastIssueCommentId: 125,
      issueComments: [...before.issueComments, ...fresh],
    });
    expect(diffPrState(before, after, TGT, URL)).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// fetchPrState
// ---------------------------------------------------------------------------

describe("fetchPrState", () => {
  test("calls the PR endpoints plus graphql and parses the results", async () => {
    const called: string[] = [];
    const gh: GhRunner = async (apiArgs) => {
      called.push(apiArgs.join(" "));
      return mockGh([
        [RE_CHECK_RUNS, {
          check_runs: [{ id: 1, name: "lint", status: "completed", conclusion: "failure", html_url: "https://ci/1" }],
        }],
        ...quietRoutes(),
      ])(apiArgs);
    };
    const state = await fetchPrState(gh, "acme/widgets", 7);
    expect(called.some((p) => RE_PULL.test(p))).toBe(true);
    expect(called.some((p) => RE_ISSUE_COMMENTS.test(p))).toBe(true);
    expect(called.some((p) => RE_CHECK_RUNS.test(p))).toBe(true);
    expect(state.headSha).toBe("aaaa1111");
    expect(state.checkRuns["1"]).toEqual({ name: "lint", status: "completed", conclusion: "failure", url: "https://ci/1" });
    const again = await fetchPrState(gh, "acme/widgets", 7);
    expect(again.bodySha).toBe(state.bodySha);
  });

  test("parses resolved review threads from the graphql response", async () => {
    const gh = mockGh([
      [RE_GRAPHQL, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { id: "PRRT_aaa", isResolved: true },
                  { id: "PRRT_bbb", isResolved: false },
                ],
              },
            },
          },
        },
      }],
      ...quietRoutes(),
    ]);
    const state = await fetchPrState(gh, "acme/widgets", 7);
    expect(state.resolvedThreads).toEqual(["PRRT_aaa"]);
  });

  test("comment refs capture author and reply flag", async () => {
    const gh = mockGh([
      [RE_REVIEW_COMMENTS, [
        { id: 300, user: { login: "dave" }, html_url: "https://x/300" },
        { id: 301, user: { login: "erin" }, html_url: "https://x/301", in_reply_to_id: 300 },
      ]],
      ...quietRoutes(),
    ]);
    const state = await fetchPrState(gh, "acme/widgets", 7);
    expect(state.reviewComments).toHaveLength(2);
    expect(state.reviewComments[1].isReply).toBe(true);
    expect(state.lastReviewCommentId).toBe(301);
  });
});

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
    // The production retry path logs each failed delivery; silence it so the
    // expected failure does not leak into the test output.
    const errorLog = console.error;
    console.error = () => {};
    const reg = new WatcherRegistry({
      deliver: async (sessionID, events) => {
        if (fail) throw new Error("busy");
        delivered.push({ sessionID, events });
      },
      canDeliver: () => true,
      ghRunner: quietGh(),
      pollIntervalMs: 60_000,
    });
    try {
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
    } finally {
      console.error = errorLog;
    }
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

describe("watcher event types", () => {
  test("covers the documented vocabulary", () => {
    const expected: WatcherEventType[] = [...PR_EVENT_TYPES, ...BRANCH_EVENT_TYPES, ...COMMAND_EVENT_TYPES, "watch_expired"];
    expect(WATCHER_EVENT_TYPES).toEqual(expected);
    expect(expected).toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
// Branch source (github-ci on main, etc.)
// ---------------------------------------------------------------------------

function branchState(overrides: Partial<BranchState> = {}): BranchState {
  return {
    headSha: "aaaa1111",
    checkRuns: {},
    workflowRuns: {},
    ...overrides,
  };
}

describe("fetchBranchState", () => {
  test("fetches branch head, workflow runs, and check runs on the head", async () => {
    const called: string[] = [];
    const gh: GhRunner = async (apiArgs) => {
      called.push(apiArgs.join(" "));
      return mockGh([
        [RE_CHECK_RUNS, { check_runs: [{ id: 9, name: "test", status: "completed", conclusion: "success", html_url: "https://ci/9" }] }],
        ...quietRoutes(),
        [RE_GRAPHQL, {}],
        [/\/actions\/runs\?/, {
          workflow_runs: [
            { id: 55, name: "Publish", status: "in_progress", conclusion: null, html_url: "https://x/55", event: "push", head_branch: "main", head_sha: "beef00d5" },
            // A tag-triggered run on the same head: head_branch is the tag,
            // included because head_sha matches the branch head.
            { id: 56, name: "Publish", status: "completed", conclusion: "success", html_url: "https://x/56", event: "push", head_branch: "v0.1.37", head_sha: "beef00d5" },
            // A run from another branch: excluded.
            { id: 57, name: "CI", status: "completed", conclusion: "success", html_url: "https://x/57", event: "push", head_branch: "feature-x", head_sha: "dead2222" },
          ],
        }],
        [/\/branches\/main$/, { commit: { sha: "beef00d5" } }],
      ])(apiArgs);
    };
    const state = await fetchBranchState(gh, "acme/widgets", "main");
    expect(called.some((p) => /\/branches\/main$/.test(p))).toBe(true);
    expect(called.some((p) => /\/actions\/runs\?/.test(p))).toBe(true);
    expect(called.some((p) => /\/commits\/beef00d5\/check-runs/.test(p))).toBe(true);
    expect(state.headSha).toBe("beef00d5");
    expect(state.checkRuns["9"]!.name).toBe("test");
    expect(state.workflowRuns["55"]!.name).toBe("Publish");
    expect(state.workflowRuns["55"]!.event).toBe("push");
    // The tag-triggered run on the branch head is kept; the foreign-branch
    // run is dropped.
    expect(Object.keys(state.workflowRuns).sort()).toEqual(["55", "56"]);
  });
});

describe("diffBranchState", () => {
  test("no changes produces no events", () => {
    expect(diffBranchState(branchState(), branchState(), TGT, "acme/widgets")).toEqual([]);
  });

  test("head movement emits branch_commit with the commit URL", () => {
    const events = diffBranchState(branchState(), branchState({ headSha: "ffff8888" }), TGT, "acme/widgets");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("branch_commit");
    expect(events[0].target).toBe(TGT);
    expect(events[0].url).toContain("/commit/ffff8888");
  });

  test("check runs reaching completion emit branch_ci", () => {
    const before = branchState({ checkRuns: { "1": { name: "ci", status: "in_progress", conclusion: null, url: null } } });
    const events = diffBranchState(before, branchState({ checkRuns: { "1": { name: "ci", status: "completed", conclusion: "failure", url: "https://ci/1" } } }), TGT, "acme/widgets");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("branch_ci");
    expect(events[0].summary).toContain("failure");
  });

  test("workflow runs emit on appearance and status transitions, with trigger event", () => {
    const before = branchState({
      workflowRuns: { "55": { name: "Publish", status: "in_progress", conclusion: null, url: "https://x/55", event: "push", headBranch: "main", headSha: "aaaa1111" } },
    });
    const after = branchState({
      workflowRuns: {
        "55": { name: "Publish", status: "completed", conclusion: "success", url: "https://x/55", event: "push", headBranch: "main", headSha: "aaaa1111" },
        "56": { name: "CI", status: "in_progress", conclusion: null, url: "https://x/56", event: "pull_request", headBranch: "main", headSha: "aaaa1111" },
      },
    });
    const events = diffBranchState(before, after, TGT, "acme/widgets");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.summary)).toEqual([
      'workflow "Publish" completed (success) [push]',
      'workflow "CI" started (in_progress) [pull_request]',
    ]);
    // No repeats when nothing changes.
    expect(diffBranchState(after, after, TGT, "acme/widgets")).toEqual([]);
  });
});

describe("describeBaselineCheckRuns", () => {
  // The dead-watcher trap: a CI watcher registered AFTER a fast pipeline
  // already finished holds completed runs in its baseline, and the diff
  // (running -> completed only) can never fire for that head. The
  // registration response must say so, with the conclusions, so the
  // caller reads the result instead of waiting on a notification that
  // cannot come.
  test("all runs already completed: names the count, breaks down conclusions, says it will not notify", () => {
    const note = describeBaselineCheckRuns({
      "1": { name: "test", status: "completed", conclusion: "success", url: null },
      "2": { name: "lint", status: "completed", conclusion: "success", url: null },
      "3": { name: "e2e", status: "completed", conclusion: "failure", url: null },
    }, "4d5ed14abcdef");
    expect(note).toContain("all 3 check runs on 4d5ed14");
    expect(note).toContain("2 success");
    expect(note).toContain("1 failure");
    expect(note).toContain("will NOT notify");
    expect(note).toContain("BEFORE pushing");
  });

  test("some runs still in progress: nothing to warn about (they will transition)", () => {
    expect(describeBaselineCheckRuns({
      "1": { name: "test", status: "completed", conclusion: "success", url: null },
      "2": { name: "e2e", status: "in_progress", conclusion: null, url: null },
    }, "4d5ed14")).toBeNull();
  });

  test("no runs yet: nothing to warn about", () => {
    expect(describeBaselineCheckRuns({}, "4d5ed14")).toBeNull();
  });

  test("a single completed run uses singular grammar and the no-conclusion fallback", () => {
    const note = describeBaselineCheckRuns({
      "1": { name: "test", status: "completed", conclusion: null, url: null },
    }, "4d5ed14");
    expect(note).toContain("all 1 check run on 4d5ed14 has already completed (1 no conclusion)");
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

test("branch diffs cap at 10 events like PR diffs", () => {
  const before = branchState();
  const after = branchState({
    workflowRuns: Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [
        String(100 + i),
        { name: "CI", status: "completed", conclusion: "success", url: `https://x/${100 + i}`, event: "push", headBranch: "main", headSha: "aaaa1111" },
      ]),
    ),
  });
  expect(diffBranchState(before, after, TGT, "acme/widgets")).toHaveLength(10);
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

test("commandTargetLabel collapses whitespace and clips long commands", () => {
  expect(commandTargetLabel("test -f /tmp/marker")).toBe("test -f /tmp/marker");
  expect(commandTargetLabel("gh   run   list")).toBe("gh run list");
  const long = "a".repeat(80);
  const clipped = commandTargetLabel(long);
  expect(clipped.length).toBeLessThanOrEqual(60);
  expect(clipped.endsWith("...")).toBe(true);
});

// ---------------------------------------------------------------------------
// runWatchedCommand (real processes - the injected-runner tests cannot see
// spawn failures, timeouts, or pipe-holding grandchildren)
// ---------------------------------------------------------------------------

describe("drainStreamOutput", () => {
  // A read that REJECTS is not EOF: the pipe may still be delivering, so
  // the loop backs off and keeps reading instead of ending the drain early
  // (the one-off flake under parallel-suite load). Only the abandonment's
  // cancel settles the loop on an error.
  const flakyReader = (failFirst: number, chunks: string[]) => {
    let reads = 0;
    let emitted = 0;
    return {
      read: async () => {
        reads++;
        if (reads <= failFirst) throw new Error("transient pipe error");
        if (emitted < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[emitted++]) };
        return { done: true, value: undefined };
      },
    } as unknown as ReadableStreamDefaultReader;
  };

  test("a rejected read backs off and keeps reading (error is not EOF)", async () => {
    const text = await drainStreamOutput(flakyReader(2, ["hel", "lo"]), () => false);
    expect(text).toBe("hello");
  });

  test("a cancelled reader settles immediately with what was read", async () => {
    const text = await drainStreamOutput(flakyReader(1, ["never"]), () => true);
    expect(text).toBe("");
  });
});

describe("runWatchedCommand", () => {
  test("reports a clean exit with duration", async () => {
    const result = await runWatchedCommand("exit 0", "/tmp", 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("reports a failing exit and drains stderr", async () => {
    const result = await runWatchedCommand("echo boom-not-found 1>&2; exit 3", "/tmp", 30_000);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("boom-not-found");
  });

  test("kills a hanging command at the timeout and reports timedOut", async () => {
    // The production runner logs each timeout kill; silence it so the
    // expected kill does not leak into the test output.
    const errorLog = console.error;
    console.error = () => {};
    try {
      const result = await runWatchedCommand("sleep 20", "/tmp", 500);
      expect(result.timedOut).toBe(true);
      // 137 = SIGKILL from the watchdog. Consumers only read the timedOut
      // flag; the raw code is informational.
      expect(result.exitCode).toBe(137);
      expect(result.durationMs).toBeLessThan(10_000);
    } finally {
      console.error = errorLog;
    }
  });

  test("survives a grandchild holding the pipe open past the kill", async () => {
    // The command backgrounds a long-lived child that inherits stdout's
    // write end and never exits. bash dies at the timeout; the grandchild
    // keeps the pipe open. Without the drain race this call would hang
    // forever - which is exactly the shared-poll-cycle stall the race exists
    // to prevent.
    const started = Date.now();
    const result = await runWatchedCommand('sleep 20 & echo started; wait', "/tmp", 500);
    expect(result.timedOut).toBe(true);
    // The abandoned-drain return shape: 124 sentinel, nothing captured.
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toBe("");
    // deadline = timeout + grace; allow generous CI slack on top.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  test("refuses a nonexistent working directory with a real error", async () => {
    let threw: unknown = null;
    try {
      await runWatchedCommand("true", "/definitely/not/a/real/dir", 30_000);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("project directory");
  });
});

// ---------------------------------------------------------------------------
// Poll-cycle resilience: a throwing gate or a hung gh call must not kill the
// poller (the same failure class as a hung watched command)
// ---------------------------------------------------------------------------

describe("poll resilience", () => {
  test("a throwing canDeliver gate fails closed and leaves the mail pending", async () => {
    const delivered: Array<{ sessionID: string; events: WatcherEvent[] }> = [];
    // The fail-closed path logs the gate error; silence it for clean output.
    const errorLog = console.error;
    console.error = () => {};
    const reg = new WatcherRegistry({
      deliver: async (sessionID, events) => {
        delivered.push({ sessionID, events });
      },
      canDeliver: () => {
        throw new Error("server unreachable");
      },
      ghRunner: quietGh(),
      pollIntervalMs: 60_000,
    });
    try {
      await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
      const w = reg.listForSession("s1")[0];
      if (w.source !== "pr") throw new Error("expected a pr watcher");
      w.state.headSha = "old";
      // Must not throw out of poll - a throw here would be an unhandled
      // rejection in the host process and would wedge the #polling guard.
      await reg.poll();
      expect(reg.pendingCount("s1")).toBe(1);
      expect(delivered).toHaveLength(0);
    } finally {
      console.error = errorLog;
    }
    reg.dispose();
  });

  test("ghApiRun races its drain: a fake gh whose child holds the pipe still resolves", async () => {
    // A fake `gh` that backgrounds a pipe-holding sleeper and exits 1. The
    // orphaned sleeper inherits the output pipe's write end, so stdout never
    // EOFs and ghApiRun's drain loses the race - it must reject cleanly
    // instead of hanging until the sleeper exits.
    //
    // Bun resolves spawned binaries from the PATH the PROCESS was started
    // with, so mutating process.env.PATH in-process does not select the fake.
    // Run a child bun with the fake gh on its PATH from birth; the child
    // calls the parameterized transport with a small timeout and prints the
    // outcome.
    const binDir = mkdtempSync(join(tmpdir(), "thatch-fake-gh-"));
    writeFileSync(join(binDir, "gh"), "#!/bin/sh\nsleep 30 &\nexit 1\n", { mode: 0o755 });
    const childScript = `
      const { ghApiRunWithTimeout } = await import(${JSON.stringify(join(process.cwd(), "src/watchers.ts"))});
      const t0 = Date.now();
      try { await ghApiRunWithTimeout(["/x"], 500); console.log("UNEXPECTED-SUCCESS"); }
      catch (e) { console.log(JSON.stringify({ ms: Date.now() - t0, msg: e.message })); }
    `;
    try {
      const proc = Bun.spawn(["bun", "-e", childScript], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const line = out.split("\n").find((l) => l.startsWith("{"));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line!);
      // The load-bearing contract: the call rejects PROMPTLY instead of
      // hanging until the sleeper exits 30s later. Which error lands is
      // Bun's coin flip - the drain may see EOF right after the kill
      // (Bun closes the pipe: "failed (exit 137)") or the abandonment
      // deadline may win (the orphaned-child timeout message) - both
      // reject cleanly and neither is a hang.
      expect(parsed.ms).toBeLessThan(15_000);
      expect(parsed.msg).toMatch(/timed out|failed \(exit/);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 40_000);
});

// ---------------------------------------------------------------------------
// watcherNotificationNudge
// ---------------------------------------------------------------------------

describe("watcherNotificationNudge", () => {
  const events = [
    { type: "pr_ci", summary: 'check "CI" completed (success)', url: "https://example.com/ci" },
    { type: "pr_comment", summary: "comment by alice", url: "https://example.com/c" },
  ];

  test("renders event summaries and the greenlit-work continuation exception", () => {
    const text = watcherNotificationNudge("acme/widgets#7", events);
    expect(text).toContain('- pr_ci: check "CI" completed (success) https://example.com/ci');
    expect(text).toContain("- pr_comment: comment by alice https://example.com/c");
    expect(text).toContain("not approval to advance other pending work");
    expect(text).toContain("gate work the user already greenlit");
    expect(text).toContain("conclusions are in the summaries above");
  });

  test("cadence line appears only when pollSeconds is passed", () => {
    expect(watcherNotificationNudge("acme/widgets#7", events, 60)).toContain("polled every ~60s");
    expect(watcherNotificationNudge("acme/widgets#7", events)).not.toContain("polled every");
  });

  test("command events render without a dangling URL and with the command detail hint", () => {
    const text = watcherNotificationNudge("test -f /tmp/marker", [
      { type: "command_success", summary: "command exited 0 (took 1.2s)", url: "" },
    ]);
    expect(text).toContain("- command_success: command exited 0 (took 1.2s)");
    expect(text).not.toMatch(/1\.2s\s+$/m);
    expect(text).toContain("re-run it or read logs yourself");
    expect(text).not.toContain("conclusions are in the summaries above");
  });

  test("watcherDeathNotice carries the dead session's identity when known", () => {
    const text = watcherDeathNotice(["acme/widgets#7"], { name: "rosie-unit-one-00007", sessionID: "ses_ee7ec0" });
    expect(text).toContain("acme/widgets#7");
    expect(text).toContain("Dead session: rosie-unit-one-00007 (ses_ee7ec0)");
    expect(text).toContain("re-arm automatically");
    // Without the owner the notice stays as it was.
    expect(watcherDeathNotice(["acme/widgets#7"])).not.toContain("Dead session");
  });

  test("watcherDeathNotice says cancelled for the sessionDied path (no automatic re-arm)", () => {
    // The confirmed-death path DELETES the watchers - the notice must not
    // promise a resume re-arm that will never happen.
    const text = watcherDeathNotice(["acme/widgets#7"], { name: "rosie-unit-one-00007", sessionID: "ses_ee7ec0" }, { rearmsOnResume: false });
    expect(text).toContain("was cancelled when the session died");
    expect(text).toContain("watch_create");
    expect(text).not.toContain("re-arm automatically");
    const plural = watcherDeathNotice(["acme/widgets#7", "acme/widgets#8"], undefined, { rearmsOnResume: false });
    expect(plural).toContain("were cancelled when the session died");
    expect(plural).toContain("re-create them");
  });

  test("an all-expiry delivery uses the expiry framing and drops the gating carve-out", () => {    const text = watcherNotificationNudge("acme/widgets#7", [
      { type: "watch_expired", summary: "watch on acme/widgets#7 expired after 480 min - no further notifications will arrive from it", url: URL },
    ]);
    expect(text).toContain("- watch_expired: watch on acme/widgets#7 expired after 480 min");
    expect(text).toContain("not a completion signal");
    expect(text).toContain("Re-register the watch");
    // The continuation carve-out must never appear on an expiry notice: the
    // watched condition did not occur, so this is never a signal to proceed.
    expect(text).not.toContain("continuation signal");
  });
});

// ---------------------------------------------------------------------------
// withCwdFallback: per-poll cwd resolution for the watcher runner
// ---------------------------------------------------------------------------

describe("withCwdFallback", () => {
  const base = async (command: string, cwd: string): Promise<CommandRunResult> => ({
    exitCode: 0,
    timedOut: false,
    stderr: `ran-in:${cwd}:${command}`,
    durationMs: 10,
  });

  test("a live directory resolves to itself - the base runner gets the original cwd", async () => {
    const seen: string[] = [];
    const runner = withCwdFallback(
      async (command, cwd) => {
        seen.push(cwd);
        return base(command, cwd);
      },
      async (cwd) => cwd,
    );
    await runner("check", "/live/dir", 1000);
    expect(seen).toEqual(["/live/dir"]);
  });

  test("a dead directory falls back to the resolver's path", async () => {
    const fallbacks: [string, string][] = [];
    const runner = withCwdFallback(
      async (command, cwd) => base(command, cwd),
      async (cwd) => (cwd === "/dead/wt" ? "/main/checkout" : cwd),
      (from, to) => fallbacks.push([from, to]),
    );
    const result = await runner("check", "/dead/wt", 1000);
    expect(result.stderr).toBe("ran-in:/main/checkout:check");
    expect(fallbacks).toEqual([["/dead/wt", "/main/checkout"]]);
  });

  test("the fallback logs once per dead directory, not per poll", async () => {
    const fallbacks: [string, string][] = [];
    const runner = withCwdFallback(
      async (command, cwd) => base(command, cwd),
      async (cwd) => (cwd === "/dead/wt" ? "/main/checkout" : cwd),
      (from, to) => fallbacks.push([from, to]),
    );
    for (let i = 0; i < 5; i++) await runner("check", "/dead/wt", 1000);
    expect(fallbacks).toHaveLength(1);
  });

  test("a null resolution keeps the original cwd, which then fails as before", async () => {
    const seen: string[] = [];
    const runner = withCwdFallback(
      async (command, cwd) => {
        seen.push(cwd);
        return base(command, cwd);
      },
      async () => null,
      () => {
        throw new Error("must not report a fallback that did not happen");
      },
    );
    await runner("check", "/dead/wt", 1000);
    expect(seen).toEqual(["/dead/wt"]);
  });
});
