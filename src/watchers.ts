/**
 * Watchers: event-driven notifications from external sources, delivered into
 * a live opencode session as injected prompts.
 *
 * The motivating case: the model registers a watcher on a GitHub PR, and
 * thatch polls the PR in the background. When something the watcher cares
 * about happens (new comments, commits, CI results), the plugin prompts the
 * session with a synthetic notification part - the same delivery mechanism
 * opencode itself uses for background task completions.
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
// Types
// ---------------------------------------------------------------------------

/**
 * The event vocabulary for the github-pr source. Each type maps to one diff
 * against the watcher's last-seen PR state. Notifications carry pointer data
 * (author, URL, counts) rather than content, so text authored by strangers
 * on GitHub never enters the model's context directly - the model fetches
 * details on demand with the gh CLI.
 */
export type WatcherEventType =
  | "pr_comment"
  | "pr_review_comment"
  | "pr_review_reply"
  | "pr_review_resolved"
  | "pr_commit"
  | "pr_status"
  | "pr_description"
  | "pr_ci";

export const WATCHER_EVENT_TYPES: WatcherEventType[] = [
  "pr_comment",
  "pr_review_comment",
  "pr_review_reply",
  "pr_review_resolved",
  "pr_commit",
  "pr_status",
  "pr_description",
  "pr_ci",
];

/** A single detected change, ready for delivery. Pointer data only. */
export interface WatcherEvent {
  type: WatcherEventType;
  /** Human-readable, content-free summary: who/what/where, never body text. */
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
  /** Check runs on the head SHA, keyed by check run id. */
  checkRuns: Record<string, { name: string; status: string; conclusion: string | null; url: string | null }>;
}

export interface Watcher {
  id: string;
  sessionID: string;
  /** owner/repo */
  repo: string;
  pr: number;
  events: WatcherEventType[];
  /** Epoch ms. When now > expiresAt the watcher is silently dropped. */
  expiresAt: number;
  createdAt: number;
  state: PrState;
}

/**
 * Runs one GitHub API call via the gh CLI and parses the JSON response.
 * The array is the argument list after `gh api`: a REST path like
 * ["/repos/o/r/pulls/7"] or a GraphQL invocation like
 * ["graphql", "-f", "query={...}"]. Array-shaped so both transports fit
 * without the callers string-concatenating shell quotes.
 */
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
// PR state construction and diffing
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
  const nodes = (threads as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ id?: string; isResolved?: boolean }> } } } };
  }).data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const resolvedThreads = nodes
    .filter((n) => n.id && n.isResolved)
    .map((n) => n.id!)
    .sort();

  const runs: PrState["checkRuns"] = {};
  const rawRuns = (checkRuns as { check_runs?: Array<{
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
    resolvedThreads,
    checkRuns: runs,
  };
}

/** At most this many events per watcher per cycle; comment floods collapse. */
const MAX_EVENTS_PER_DIFF = 10;

/**
 * Pure diff between the last-seen and current PR state. Detects comments by
 * id monotonicity, commits by head SHA, description by body hash, CI by
 * check-run transitions to a completed status.
 */
export function diffPrState(before: PrState, after: PrState, url: string): WatcherEvent[] {
  const events: WatcherEvent[] = [];

  if (after.headSha !== before.headSha && after.headSha) {
    events.push({
      type: "pr_commit",
      summary: `head moved to ${after.headSha.slice(0, 7)}`,
      url,
    });
  }

  if (after.state !== before.state || after.merged !== before.merged) {
    const status = after.merged ? "merged" : after.state;
    events.push({ type: "pr_status", summary: `PR is now ${status}`, url });
  }

  if (after.bodySha !== before.bodySha || after.title !== before.title) {
    events.push({ type: "pr_description", summary: "PR title or description changed", url });
  }

  const fresh = (refs: CommentRef[], lastSeenId: number) =>
    refs.filter((c) => c.id > lastSeenId);

  for (const c of fresh(after.issueComments, before.lastIssueCommentId)) {
    events.push({ type: "pr_comment", summary: `comment by ${c.author}`, url: c.url || url });
  }
  for (const c of fresh(after.reviewComments, before.lastReviewCommentId)) {
    events.push({
      type: c.isReply ? "pr_review_reply" : "pr_review_comment",
      summary: `comment by ${c.author}`,
      url: c.url || url,
    });
  }

  // Review-thread resolution transitions (GraphQL-only state). Symmetric
  // difference of the sorted resolved-id lists: added ids were resolved,
  // removed ids were reopened.
  const afterResolved = new Set(after.resolvedThreads);
  const beforeResolved = new Set(before.resolvedThreads);
  for (const id of after.resolvedThreads) {
    if (!beforeResolved.has(id)) {
      events.push({ type: "pr_review_resolved", summary: "review thread resolved", url });
    }
  }
  for (const id of before.resolvedThreads) {
    if (!afterResolved.has(id)) {
      events.push({ type: "pr_review_resolved", summary: "review thread reopened", url });
    }
  }

  for (const [runId, run] of Object.entries(after.checkRuns)) {
    const previous = before.checkRuns[runId];
    const completed = run.status === "completed";
    if (!completed) continue;
    if (previous && previous.status === "completed") continue;
    const conclusion = run.conclusion ? ` (${run.conclusion})` : "";
    events.push({ type: "pr_ci", summary: `check "${run.name}" completed${conclusion}`, url: run.url ?? url });
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

  /** Stops polling and drops all state. Called from the plugin's dispose. */
  dispose(): void {
    this.stop();
    this.#watchers.clear();
    this.#pending.clear();
  }

  // -- CRUD ----------------------------------------------------------------

  /**
   * Registers a watcher and captures the baseline state immediately. The
   * baseline fetch doubles as validation: a bad repo, missing PR, or broken
   * gh setup fails here with a real error instead of a watcher that never
   * fires.
   */
  async create(
    sessionID: string,
    repo: string,
    pr: number,
    events: WatcherEventType[],
  ): Promise<{ ok: true; watcher: Watcher } | { ok: false; error: string }> {
    const existing = this.listForSession(sessionID);
    if (existing.length >= this.#opts.maxPerSession) {
      return {
        ok: false,
        error: `Watcher limit reached: ${this.#opts.maxPerSession} active watchers per session. Cancel one with watch_cancel first.`,
      };
    }

    let state: PrState;
    try {
      state = await fetchPrState(this.#opts.ghRunner, repo, pr);
    } catch (err) {
      return { ok: false, error: `Failed to read ${repo}#${pr}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!state.headSha) {
      return { ok: false, error: `Could not resolve a head SHA for ${repo}#${pr}. Is it an open PR?` };
    }

    const watcher: Watcher = {
      id: `watch_${Math.random().toString(36).slice(2, 10)}`,
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
   * one bad PR never blocks the others. Reentrant calls (a cycle slower than
   * the interval) are dropped - overlapping diffs against the same baseline
   * would queue duplicate events.
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
          const after = await fetchPrState(this.#opts.ghRunner, watcher.repo, watcher.pr);
          const events = diffPrState(watcher.state, after, this.pullUrl(watcher))
            .filter((e) => watcher.events.includes(e.type));
          if (events.length > 0) {
            const queue = this.#pending.get(watcher.sessionID) ?? [];
            queue.push(...events);
            this.#pending.set(watcher.sessionID, queue);
          }
          watcher.state = after;
        } catch (err) {
          console.error(`[thatch] watcher ${id} poll failed: ${err}`);
        }
      }
      await this.deliverPending();
    } finally {
      this.#polling = false;
    }
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

  private pullUrl(watcher: Watcher): string {
    return `https://github.com/${watcher.repo}/pull/${watcher.pr}`;
  }
}
