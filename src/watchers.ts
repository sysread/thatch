/**
 * Watchers: event-driven notifications from external sources, delivered into
 * a live opencode session as injected prompts.
 *
 * The registry supports multiple source types behind one mechanism. The
 * first source was GitHub pull requests (source "pr"); GitHub branches
 * (source "branch") arrived second, for watching CI and workflow runs
 * against main. A source contributes: event types, a fetch function that
 * produces a snapshot of the watched state, and a pure diff between two
 * snapshots. Everything else - registry, pending queue, delivery gating -
 * is source-agnostic.
 *
 * Lifetime is deliberately process-scoped. The registry lives in plugin
 * memory, never in SQLite: opencode loads thatch in-process, so the plugin
 * process is the natural owner of its watchers. This makes multi-instance
 * ownership structurally impossible (each process polls only what it
 * registered), leaves no orphan data behind, and matches the extraction
 * pipeline's opencode path, which is also in-memory. A crashed or restarted
 * opencode loses its watchers - acceptable, because the session that created
 * them lost its conversational context too, and a delivered notification
 * into a session that no longer knows why it is being watched is worse than
 * a lost watch.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Event types for source "pr". */
export type PrWatcherEventType =
  | "pr_comment"
  | "pr_review_comment"
  | "pr_review_reply"
  | "pr_review_resolved"
  | "pr_commit"
  | "pr_status"
  | "pr_description"
  | "pr_ci";

/** Event types for source "branch" (typically main): commits land, CI and workflow runs execute. */
export type BranchWatcherEventType = "branch_commit" | "branch_ci" | "branch_workflow";

export type WatcherEventType = PrWatcherEventType | BranchWatcherEventType;

export const PR_EVENT_TYPES: PrWatcherEventType[] = [
  "pr_comment",
  "pr_review_comment",
  "pr_review_reply",
  "pr_review_resolved",
  "pr_commit",
  "pr_status",
  "pr_description",
  "pr_ci",
];

export const BRANCH_EVENT_TYPES: BranchWatcherEventType[] = [
  "branch_commit",
  "branch_ci",
  "branch_workflow",
];

/** Every event type across all sources - for diagnostics and tests. */
export const WATCHER_EVENT_TYPES: WatcherEventType[] = [...PR_EVENT_TYPES, ...BRANCH_EVENT_TYPES];

/**
 * A single detected change, ready for delivery. Pointer data plus machine
 * status (check names, conclusions, counts) - never external content.
 */
export interface WatcherEvent {
  type: WatcherEventType;
  /** Which watch produced this event, e.g. "acme/widgets#7" or "acme/widgets@main". */
  target: string;
  /** Short summary: who/what/where plus machine status (CI conclusions) - never body text or other external content. */
  summary: string;
  url: string;
}

/** A comment seen on the PR. Only identifying fields - never comment text. */
export interface CommentRef {
  id: number;
  author: string;
  url: string;
  /** True when the comment is a reply to another review comment. */
  isReply: boolean;
}

/** One CI check run, keyed by id in state snapshots. */
export interface CheckRunRef {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

/** One GitHub Actions workflow run, keyed by run id. */
export interface WorkflowRunRef {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  /** What triggered the run: push, pull_request, schedule, workflow_run, ... */
  event: string;
  /** The branch the run's head commit is on (a tag-triggered run puts the TAG name here). */
  headBranch: string;
  headSha: string;
}

// ---------------------------------------------------------------------------
// Watchers: a discriminated union over sources
// ---------------------------------------------------------------------------

/**
 * The last-seen state of a PR, captured at watch creation and updated each
 * poll. Comment arrays are kept whole so each diff can name individual new
 * comments; they are capped at the fetch page size (100).
 */
export interface PrState {
  headSha: string;
  state: string;
  merged: boolean;
  title: string;
  /** SHA-256 of the PR body text - detects description edits without storing the body. */
  bodySha: string;
  lastIssueCommentId: number;
  lastReviewCommentId: number;
  issueComments: CommentRef[];
  reviewComments: CommentRef[];
  /** Sorted ids of review threads currently in the resolved state. */
  resolvedThreads: string[];
  checkRuns: Record<string, CheckRunRef>;
}

/** The last-seen state of a branch. */
export interface BranchState {
  headSha: string;
  checkRuns: Record<string, CheckRunRef>;
  /** Workflow runs on the branch, keyed by run id (last 20). */
  workflowRuns: Record<string, WorkflowRunRef>;
}

export interface PrWatcher {
  id: string;
  source: "pr";
  sessionID: string;
  /** owner/repo */
  repo: string;
  pr: number;
  events: PrWatcherEventType[];
  /** Epoch ms. When now > expiresAt the watcher is silently dropped. */
  expiresAt: number;
  createdAt: number;
  state: PrState;
}

export interface BranchWatcher {
  id: string;
  source: "branch";
  sessionID: string;
  /** owner/repo */
  repo: string;
  branch: string;
  events: BranchWatcherEventType[];
  /** Substring filters on workflow run names; empty means all workflows. */
  workflows: string[];
  expiresAt: number;
  createdAt: number;
  state: BranchState;
}

export type Watcher = PrWatcher | BranchWatcher;

/** Runs one GitHub API call via the gh CLI and parses the JSON response.
 *  The array is the argument list after `gh api`: a REST path like
 *  ["/repos/o/r/pulls/7"] or a GraphQL invocation like
 *  ["graphql", "-f", "query={...}"]. Array-shaped so both transports fit
 *  without the callers string-concatenating shell quotes. */
export type GhRunner = (apiArgs: string[]) => Promise<unknown>;

export interface WatcherRegistryOptions {
  /** Delivers a batch of events for a session. Injected so tests never spawn. */
  deliver: (sessionID: string, events: WatcherEvent[]) => Promise<void>;
  /**
   * Gate for delivery. The plugin passes a predicate that returns true only
   * when the session can accept a proactive prompt right now (idle, not
   * compacting). Undeliverable events stay pending and retry on later cycles
   * or when the session next goes idle.
   */
  canDeliver: (sessionID: string) => boolean;
  ghRunner: GhRunner;
  pollIntervalMs?: number;
  ttlMinutes?: number;
  maxPerSession?: number;
}

// ---------------------------------------------------------------------------
// GitHub access via the gh CLI
// ---------------------------------------------------------------------------

/**
 * The default GhRunner. Shells out to `gh api` so auth comes from the user's
 * existing gh session - thatch never sees or stores a token. Throws on
 * non-zero exit or unparseable output.
 */
export async function ghApiRun(apiArgs: string[]): Promise<unknown> {
  const proc = Bun.spawn(["gh", "api", ...apiArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  try {
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`gh api ${apiArgs.join(" ")} failed (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`);
    }
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timeout);
  }
}

let ghAvailability: boolean | null = null;

/**
 * Checks whether the gh CLI is usable, once per process. A tool that fails
 * this check reports unavailability instead of registering a watcher that
 * can never poll.
 */
export async function ghAvailable(): Promise<boolean> {
  if (ghAvailability !== null) return ghAvailability;
  try {
    const proc = Bun.spawn(["gh", "--version"], { stdout: "ignore", stderr: "ignore" });
    const timeout = setTimeout(() => proc.kill(), 5_000);
    const code = await proc.exited;
    clearTimeout(timeout);
    ghAvailability = code === 0;
  } catch {
    ghAvailability = false;
  }
  return ghAvailability;
}

// For testing: reset the cached availability check.
export function _resetGhAvailability(): void {
  ghAvailability = null;
}

// ---------------------------------------------------------------------------
// Snapshot construction
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return Bun.SHA256.hash(text, "hex");
}

interface RawComment {
  id?: number;
  user?: { login?: string };
  html_url?: string;
  in_reply_to_id?: number;
}

function toCommentRefs(raw: unknown): CommentRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is RawComment => typeof (c as RawComment).id === "number")
    .map((c) => ({
      id: c.id!,
      author: c.user?.login ?? "unknown",
      url: c.html_url ?? "",
      isReply: typeof c.in_reply_to_id === "number",
    }));
}

function maxCommentId(refs: CommentRef[]): number {
  return refs.reduce((max, c) => Math.max(max, c.id), 0);
}

function parseCheckRuns(raw: unknown): Record<string, CheckRunRef> {
  const runs: Record<string, CheckRunRef> = {};
  const rawRuns = (raw as { check_runs?: Array<{
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string | null;
  }> }).check_runs ?? [];
  for (const run of rawRuns) {
    if (run.id === undefined) continue;
    runs[String(run.id)] = {
      name: run.name ?? "check",
      status: run.status ?? "unknown",
      conclusion: run.conclusion ?? null,
      url: run.html_url ?? null,
    };
  }
  return runs;
}

function parseWorkflowRuns(raw: unknown): Record<string, WorkflowRunRef> {
  const runs: Record<string, WorkflowRunRef> = {};
  const rawRuns = (raw as { workflow_runs?: Array<{
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    event?: string;
    head_branch?: string;
    head_sha?: string;
  }> }).workflow_runs ?? [];
  for (const run of rawRuns) {
    if (run.id === undefined) continue;
    runs[String(run.id)] = {
      name: run.name ?? "workflow",
      status: run.status ?? "unknown",
      conclusion: run.conclusion ?? null,
      url: run.html_url ?? "",
      event: run.event ?? "unknown",
      headBranch: run.head_branch ?? "",
      headSha: run.head_sha ?? "",
    };
  }
  return runs;
}

function parseResolvedThreads(raw: unknown): string[] {
  const nodes = (raw as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ id?: string; isResolved?: boolean }> } } } };
  }).data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes
    .filter((n) => n.id && n.isResolved)
    .map((n) => n.id!)
    .sort();
}

/**
 * Fetches the current state of a PR plus everything the diff functions need.
 * Five gh calls per poll per watcher: the PR itself, issue comments
 * (top-level PR conversation), review comments (inline diff comments), check
 * runs on the head SHA, and one GraphQL query for review-thread resolution
 * state (isResolved exists only in GraphQL, not the REST API). All
 * non-pull fetches run in parallel.
 */
export async function fetchPrState(gh: GhRunner, repo: string, pr: number): Promise<PrState> {
  const pull = (await gh([`/repos/${repo}/pulls/${pr}`])) as {
    head?: { sha?: string };
    state?: string;
    merged?: boolean;
    title?: string;
    body?: string | null;
  };
  const headSha = pull.head?.sha ?? "";
  const [owner, repoName] = repo.split("/");
  const graphqlQuery =
    `query { repository(owner: "${owner}", name: "${repoName}") { ` +
    `pullRequest(number: ${pr}) { reviewThreads(first: 100) { nodes { id isResolved } } } } }`;
  const [issueComments, reviewComments, checkRuns, threads] = await Promise.all([
    gh([`/repos/${repo}/issues/${pr}/comments?per_page=100&sort=created&direction=desc`]),
    gh([`/repos/${repo}/pulls/${pr}/comments?per_page=100&sort=created&direction=desc`]),
    gh([`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`]),
    gh(["graphql", "-f", `query=${graphqlQuery}`]),
  ]);

  const issueRefs = toCommentRefs(issueComments);
  const reviewRefs = toCommentRefs(reviewComments);

  return {
    headSha,
    state: pull.state ?? "unknown",
    merged: pull.merged ?? false,
    title: pull.title ?? "",
    bodySha: sha256(pull.body ?? ""),
    lastIssueCommentId: maxCommentId(issueRefs),
    lastReviewCommentId: maxCommentId(reviewRefs),
    issueComments: issueRefs,
    reviewComments: reviewRefs,
    resolvedThreads: parseResolvedThreads(threads),
    checkRuns: parseCheckRuns(checkRuns),
  };
}

/**
 * Fetches the current state of a branch: the head commit, check runs on that
 * head, and recent workflow runs relevant to the branch. The branch and
 * workflow-run calls run in parallel; check runs need the head SHA first.
 *
 * Workflow runs are fetched WITHOUT the API's branch filter and filtered
 * client-side: keep runs whose head_branch matches the branch (push runs)
 * or whose head_sha is the branch's current head (tag-triggered runs like a
 * release Publish run - their head_branch is the tag name, so the API's
 * branch filter would hide exactly the runs a release watch exists for).
 */
export async function fetchBranchState(gh: GhRunner, repo: string, branch: string): Promise<BranchState> {
  const [branchInfo, runs] = await Promise.all([
    gh([`/repos/${repo}/branches/${branch}`]),
    gh([`/repos/${repo}/actions/runs?per_page=30`]),
  ]);
  const headSha = (branchInfo as { commit?: { sha?: string } }).commit?.sha ?? "";
  const allRuns = parseWorkflowRuns(runs);
  const relevant = Object.fromEntries(
    Object.entries(allRuns).filter(([, run]) => run.headBranch === branch || run.headSha === headSha),
  );
  const checkRuns = await gh([`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`]);
  return {
    headSha,
    checkRuns: parseCheckRuns(checkRuns),
    workflowRuns: relevant,
  };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/** At most this many events per watcher per cycle; comment floods collapse. */
const MAX_EVENTS_PER_DIFF = 10;

/**
 * Shared check-run diff: emits one event per run that reaches a completed
 * status. A run that was already completed before produces nothing; a run
 * that appears between polls already completed produces one.
 */
function diffCheckRuns(
  before: Record<string, CheckRunRef>,
  after: Record<string, CheckRunRef>,
  eventType: "pr_ci" | "branch_ci",
  fallbackUrl: string,
  out: WatcherEvent[],
): void {
  for (const [runId, run] of Object.entries(after)) {
    const previous = before[runId];
    if (run.status !== "completed") continue;
    if (previous && previous.status === "completed") continue;
    const conclusion = run.conclusion ? ` (${run.conclusion})` : "";
    out.push({
      type: eventType,
      target: "",
      summary: `check "${run.name}" completed${conclusion}`,
      url: run.url ?? fallbackUrl,
    });
  }
}

/**
 * Pure diff between the last-seen and current PR state. Detects comments by
 * id monotonicity, commits by head SHA, description by body hash, CI by
 * check-run transitions, thread resolution by symmetric difference of the
 * sorted resolved-id lists.
 */
export function diffPrState(before: PrState, after: PrState, target: string, baseUrl: string): WatcherEvent[] {
  const events: WatcherEvent[] = [];

  if (after.headSha !== before.headSha && after.headSha) {
    events.push({ type: "pr_commit", target, summary: `head moved to ${after.headSha.slice(0, 7)}`, url: baseUrl });
  }

  if (after.state !== before.state || after.merged !== before.merged) {
    const status = after.merged ? "merged" : after.state;
    events.push({ type: "pr_status", target, summary: `PR is now ${status}`, url: baseUrl });
  }

  if (after.bodySha !== before.bodySha || after.title !== before.title) {
    events.push({ type: "pr_description", target, summary: "PR title or description changed", url: baseUrl });
  }

  const fresh = (refs: CommentRef[], lastSeenId: number) =>
    refs.filter((c) => c.id > lastSeenId);

  for (const c of fresh(after.issueComments, before.lastIssueCommentId)) {
    events.push({ type: "pr_comment", target, summary: `comment by ${c.author}`, url: c.url || baseUrl });
  }
  for (const c of fresh(after.reviewComments, before.lastReviewCommentId)) {
    events.push({
      type: c.isReply ? "pr_review_reply" : "pr_review_comment",
      target,
      summary: `comment by ${c.author}`,
      url: c.url || baseUrl,
    });
  }

  const afterResolved = new Set(after.resolvedThreads);
  const beforeResolved = new Set(before.resolvedThreads);
  for (const id of after.resolvedThreads) {
    if (!beforeResolved.has(id)) {
      events.push({ type: "pr_review_resolved", target, summary: "review thread resolved", url: baseUrl });
    }
  }
  for (const id of before.resolvedThreads) {
    if (!afterResolved.has(id)) {
      events.push({ type: "pr_review_resolved", target, summary: "review thread reopened", url: baseUrl });
    }
  }

  diffCheckRuns(before.checkRuns, after.checkRuns, "pr_ci", baseUrl, events);

  return events.slice(0, MAX_EVENTS_PER_DIFF);
}

/**
 * Pure diff between the last-seen and current branch state: head movement,
 * check-run completions on the head, and workflow runs appearing or
 * transitioning on the branch.
 */
export function diffBranchState(
  before: BranchState,
  after: BranchState,
  target: string,
  repo: string,
): WatcherEvent[] {
  const events: WatcherEvent[] = [];

  if (after.headSha !== before.headSha && after.headSha) {
    events.push({
      type: "branch_commit",
      target,
      summary: `head moved to ${after.headSha.slice(0, 7)}`,
      url: `https://github.com/${repo}/commit/${after.headSha}`,
    });
  }

  diffCheckRuns(before.checkRuns, after.checkRuns, "branch_ci", `https://github.com/${repo}/actions`, events);

  for (const [runId, run] of Object.entries(after.workflowRuns)) {
    const previous = before.workflowRuns[runId];
    const transition = !previous
      ? `started (${run.status})`
      : previous.status !== run.status
        ? run.status === "completed"
          ? `completed (${run.conclusion ?? "no conclusion"})`
          : `${previous.status} -> ${run.status}`
        : null;
    if (!transition) continue;
    events.push({
      type: "branch_workflow",
      target,
      summary: `workflow "${run.name}" ${transition} [${run.event}]`,
      url: run.url,
    });
  }

  return events.slice(0, MAX_EVENTS_PER_DIFF);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class WatcherRegistry {
  #watchers = new Map<string, Watcher>();
  /** sessionID -> events detected but not yet delivered. */
  #pending = new Map<string, WatcherEvent[]>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #delivering = false;
  #polling = false;
  readonly #opts: WatcherRegistryOptions & { pollIntervalMs: number; ttlMinutes: number; maxPerSession: number };

  constructor(options: WatcherRegistryOptions) {
    this.#opts = {
      pollIntervalMs: Number(process.env.THATCH_WATCH_POLL_SECONDS ?? 0) * 1000 || 60_000,
      ttlMinutes: Number(process.env.THATCH_WATCH_TTL_MINUTES ?? 0) || 480,
      maxPerSession: Number(process.env.THATCH_WATCH_MAX_PER_SESSION ?? 0) || 5,
      ...options,
    };
  }

  // -- Lifecycle -----------------------------------------------------------

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.poll();
    }, this.#opts.pollIntervalMs);
    // Never keep the host process alive just for the poller.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** True while the background poller timer is armed. */
  get running(): boolean {
    return this.#timer !== null;
  }

  /**
   * Poll cadence in seconds, surfaced in tool output and notifications so
   * watcher-vs-poll choices compare real numbers even when the interval is
   * overridden via THATCH_WATCH_POLL_SECONDS.
   */
  get pollSeconds(): number {
    return Math.round(this.#opts.pollIntervalMs / 1000);
  }

  /** Stops polling and drops all state. Called from the plugin's dispose. */
  dispose(): void {
    this.stop();
    this.#watchers.clear();
    this.#pending.clear();
  }

  // -- CRUD ----------------------------------------------------------------

  /**
   * Registers a PR watcher and captures the baseline state immediately. The
   * baseline fetch doubles as validation: a bad repo, missing PR, or broken
   * gh setup fails here with a real error instead of a watcher that never
   * fires.
   */
  async createPr(
    sessionID: string,
    repo: string,
    pr: number,
    events: PrWatcherEventType[],
  ): Promise<{ ok: true; watcher: PrWatcher } | { ok: false; error: string }> {
    const limit = this.#checkLimit(sessionID);
    if (limit) return { ok: false, error: limit };
    if (events.length === 0) return { ok: false, error: "No events to watch - pass at least one event type." };

    let state: PrState;
    try {
      state = await fetchPrState(this.#opts.ghRunner, repo, pr);
    } catch (err) {
      return { ok: false, error: `Failed to read ${repo}#${pr}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!state.headSha) {
      return { ok: false, error: `Could not resolve a head SHA for ${repo}#${pr}. Is it an open PR?` };
    }

    const watcher: PrWatcher = {
      id: `watch_${Math.random().toString(36).slice(2, 10)}`,
      source: "pr",
      sessionID,
      repo,
      pr,
      events,
      expiresAt: Date.now() + this.#opts.ttlMinutes * 60_000,
      createdAt: Date.now(),
      state,
    };
    this.#watchers.set(watcher.id, watcher);
    return { ok: true, watcher };
  }

  /**
   * Registers a branch watcher (typically main): commit landings, check-run
   * completions on the head, and workflow runs on the branch. Same baseline
   * validation as createPr.
   */
  async createBranch(
    sessionID: string,
    repo: string,
    branch: string,
    events: BranchWatcherEventType[],
    workflows: string[] = [],
  ): Promise<{ ok: true; watcher: BranchWatcher } | { ok: false; error: string }> {
    const limit = this.#checkLimit(sessionID);
    if (limit) return { ok: false, error: limit };
    if (events.length === 0) return { ok: false, error: "No events to watch - pass at least one event type." };

    let state: BranchState;
    try {
      state = await fetchBranchState(this.#opts.ghRunner, repo, branch);
    } catch (err) {
      return { ok: false, error: `Failed to read ${repo}@${branch}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!state.headSha) {
      return { ok: false, error: `Could not resolve a head SHA for ${repo}@${branch}. Does the branch exist and have commits?` };
    }

    const watcher: BranchWatcher = {
      id: `watch_${Math.random().toString(36).slice(2, 10)}`,
      source: "branch",
      sessionID,
      repo,
      branch,
      events,
      workflows,
      expiresAt: Date.now() + this.#opts.ttlMinutes * 60_000,
      createdAt: Date.now(),
      state,
    };
    this.#watchers.set(watcher.id, watcher);
    return { ok: true, watcher };
  }

  #checkLimit(sessionID: string): string | null {
    const existing = this.listForSession(sessionID);
    if (existing.length >= this.#opts.maxPerSession) {
      return `Watcher limit reached: ${this.#opts.maxPerSession} active watchers per session. Cancel one with watch_cancel first.`;
    }
    return null;
  }

  /** Summaries of one session's watchers, newest first. */
  listForSession(sessionID: string): Watcher[] {
    return [...this.#watchers.values()]
      .filter((w) => w.sessionID === sessionID)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Cancels one watcher. Returns false if it does not exist or belongs to another session. */
  cancel(sessionID: string, id: string): boolean {
    const watcher = this.#watchers.get(id);
    if (!watcher || watcher.sessionID !== sessionID) return false;
    this.#watchers.delete(id);
    return true;
  }

  /** Drops every watcher for a session. Called on session.deleted. */
  cancelSession(sessionID: string): void {
    for (const [id, w] of this.#watchers) {
      if (w.sessionID === sessionID) this.#watchers.delete(id);
    }
    this.#pending.delete(sessionID);
  }

  // -- Polling and delivery ------------------------------------------------

  /**
   * One poll cycle: diff every watcher, queue events, then deliver whatever
   * is pending for sessions that can accept a prompt. Errors are per-watcher:
   * one bad target never blocks the others. Reentrant calls (a cycle slower
   * than the interval) are dropped - overlapping diffs against the same
   * baseline would queue duplicate events.
   */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const now = Date.now();
      for (const [id, watcher] of this.#watchers) {
        if (now > watcher.expiresAt) {
          this.#watchers.delete(id);
          continue;
        }
        try {
          const events = await this.#pollOne(watcher);
          if (events.length > 0) {
            const queue = this.#pending.get(watcher.sessionID) ?? [];
            queue.push(...events);
            this.#pending.set(watcher.sessionID, queue);
          }
        } catch (err) {
          console.error(`[thatch] watcher ${id} poll failed: ${err}`);
        }
      }
      await this.deliverPending();
    } finally {
      this.#polling = false;
    }
  }

  /** Fetches and diffs one watcher, filtered to its watched event types. */
  async #pollOne(watcher: Watcher): Promise<WatcherEvent[]> {
    if (watcher.source === "pr") {
      const after = await fetchPrState(this.#opts.ghRunner, watcher.repo, watcher.pr);
      const events = diffPrState(watcher.state, after, `${watcher.repo}#${watcher.pr}`, this.#prUrl(watcher))
        .filter((e) => watcher.events.includes(e.type as PrWatcherEventType));
      watcher.state = after;
      return events;
    }
    const after = await fetchBranchState(this.#opts.ghRunner, watcher.repo, watcher.branch);
    const all = diffBranchState(watcher.state, after, `${watcher.repo}@${watcher.branch}`, watcher.repo);
    watcher.state = after;
    // The workflow-name filter narrows branch_workflow events only -
    // commits and check runs pass through unfiltered, or a watch filtered
    // to "Publish" would silently drop its commit and CI notifications.
    const matchesFilter = (e: WatcherEvent) =>
      e.type !== "branch_workflow" ||
      watcher.workflows.length === 0 ||
      watcher.workflows.some((wf) => e.summary.toLowerCase().includes(wf.toLowerCase()));
    return all
      .filter((e) => watcher.events.includes(e.type as BranchWatcherEventType) && matchesFilter(e));
  }

  /**
   * Delivers pending events for every session that can accept a prompt.
   * Failed deliveries stay pending and retry on the next cycle or the next
   * idle event.
   */
  async deliverPending(): Promise<void> {
    if (this.#delivering) return;
    this.#delivering = true;
    try {
      for (const [sessionID, events] of this.#pending) {
        if (events.length === 0) continue;
        if (!this.#opts.canDeliver(sessionID)) continue;
        try {
          await this.#opts.deliver(sessionID, events);
          this.#pending.delete(sessionID);
        } catch (err) {
          console.error(`[thatch] watcher delivery to ${sessionID} failed: ${err}`);
        }
      }
    } finally {
      this.#delivering = false;
    }
  }

  /** Diagnostic: number of events waiting for a session. */
  pendingCount(sessionID: string): number {
    return (this.#pending.get(sessionID) ?? []).length;
  }

  #prUrl(watcher: PrWatcher): string {
    return `https://github.com/${watcher.repo}/pull/${watcher.pr}`;
  }
}
