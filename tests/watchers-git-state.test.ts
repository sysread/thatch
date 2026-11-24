import { describe, test, expect } from "bun:test";
import {
  diffPrState,
  fetchPrState,
  fetchBranchState,
  diffBranchState,
  describeBaselineCheckRuns,
  COMMAND_EVENT_TYPES,
  PR_EVENT_TYPES,
  BRANCH_EVENT_TYPES,
  WATCHER_EVENT_TYPES,
  type GhRunner,
  type WatcherEventType,
  type PrState,
} from "../src/watchers";
import {
  TGT,
  URL,
  baseState,
  branchState,
  mockGh,
  quietRoutes,
  RE_PULL,
  RE_ISSUE_COMMENTS,
  RE_REVIEW_COMMENTS,
  RE_REVIEWS,
  RE_CHECK_RUNS,
  RE_GRAPHQL,
} from "./mocks/watchers-harness";

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
    // Exact set: a body-only change must not co-fire pr_status or others.
    expect(events.map((e) => e.type)).toEqual(["pr_description"]);
  });

  test("title change emits pr_description", () => {
    const events = diffPrState(baseState(), baseState({ title: "Rename widget" }), TGT, URL);
    expect(events.map((e) => e.type)).toEqual(["pr_description"]);
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

  test("a bare review submission emits pr_review_submitted with author and state, once", () => {
    const before = baseState();
    const after = baseState({
      lastReviewId: 301,
      reviews: [{ id: 301, author: "dave", state: "APPROVED", url: "https://github.com/acme/widgets/pull/7#pullrequestreview-301" }],
    });
    const events = diffPrState(before, after, TGT, URL);
    const review = events.find((e) => e.type === "pr_review_submitted");
    expect(review).toBeDefined();
    expect(review!.summary).toContain("dave");
    expect(review!.summary).toContain("APPROVED");
    expect(review!.url).toContain("pullrequestreview-301");

    // Re-polling the same snapshot must not re-fire.
    expect(diffPrState(after, after, TGT, URL)).toEqual([]);
  });

  test("CHANGES_REQUESTED submissions emit pr_review_submitted too", () => {
    const before = baseState();
    const after = baseState({
      lastReviewId: 302,
      reviews: [{ id: 302, author: "erin", state: "CHANGES_REQUESTED", url: "" }],
    });
    const events = diffPrState(before, after, TGT, URL);
    const review = events.find((e) => e.type === "pr_review_submitted");
    expect(review).toBeDefined();
    expect(review!.summary).toContain("CHANGES_REQUESTED");
    expect(review!.url).toBe(URL);
  });

  test("a legacy snapshot without review fields fires no spurious review events", () => {
    // Definitions journaled before the reviews field existed hydrate their
    // state verbatim without it. The first post-upgrade diff must not fire
    // every pre-existing review back at the session.
    const legacy = { ...baseState() } as Record<string, unknown>;
    delete legacy.reviews;
    delete legacy.lastReviewId;
    const after = baseState({
      lastReviewId: 301,
      reviews: [{ id: 301, author: "dave", state: "APPROVED", url: "https://x/301" }],
    });
    const events = diffPrState(legacy as unknown as PrState, after, TGT, URL);
    expect(events.filter((e) => e.type === "pr_review_submitted")).toEqual([]);
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
    expect(called.some((p) => RE_REVIEWS.test(p))).toBe(true);
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
  test("review refs capture author, state, and the last review id", async () => {
    const gh = mockGh([
      [RE_REVIEWS, [
        { id: 400, user: { login: "frank" }, state: "CHANGES_REQUESTED", html_url: "https://x/r400" },
        { id: 401, user: { login: "gina" }, state: "APPROVED", html_url: "https://x/r401" },
      ]],
      ...quietRoutes(),
    ]);
    const state = await fetchPrState(gh, "acme/widgets", 7);
    expect(state.reviews).toEqual([
      { id: 400, author: "frank", state: "CHANGES_REQUESTED", url: "https://x/r400" },
      { id: 401, author: "gina", state: "APPROVED", url: "https://x/r401" },
    ]);
    expect(state.lastReviewId).toBe(401);
  });
});

describe("watcher event types", () => {
  test("covers the documented vocabulary", () => {
    const expected: WatcherEventType[] = [...PR_EVENT_TYPES, ...BRANCH_EVENT_TYPES, ...COMMAND_EVENT_TYPES, "watch_expired"];
    expect(WATCHER_EVENT_TYPES).toEqual(expected);
    expect(expected).toHaveLength(14);
  });
});

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
