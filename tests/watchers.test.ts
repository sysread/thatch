import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  WatcherRegistry,
  diffPrState,
  fetchPrState,
  WATCHER_EVENT_TYPES,
  type GhRunner,
  type PrState,
  type WatcherEvent,
  type WatcherEventType,
} from "../src/watchers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    expect(diffPrState(baseState(), baseState(), URL)).toEqual([]);
  });

  test("head SHA change emits pr_commit", () => {
    const after = baseState({ headSha: "ffff0000ffff0000ffff0000ffff0000ffff0000" });
    const events = diffPrState(baseState(), after, URL);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("pr_commit");
    expect(events[0].summary).toContain("ffff000");
    expect(events[0].url).toBe(URL);
  });

  test("state change emits pr_status, merged wins in the summary", () => {
    const events = diffPrState(baseState(), baseState({ state: "closed" }), URL);
    expect(events[0].type).toBe("pr_status");
    expect(events[0].summary).toContain("closed");

    const merged = diffPrState(baseState(), baseState({ merged: true }), URL);
    expect(merged[0].summary).toContain("merged");
  });

  test("body hash change emits pr_description", () => {
    const events = diffPrState(baseState(), baseState({ bodySha: "body-hash-2" }), URL);
    expect(events.map((e) => e.type)).toContain("pr_description");
  });

  test("title change emits pr_description", () => {
    const events = diffPrState(baseState(), baseState({ title: "Rename widget" }), URL);
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
    const events = diffPrState(before, after, URL);
    const types = events.map((e) => e.type);
    expect(types).toContain("pr_comment");
    expect(types).toContain("pr_review_reply");
    const comment = events.find((e) => e.type === "pr_comment")!;
    expect(comment.summary).toContain("bob");
  });

  test("thread resolution transitions emit pr_review_resolved with direction in the summary", () => {
    const resolved = baseState({ resolvedThreads: ["PRRT_1"] });
    const events = diffPrState(baseState(), resolved, URL);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("pr_review_resolved");
    expect(events[0].summary).toContain("resolved");

    // Resolving again is not an event.
    expect(diffPrState(resolved, baseState({ resolvedThreads: ["PRRT_1"] }), URL)).toEqual([]);

    // Reopening emits the reopened direction.
    const reopen = diffPrState(resolved, baseState(), URL);
    expect(reopen).toHaveLength(1);
    expect(reopen[0].summary).toContain("reopened");
  });

  test("check run reaching completion emits pr_ci; already-completed runs do not", () => {
    const before = baseState({
      checkRuns: { "1": { name: "ci", status: "in_progress", conclusion: null, url: "https://example.com/ci" } },
    });
    const after = baseState();
    const events = diffPrState(before, after, URL);
    const ci = events.find((e) => e.type === "pr_ci");
    expect(ci).toBeDefined();
    expect(ci!.summary).toContain("ci");

    // Same state again - no new event.
    expect(diffPrState(after, baseState(), URL)).toEqual([]);
  });

  test("a check run that appears already-completed emits pr_ci", () => {
    const before = baseState({ checkRuns: {} });
    const events = diffPrState(before, baseState(), URL);
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
    expect(diffPrState(before, after, URL)).toHaveLength(10);
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
    const result = await reg.create("s1", "acme/widgets", 7, ["pr_comment"]);
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
    const result = await reg.create("s1", "acme/widgets", 7, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("gh: not authenticated");
  });

  test("create enforces the per-session watcher limit", async () => {
    const reg = makeRegistry({ maxPerSession: 2 });
    expect((await reg.create("s1", "acme/widgets", 7, [])).ok).toBe(true);
    expect((await reg.create("s1", "acme/widgets", 8, [])).ok).toBe(true);
    const third = await reg.create("s1", "acme/widgets", 9, []);
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error).toContain("limit");
    // A different session is not affected by s1's limit.
    expect((await reg.create("s2", "acme/widgets", 9, [])).ok).toBe(true);
  });

  test("cancel is session-scoped", async () => {
    const reg = makeRegistry();
    const result = await reg.create("s1", "acme/widgets", 7, []);
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
    await reg.create("s1", "acme/widgets", 7, ["pr_commit", "pr_status"]);
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

  test("events for unwatched types are filtered out", async () => {
    const reg = new WatcherRegistry({
      deliver: async (s, e) => {
        delivered.push({ sessionID: s, events: e });
      },
      canDeliver: () => true,
      ghRunner: quietGh(),
      pollIntervalMs: 60_000,
    });
    await reg.create("s1", "acme/widgets", 7, ["pr_ci"]);
    // Force a state change that produces only a pr_commit event.
    reg.listForSession("s1")[0].state.headSha = "old";
    await reg.poll();
    expect(delivered).toHaveLength(0);
    expect(reg.pendingCount("s1")).toBe(0);
  });

  test("delivery waits for canDeliver and succeeds later", async () => {
    canDeliver = false;
    const reg = makeRegistry();
    await reg.create("s1", "acme/widgets", 7, ["pr_commit"]);
    reg.listForSession("s1")[0].state.headSha = "old";
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
    const reg = new WatcherRegistry({
      deliver: async (sessionID, events) => {
        if (fail) throw new Error("busy");
        delivered.push({ sessionID, events });
      },
      canDeliver: () => true,
      ghRunner: quietGh(),
      pollIntervalMs: 60_000,
    });
    await reg.create("s1", "acme/widgets", 7, ["pr_commit"]);
    reg.listForSession("s1")[0].state.headSha = "old";
    await reg.poll();
    expect(reg.pendingCount("s1")).toBe(1);

    fail = false;
    await reg.deliverPending();
    expect(delivered).toHaveLength(1);
    expect(reg.pendingCount("s1")).toBe(0);
  });

  test("expired watchers are dropped silently", async () => {
    const reg = makeRegistry({ ttlMinutes: -1 });
    await reg.create("s1", "acme/widgets", 7, []);
    expect(reg.listForSession("s1")).toHaveLength(1);
    await reg.poll();
    expect(reg.listForSession("s1")).toHaveLength(0);
  });

  test("cancelSession drops watchers and pending events", async () => {
    canDeliver = false;
    const reg = makeRegistry();
    await reg.create("s1", "acme/widgets", 7, ["pr_commit"]);
    reg.listForSession("s1")[0].state.headSha = "old";
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
    await reg.create("s1", "acme/widgets", 7, ["pr_commit"]);
    await reg.create("s1", "acme/widgets", 8, ["pr_commit"]);
    reg.listForSession("s1").forEach((w) => {
      w.state.headSha = w.pr === 7 ? "aaaa1111" : "old";
    });
    await reg.poll();
    // Watcher 7 failed (no state change anyway), watcher 8 delivered.
    expect(delivered).toHaveLength(1);
    expect(delivered[0].events[0].type).toBe("pr_commit");
  });
});

describe("watcher event types", () => {
  test("covers the documented vocabulary", () => {
    const expected: WatcherEventType[] = [
      "pr_comment",
      "pr_review_comment",
      "pr_review_reply",
      "pr_review_resolved",
      "pr_commit",
      "pr_status",
      "pr_description",
      "pr_ci",
    ];
    expect(WATCHER_EVENT_TYPES).toEqual(expected);
    expect(expected).toHaveLength(8);
  });
});
