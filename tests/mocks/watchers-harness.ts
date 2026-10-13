// Shared fixtures for the watcher test files: gh route mocks and the
// PR/branch state factories the diff and registry tests build on.
import type { BranchState, GhRunner, PrState } from "../../src/watchers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const TGT = "acme/widgets#7";
export const URL = "https://github.com/acme/widgets/pull/7";

export function baseState(overrides: Partial<PrState> = {}): PrState {
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
export function mockGh(routes: Array<[RegExp, unknown]>): GhRunner {
  return async (apiArgs: string[]) => {
    const joined = apiArgs.join(" ");
    for (const [pattern, response] of routes) {
      if (!pattern.test(joined)) continue;
      return typeof response === "function" ? (response as (p: string) => unknown)(joined) : response;
    }
    throw new Error(`mockGh: no route for ${joined}`);
  };
}

export function prResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    head: { sha: "aaaa1111" },
    state: "open",
    merged: false,
    title: "Add widget",
    body: "description",
    ...overrides,
  };
}

export const RE_PULL = /\/pulls\/\d+$/;
export const RE_ISSUE_COMMENTS = /\/issues\/\d+\/comments/;
export const RE_REVIEW_COMMENTS = /\/pulls\/\d+\/comments/;
export const RE_CHECK_RUNS = /\/check-runs/;
export const RE_GRAPHQL = /^graphql/;

export const quietRoutes = (): Array<[RegExp, unknown]> => [
  [RE_ISSUE_COMMENTS, []],
  [RE_REVIEW_COMMENTS, []],
  [RE_CHECK_RUNS, { check_runs: [] }],
  [RE_GRAPHQL, { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }],
  [RE_PULL, prResponse()],
];

export function quietGh(): GhRunner {
  return mockGh(quietRoutes());
}

// ---------------------------------------------------------------------------
// Branch source (github-ci on main, etc.)
// ---------------------------------------------------------------------------

export function branchState(overrides: Partial<BranchState> = {}): BranchState {
  return {
    headSha: "aaaa1111",
    checkRuns: {},
    workflowRuns: {},
    ...overrides,
  };
}
