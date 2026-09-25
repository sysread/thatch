/**
 * Watchers: event-driven notifications from external sources, delivered into
 * a live opencode session as injected prompts.
 *
 * The registry supports multiple source types behind one mechanism. The
 * first source was GitHub pull requests (source "pr"); GitHub branches
 * (source "branch") arrived second, for watching CI and workflow runs
 * against main; shell commands (source "command") arrived third, for
 * waiting on arbitrary local conditions. A source contributes: event
 * types, a fetch function that produces a snapshot of the watched state,
 * and a pure diff between two snapshots. Everything else - registry,
 * pending queue, delivery gating - is source-agnostic. The command source
 * stretches the recipe in two ways: its fetch runs the watched command
 * instead of reading an API, and its diff is a trivial exit-code check -
 * the command is a condition variable, and only its exit code is read,
 * never its output (injection hygiene: command output can be external
 * content, so it never rides a notification).
 *
 * Lifetime is deliberately process-scoped for the LIVE registry: the
 * poller and delivery state live in plugin memory, never in SQLite -
 * opencode loads thatch in-process, so the plugin process is the natural
 * owner of its watchers, and no cross-process "who polls this?" claim
 * logic is needed. The DEFINITIONS, however, are journaled to
 * runtime_state (the optional journal hook) so they survive v2 plugin
 * reloads and, as dormant rows, full restarts - see the rearm() and the
 * runtime's dormant-watcher scan.
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

/** Event type for source "command": the watched shell command exited 0. */
export type CommandWatcherEventType = "command_success";

export type WatcherEventType = PrWatcherEventType | BranchWatcherEventType | CommandWatcherEventType;

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

export const COMMAND_EVENT_TYPES: CommandWatcherEventType[] = ["command_success"];

/** Every event type across all sources - for diagnostics and tests. */
export const WATCHER_EVENT_TYPES: WatcherEventType[] = [...PR_EVENT_TYPES, ...BRANCH_EVENT_TYPES, ...COMMAND_EVENT_TYPES];

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
  /** One-shot: cancelled automatically after the first matching event. */
  once: boolean;
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
  /** One-shot: cancelled automatically after the first matching event. */
  once: boolean;
  /** Epoch ms. When now > expiresAt the watcher is silently dropped. */
  expiresAt: number;
  createdAt: number;
  state: BranchState;
}

/** The last-seen state of a command watch: the most recent observed exit code. */
export interface CommandState {
  lastExit: number;
}

export interface CommandWatcher {
  id: string;
  source: "command";
  sessionID: string;
  /** The shell command, run via bash -c in cwd every poll. A condition variable: only its exit code is read, never its output. */
  command: string;
  /** Working directory the command runs in, captured at registration. */
  cwd: string;
  /** Per-run kill timeout in ms - a hanging command must not stall the shared poll cycle. */
  timeoutMs: number;
  events: CommandWatcherEventType[];
  /** Command watchers are inherently one-shot: they fire on the first exit 0 and cancel. */
  once: true;
  /** Epoch ms. When now > expiresAt the watcher is silently dropped. */
  expiresAt: number;
  createdAt: number;
  state: CommandState;
}

export type Watcher = PrWatcher | BranchWatcher | CommandWatcher;

/** Runs one GitHub API call via the gh CLI and parses the JSON response.
 *  The array is the argument list after `gh api`: a REST path like
 *  ["/repos/o/r/pulls/7"] or a GraphQL invocation like
 *  ["graphql", "-f", "query={...}"]. Array-shaped so both transports fit
 *  without the callers string-concatenating shell quotes. */
export type GhRunner = (apiArgs: string[]) => Promise<unknown>;

/**
 * Runs one watched command and reports how it ended. The command's stdout is
 * drained but discarded - the watcher treats the command as a condition
 * variable (exit code only), so command output never reaches a notification.
 * stderr is kept (capped) for registration-time error messages only.
 */
export interface CommandRunResult {
  exitCode: number;
  /** True when the runner killed the command at the timeout instead of letting it finish. */
  timedOut: boolean;
  stderr: string;
  /** Wall-clock duration of the run in ms, for the notification summary. */
  durationMs: number;
}

export type CommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<CommandRunResult>;

/**
 * Wraps a CommandRunner so the spawn cwd is resolved per poll: the given
 * resolver returns the directory to run in (the project dir when alive, or
 * the cached main checkout when the worktree was deleted mid-watch), or null
 * to keep the original cwd (which then fails as before). A fallback fires
 * at most once per dead directory - onFallback, when given, reports it so
 * the host can log; per-cycle logging is the poll loop's existing failure
 * mode and it spams. Exported for the fallback unit tests; the plugin wires
 * the production instance.
 */
export function withCwdFallback(
  base: CommandRunner,
  resolve: (cwd: string) => Promise<string | null>,
  onFallback?: (from: string, to: string) => void,
): CommandRunner {
  const logged = new Set<string>();
  return async (command, cwd, timeoutMs) => {
    const resolved = await resolve(cwd);
    if (resolved && resolved !== cwd && !logged.has(cwd)) {
      logged.add(cwd);
      onFallback?.(cwd, resolved);
    }
    return base(command, resolved ?? cwd, timeoutMs);
  };
}

export interface WatcherRegistryOptions {
  /** Delivers a batch of events for a session. Injected so tests never spawn. */
  deliver: (sessionID: string, events: WatcherEvent[]) => Promise<void>;
  /**
   * Gate for delivery. The plugin passes a predicate that returns true only
   * when the session can accept a proactive prompt right now (idle, not
   * compacting). May be async - the plugin's gate verifies against the
   * server's live session status, because the event-fed map can be stale
   * and a wake injected into a running turn is mid-turn context injection.
   * Undeliverable events stay pending and retry on later cycles or when
   * the session next goes idle.
   */
  canDeliver: (sessionID: string) => boolean | Promise<boolean>;
  ghRunner: GhRunner;
  /** Runs watched commands. Injected so tests never spawn; defaults to runWatchedCommand. */
  commandRunner?: CommandRunner;
  /** Per-run kill timeout for watched commands; defaults to THATCH_WATCH_COMMAND_TIMEOUT_SECONDS or 30s. */
  commandTimeoutMs?: number;
  pollIntervalMs?: number;
  ttlMinutes?: number;
  maxPerSession?: number;
  /** Persistence hook: called after membership changes with the session's watcher list. */
  journal?: (sessionID: string, watchers: Watcher[]) => void;
}

// ---------------------------------------------------------------------------
// GitHub access via the gh CLI
// ---------------------------------------------------------------------------

/**
 * The default GhRunner. Shells out to `gh api` so auth comes from the user's
 * existing gh session - thatch never sees or stores a token. Throws on
 * non-zero exit or unparseable output. See ghApiRunWithTimeout for the
 * drain-race hardening.
 */
export async function ghApiRun(apiArgs: string[]): Promise<unknown> {
  return ghApiRunWithTimeout(apiArgs, GH_API_TIMEOUT_MS);
}

/** Per-call timeout for gh api invocations. */
const GH_API_TIMEOUT_MS = 15_000;

/**
 * Reads a spawned process's output stream to EOF. A read ERROR is not EOF -
 * the pipe may still be delivering - so the loop backs off briefly and keeps
 * reading until the caller's drain race abandons it; only the abandonment's
 * cancel settles the loop early (a cancelled host process must never be
 * pinned by a pending read). Treating an error as EOF here would turn the
 * abandonment path - the orphaned-child timeout message - into a fast, wrong
 * exit.
 * Exported for the drain unit tests.
 */
export async function drainStreamOutput(
  reader: ReadableStreamDefaultReader,
  isCancelled: () => boolean,
): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    let res: { done: boolean; value?: any };
    try {
      res = await reader.read();
    } catch {
      if (isCancelled()) return text;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        t.unref?.();
      });
      continue;
    }
    if (res.done) return text;
    text += decoder.decode(res.value, { stream: true });
  }
}

/**
 * One gh api call with the drain-race hardening: the pipe drains are raced
 * against a hard deadline (timeout plus COMMAND_DRAIN_GRACE_MS) so a gh
 * child process holding the pipes past the kill rejects cleanly instead of
 * deadlocking the shared poll cycle (same hardening as runWatchedCommand).
 * The stderr read on the error path gets the same race - a descendant that
 * dup2'd stdout away but kept stderr would otherwise wedge the cycle.
 */
export async function ghApiRunWithTimeout(apiArgs: string[], timeoutMs: number): Promise<unknown> {
  const proc = Bun.spawn(["gh", "api", ...apiArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const deadlineMs = timeoutMs + COMMAND_DRAIN_GRACE_MS;
  let raceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  // Set by the abandonment path so the drain loops settle on their cancelled
  // reads instead of retrying (a cancelled host must never be pinned).
  let cancelled = false;
  try {
    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    const drain = Promise.all([
      drainStreamOutput(stdoutReader, () => cancelled),
      proc.exited,
    ]);
    // If the drain does not finish by the deadline (orphaned grandchild
    // holding the pipes), abandon it - and cancel the readers so the pending
    // reads settle instead of pinning the host process at shutdown.
    const raced = await Promise.race([
      drain.then(([stdout, exitCode]) => ({ stdout, exitCode })),
      new Promise<null>((resolve) => {
        raceTimer = setTimeout(() => resolve(null), deadlineMs);
        raceTimer.unref?.();
      }),
    ]);
    if (raced === null) {
      cancelled = true;
      void stdoutReader.cancel().catch(() => {});
      void stderrReader.cancel().catch(() => {});
      throw new Error(`gh api ${apiArgs.join(" ")} timed out (orphaned child holding the output pipe; killed at the ${timeoutMs}ms timeout, drains abandoned after ${Math.round(deadlineMs / 1000)}s)`);
    }
    if (raced.exitCode !== 0) {
      const racedErr = await Promise.race([
        drainStreamOutput(stderrReader, () => cancelled),
        new Promise<string>((resolve) => {
          const t = setTimeout(() => resolve(""), deadlineMs);
          t.unref?.();
        }),
      ]);
      throw new Error(`gh api ${apiArgs.join(" ")} failed (exit ${raced.exitCode}): ${racedErr.trim().slice(0, 200)}`);
    }
    return JSON.parse(raced.stdout);
  } finally {
    clearTimeout(timeout);
    clearTimeout(raceTimer);
  }
}

/**
 * The stable target label a watcher reports in events, lists, and recovery
 * notices: "owner/repo#N" for PRs, "owner/repo@branch" for branches, and a
 * one-line clip of the command for command watches.
 */
export function watcherTarget(watcher: Watcher): string {
  if (watcher.source === "pr") return `${watcher.repo}#${watcher.pr}`;
  if (watcher.source === "branch") return `${watcher.repo}@${watcher.branch}`;
  return commandTargetLabel(watcher.command);
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
// Watched command execution
// ---------------------------------------------------------------------------

/** Per-run timeout for watched commands, overridable via THATCH_WATCH_COMMAND_TIMEOUT_SECONDS. */
export function defaultCommandTimeoutMs(): number {
  const env = Number(process.env.THATCH_WATCH_COMMAND_TIMEOUT_SECONDS ?? 0);
  return env > 0 ? env * 1000 : 30_000;
}

/** One-line clip of a command for use as a watcher target label. */
export function commandTargetLabel(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : oneLine.slice(0, 57) + "...";
}

const COMMAND_STDERR_CAP = 2000;

/**
 * Grace past the spawn timeout before the pipe drains are abandoned. The
 * direct child has already been SIGKILLed by then, so anything still holding
 * the pipes is an orphaned grandchild - its output is lost, but the poll
 * cycle survives.
 */
const COMMAND_DRAIN_GRACE_MS = 2_000;

/**
 * The default CommandRunner: bash -c in the given cwd, killed at the timeout.
 * Both pipes are always drained even though stdout is discarded - a child
 * writing more than the pipe buffer would otherwise block forever. A timeout
 * counts as "condition not met yet", not an error, so the watch keeps polling.
 *
 * The kill cannot always terminate the whole process tree: a command that
 * backgrounds a long-lived child leaves a grandchild holding the pipe
 * write-ends, so the pipe reads may never reach EOF. The drains are therefore
 * raced against a hard deadline (timeout plus a short grace period) - the
 * run completes as timed-out even when the pipes stay open, and a leaked
 * reader (and its buffered output) is abandoned rather than stalling the
 * shared poll cycle forever. An abandoned grandchild itself keeps running
 * until it exits on its own; nothing reaps it.
 */
export async function runWatchedCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandRunResult> {
  const startedAt = Date.now();
  let killed = false;
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new Error(`failed to start the watched command (check the command and project directory): ${err instanceof Error ? err.message : String(err)}`);
  }
  const timeout = setTimeout(() => {
    killed = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const deadlineMs = timeoutMs + COMMAND_DRAIN_GRACE_MS;
  let raceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  // Set by the abandonment path so the drain loops settle on their cancelled
  // reads instead of retrying (a cancelled host must never be pinned).
  let cancelled = false;
  try {
    // Explicit readers instead of Response.text(): a held reader lock keeps
    // stream.cancel() from working, but reader.cancel() both settles the
    // pending reads and releases the host when the deadline wins.
    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    const drain = Promise.all([
      drainStreamOutput(stdoutReader, () => cancelled),
      drainStreamOutput(stderrReader, () => cancelled),
      proc.exited,
    ]);
    // If the drain does not finish by the deadline (orphaned grandchild
    // holding the pipes), abandon it - and cancel the readers so the pending
    // reads settle instead of pinning the host process at shutdown.
    // The race timer is unref'd and cleared so a lingering fallback can
    // never keep the host process alive on its own.
    const result = await Promise.race([
      drain.then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })),
      new Promise<null>((resolve) => {
        raceTimer = setTimeout(() => resolve(null), Math.max(0, deadlineMs - (Date.now() - startedAt)));
        raceTimer.unref?.();
      }),
    ]);
    if (result === null) {
      cancelled = true;
      void stdoutReader.cancel().catch(() => {});
      void stderrReader.cancel().catch(() => {});
      return { exitCode: 124, timedOut: true, stderr: "", durationMs: Date.now() - startedAt };
    }
    const timedOut = killed || result.exitCode === null;
    if (timedOut) {
      console.error(`[thatch] watched command killed at the ${timeoutMs}ms timeout: ${commandTargetLabel(command)}`);
    }
    return {
      exitCode: result.exitCode ?? 124,
      timedOut,
      stderr: result.stderr.slice(-COMMAND_STDERR_CAP),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(raceTimer);
  }
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
  /**
   * Persistence hook (optional): called after every membership change with
   * the session's current watcher list, so the runtime can journal the
   * definitions and re-arm them after a v2 plugin reload. Passing no hook
   * (tests, MCP) keeps the registry in-memory only.
   */
  #journal?: (sessionID: string, watchers: Watcher[]) => void;
  readonly #opts: WatcherRegistryOptions & {
    pollIntervalMs: number;
    ttlMinutes: number;
    maxPerSession: number;
    commandRunner: CommandRunner;
    commandTimeoutMs: number;
  };

  constructor(options: WatcherRegistryOptions) {
    this.#opts = {
      pollIntervalMs: Number(process.env.THATCH_WATCH_POLL_SECONDS ?? 0) * 1000 || 60_000,
      ttlMinutes: Number(process.env.THATCH_WATCH_TTL_MINUTES ?? 0) || 480,
      maxPerSession: Number(process.env.THATCH_WATCH_MAX_PER_SESSION ?? 0) || 5,
      commandRunner: runWatchedCommand,
      commandTimeoutMs: defaultCommandTimeoutMs(),
      ...options,
    };
    this.#journal = options.journal;
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

  /** Journal the session's current watcher list (no-op without a hook). */
  #emit(sessionID: string): void {
    this.#journal?.(sessionID, this.listForSession(sessionID));
  }

  /** Restore persisted watchers (same-process reload rehydration). */
  hydrate(watchers: Watcher[]): void {
    for (const w of watchers) {
      // Do not clobber a watcher created after the journal was written.
      if (!this.#watchers.has(w.id)) this.#watchers.set(w.id, w);
    }
  }

  /**
   * Re-arms persisted watcher definitions recovered on session resume after
   * a restart (the dormant journal rows the runtime keeps instead of
   * pruning). Definitions whose TTL expired while the session was away are
   * dropped - a watch that outlived its own expiry must not fire on a stale
   * baseline. PR and branch definitions are REVALIDATED by re-fetching
   * their baseline: a deleted branch or closed PR would otherwise re-arm
   * into silent poll failure, and a stale baseline would flood the session
   * with every event that happened while it was away; fetch failures drop
   * the definition and count as failed. The rest join the live registry
   * newest-first up to the per-session limit (the session may have created
   * watchers since the restart), and the journal is rewritten either way:
   * with the current process's pid when anything re-arms, deleted when
   * nothing does.
   */
  async rearm(sessionID: string, defs: Watcher[]): Promise<{ rearmed: Watcher[]; expired: number; failed: number }> {
    const now = Date.now();
    const fresh = defs.filter((w) => now <= w.expiresAt).sort((a, b) => b.createdAt - a.createdAt);
    const budget = Math.max(0, this.#opts.maxPerSession - this.listForSession(sessionID).length);
    const rearmed: Watcher[] = [];
    let failed = 0;
    for (const def of fresh.slice(0, budget)) {
      if (def.source !== "command") {
        try {
          def.state = def.source === "pr"
            ? await fetchPrState(this.#opts.ghRunner, def.repo, def.pr)
            : await fetchBranchState(this.#opts.ghRunner, def.repo, def.branch);
        } catch {
          failed++;
          continue;
        }
      }
      // Do not clobber a watcher created after the journal was written.
      if (!this.#watchers.has(def.id)) this.#watchers.set(def.id, def);
      rearmed.push(def);
    }
    this.#emit(sessionID);
    return { rearmed, expired: defs.length - fresh.length, failed };
  }

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
    opts: { once?: boolean } = {},
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
      once: opts.once === true,
      expiresAt: Date.now() + this.#opts.ttlMinutes * 60_000,
      createdAt: Date.now(),
      state,
    };
    this.#watchers.set(watcher.id, watcher);
    this.#emit(sessionID);
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
    opts: { once?: boolean } = {},
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
      once: opts.once === true,
      expiresAt: Date.now() + this.#opts.ttlMinutes * 60_000,
      createdAt: Date.now(),
      state,
    };
    this.#watchers.set(watcher.id, watcher);
    this.#emit(sessionID);
    return { ok: true, watcher };
  }

  /**
   * Registers a command watcher: the poller runs the command (as a condition
   * variable - exit code only) every cycle until it first exits 0, notifies,
   * and cancels. The baseline run doubles as validation, like createPr: a
   * command that already exits 0 means the condition is already met (refuse,
   * so the caller proceeds now), exit 127 means the command does not exist,
   * and a spawn failure fails with a real error instead of a watcher that
   * can never fire.
   */
  async createCommand(
    sessionID: string,
    command: string,
    cwd: string,
  ): Promise<{ ok: true; watcher: CommandWatcher } | { ok: false; error: string }> {
    const limit = this.#checkLimit(sessionID);
    if (limit) return { ok: false, error: limit };
    if (!command.trim()) return { ok: false, error: "No command to watch - pass a shell command." };

    let baseline: CommandRunResult;
    try {
      baseline = await this.#opts.commandRunner(command, cwd, this.#opts.commandTimeoutMs);
    } catch (err) {
      return { ok: false, error: `Failed to run the command: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!baseline.timedOut && baseline.exitCode === 0) {
      return { ok: false, error: "The command already exits 0 - the condition is already met, so no watcher was registered. Proceed now, or re-run the command yourself if you need its output." };
    }
    if (baseline.exitCode === 127) {
      return {
        ok: false,
        error: `The command exited 127 (command not found) - nothing to wait for until it exists. stderr: ${baseline.stderr.trim() || "(none)"}`,
      };
    }

    const watcher: CommandWatcher = {
      id: `watch_${Math.random().toString(36).slice(2, 10)}`,
      source: "command",
      sessionID,
      command,
      cwd,
      timeoutMs: this.#opts.commandTimeoutMs,
      events: [...COMMAND_EVENT_TYPES],
      once: true,
      expiresAt: Date.now() + this.#opts.ttlMinutes * 60_000,
      createdAt: Date.now(),
      // A timed-out baseline has no meaningful exit code - the killed process
      // may have exited 0 while dying. Record the 124 sentinel so watch_list
      // and the registration output never display a misleading 0 for a
      // watcher that has not observed a real exit yet.
      state: { lastExit: baseline.timedOut ? 124 : baseline.exitCode },
    };
    this.#watchers.set(watcher.id, watcher);
    this.#emit(sessionID);
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
    this.#emit(sessionID);
    return true;
  }

  /** Drops every watcher for a session. Called on session.deleted. */
  cancelSession(sessionID: string): void {
    for (const [id, w] of this.#watchers) {
      if (w.sessionID === sessionID) this.#watchers.delete(id);
    }
    this.#pending.delete(sessionID);
    this.#emit(sessionID);
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
          this.#emit(watcher.sessionID);
          continue;
        }
        try {
          const events = await this.#pollOne(watcher);
          if (events.length > 0) {
            const queue = this.#pending.get(watcher.sessionID) ?? [];
            queue.push(...events);
            this.#pending.set(watcher.sessionID, queue);
            // One-shot watchers end at first detection, not first delivery:
            // the queued events deliver through the normal pending path even
            // if the session is busy. Cancellation at detection time keeps
            // "wait for this run to finish" from leaving a standing watch
            // polling a target nobody is waiting on anymore.
            if (watcher.once) {
              this.#watchers.delete(id);
              this.#emit(watcher.sessionID);
            }
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
      const events = diffPrState(watcher.state, after, watcherTarget(watcher), this.#prUrl(watcher))
        .filter((e) => watcher.events.includes(e.type as PrWatcherEventType));
      watcher.state = after;
      return events;
    }
    if (watcher.source === "command") {
      const result = await this.#opts.commandRunner(watcher.command, watcher.cwd, watcher.timeoutMs);
      // A timed-out run produced no meaningful exit code, so the last-seen
      // exit stays as-is and the watch keeps waiting. Exit 0 needs no
      // transition guard: the baseline refusal keeps lastExit non-zero at
      // registration, and the one-shot cancel in poll() removes the watcher
      // the moment this event fires.
      if (!result.timedOut) watcher.state = { lastExit: result.exitCode };
      if (result.timedOut || result.exitCode !== 0) return [];
      return [{
        type: "command_success",
        target: watcherTarget(watcher),
        summary: `command exited 0 (took ${(result.durationMs / 1000).toFixed(1)}s)`,
        url: "",
      }];
    }
    const after = await fetchBranchState(this.#opts.ghRunner, watcher.repo, watcher.branch);
    const all = diffBranchState(watcher.state, after, watcherTarget(watcher), watcher.repo);
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
        // A throwing gate must not escape poll() - an unhandled rejection
        // here would take down the whole poll cycle, the same failure class
        // as a hung fetch. Fail closed: the mail stays pending.
        let deliverable = false;
        try {
          deliverable = await this.#opts.canDeliver(sessionID);
        } catch (err) {
          console.error(`[thatch] canDeliver gate failed for ${sessionID}: ${err}`);
        }
        if (!deliverable) continue;
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
