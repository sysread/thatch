import { $ } from "bun";
import { statSync, realpathSync } from "node:fs";
import { join, dirname, basename } from "node:path";

/**
 * Classifies the checkout the given directory serves: "worktree" for a
 * linked git worktree (its .git is a FILE pointing at the main repo's
 * gitdir), "root" for the project's main checkout (.git is a DIRECTORY),
 * and null when undetectable (no .git at all, or no directory given).
 * Synchronous and cheap: callers capture this once at chat registration,
 * so the roster can show which sessions share the main tree.
 */
export function detectWorktreeKind(dir?: string | null): "root" | "worktree" | null {
  if (!dir) return null;
  try {
    const st = statSync(join(dir, ".git"));
    if (st.isFile()) return "worktree";
    if (st.isDirectory()) return "root";
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts an `owner/repo` slug from a git remote URL. Handles the common
 * Git hosting formats: SSH shorthand, HTTPS, plain SSH, and git://.
 *
 * Returns null when the URL doesn't match any known format.
 */
export function parseGitUrl(url: string): string | null {
  const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");

  for (const pattern of URL_PATTERNS) {
    const m = cleaned.match(pattern.re);
    if (m) return pattern.fn(m);
  }

  return null;
}

interface UrlPattern {
  re: RegExp;
  fn: (m: RegExpMatchArray) => string;
}

const URL_PATTERNS: UrlPattern[] = [
  // git@github.com:owner/repo
  {
    re: /^git@([^:]+):(.+)\/(.+)$/,
    fn: (m) => `${m[2]}/${m[3]}`,
  },
  // https://github.com/owner/repo  (with optional .git, already stripped)
  {
    re: /^https?:\/\/[^/]+\/(.+)\/(.+)$/,
    fn: (m) => `${m[1]}/${m[2]}`,
  },
  // ssh://git@github.com/owner/repo
  {
    re: /^ssh:\/\/git@[^/]+\/(.+)\/(.+)$/,
    fn: (m) => `${m[1]}/${m[2]}`,
  },
  // git://github.com/owner/repo
  {
    re: /^git:\/\/[^/]+\/(.+)\/(.+)$/,
    fn: (m) => `${m[1]}/${m[2]}`,
  },
];

/**
 * A cached mapping from a worktree directory to its main checkout and repo
 * identity. Injected into detectRepo and friends so src/git.ts never touches
 * the database directly (the MCP server resolves identity before it opens
 * the DB; hooks and tests may have no DB at all).
 */
export interface RepoPathRow {
  worktreePath: string;
  mainPath: string;
  repoSlug: string;
}

export interface RepoPathCache {
  get(worktreePath: string): RepoPathRow | null;
  put(row: RepoPathRow): void;
  evict(worktreePath: string): void;
}

/**
 * Path-form candidates for a worktree directory, raw first. On macOS a path
 * can arrive as `/var/...` while git and spawned children report the same
 * directory as `/private/var/...`; when the directory itself is deleted (the
 * recovery case) it cannot be realpathed, so the parent is resolved and the
 * basename rejoined instead.
 */
function canonicalWorktreeKeys(dir: string): string[] {
  const keys = [dir];
  try {
    keys.push(join(realpathSync(dirname(dir)), basename(dir)));
  } catch {
    // Parent unresolvable; the raw path is all we have.
  }
  return [...new Set(keys)];
}

function pathExists(dir: string): boolean {
  try {
    statSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the main checkout directory for the given live directory:
 * the parent of the absolute git common dir. `--path-format=absolute` makes
 * the output uniform - a linked worktree reports the MAIN checkout's .git,
 * a root checkout reports its own. Returns null outside a git repo, for a
 * bare repo (the common dir is the bare dir itself - no separate main
 * checkout), or when the spawn fails (deleted dir).
 */
export async function resolveMainCheckout(dir: string): Promise<string | null> {
  try {
    const out = await $`git rev-parse --path-format=absolute --git-common-dir`.cwd(dir).quiet();
    if (out.exitCode !== 0) return null;
    const d = out.stdout.toString().trim();
    if (!d.endsWith("/.git")) return null;
    return d.slice(0, -"/.git".length);
  } catch {
    return null;
  }
}

/** Verdicts for cache-row validation. "kept" = transient failure, row stays. */
type RowVerdict = "valid" | "kept" | "evicted";

/**
 * Validates a cached row against the CURRENT state of its main checkout.
 * Eviction is definitive-only: a wrongly evicted row permanently downgrades
 * identity to "unknown", so anything that might be transient (missing main
 * checkout that could be re-cloned, spawn hiccups) keeps the row and degrades
 * this one call. A live directory that is no longer the recorded repo
 * (re-cloned, replaced, no longer a repo) is definitive and evicts - the
 * identity check is what catches a recycled path returning the old slug.
 */
async function validateMainPath(row: RepoPathRow, cache: RepoPathCache): Promise<RowVerdict> {
  if (!pathExists(row.mainPath)) return "kept";

  try {
    const rd = await $`git rev-parse --git-common-dir`.cwd(row.mainPath).quiet();
    if (rd.exitCode !== 0) {
      cache.evict(row.worktreePath);
      return "evicted";
    }
  } catch {
    return "kept";
  }

  try {
    const remote = await $`git remote get-url origin`.cwd(row.mainPath).quiet();
    if (remote.exitCode === 0) {
      const parsed = parseGitUrl(remote.stdout.toString());
      if (parsed !== row.repoSlug) {
        cache.evict(row.worktreePath);
        return "evicted";
      }
      return "valid";
    }
  } catch {
    return "kept";
  }

  // No origin remote: the recorded slug came from the common-dir fallback,
  // so it must still be the main checkout's own basename.
  if (basename(row.mainPath) !== row.repoSlug) {
    cache.evict(row.worktreePath);
    return "evicted";
  }
  return "valid";
}

/** First cache row for the directory that still validates against its main checkout. */
async function findValidRow(dir: string, cache: RepoPathCache): Promise<RepoPathRow | null> {
  for (const key of canonicalWorktreeKeys(dir)) {
    const row = cache.get(key);
    if (!row) continue;
    const verdict = await validateMainPath(row, cache);
    if (verdict === "valid") return row;
  }
  return null;
}

/**
 * Records a successful identity resolution. Keyed on the REALPATH of the
 * directory (it exists now - this is the only moment canonicalization is
 * possible); read-then-maybe-write skips the row-relevant git spawn when the
 * cache already agrees. Never called for the basename fallback: caching that
 * output would store the exact wrong identity this cache exists to fix.
 */
async function recordRepoPath(dir: string, slug: string, cache?: RepoPathCache): Promise<void> {
  if (!cache) return;
  let canonical: string;
  try {
    canonical = realpathSync(dir);
  } catch {
    // Directory vanished between resolution and write; nothing to record.
    return;
  }
  const existing = cache.get(canonical);
  if (existing && existing.repoSlug === slug && pathExists(existing.mainPath)) return;
  const mainPath = await resolveMainCheckout(dir);
  // Bare repo (no /.git-suffixed common dir) has no meaningful main
  // checkout - skip rather than record a nonsense path. Validation would
  // evict it on first read anyway.
  if (!mainPath) return;
  cache.put({ worktreePath: canonical, mainPath, repoSlug: slug });
}

/**
 * Resolves the directory commands should spawn in: the given directory when
 * it exists, else the validated main checkout from the cache (the worktree
 * was deleted - the merged-and-gone case), else null (caller keeps its
 * current failure behavior). Worktrees share refs/heads and config with the
 * main checkout, so git reads are equivalent from either; only HEAD and the
 * index are per-worktree.
 */
export async function resolveSpawnCwd(dir: string, cache?: RepoPathCache): Promise<string | null> {
  if (pathExists(dir)) return dir;
  const row = cache ? await findValidRow(dir, cache) : null;
  return row?.mainPath ?? null;
}

/**
 * Resolves the canonical repository identity from the given directory.
 *
 * Resolution chain:
 * 1. Parse `owner/repo` from `git remote get-url origin`
 * 2. Fall back to the basename of the main checkout (resolved from the
 *    absolute git-common-dir, so this is worktree-safe: the common dir
 *    lives in the main checkout, not the worktree)
 * 3. Fall back to the directory basename
 *
 * When the directory no longer exists (deleted worktree), steps 1-2 spawn
 * -reject and the cache is consulted for the identity it recorded while the
 * directory was alive; a miss returns "unknown" rather than a plausible
 * wrong name, because resolveStore degrades "unknown" to the global store
 * but a branch-shaped store name silently mis-targets memories.
 */
export async function detectRepo(cwd?: string, cache?: RepoPathCache): Promise<string> {
  const dir = cwd ?? process.env.CURSOR_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  try {
    const remote = await $`git remote get-url origin`.cwd(dir).quiet();
    if (remote.exitCode === 0) {
      const parsed = parseGitUrl(remote.stdout.toString());
      if (parsed) {
        await recordRepoPath(dir, parsed, cache);
        return parsed;
      }
    }
  } catch {
    // no remote 'origin', spawn failure (deleted dir), or not a git repo
  }

  try {
    const main = await resolveMainCheckout(dir);
    if (main) {
      const name = basename(main);
      if (name !== "" && name !== "unknown") {
        await recordRepoPath(dir, name, cache);
        return name;
      }
    }
  } catch {
    // not a git repo
  }

  if (!pathExists(dir)) {
    const row = cache ? await findValidRow(dir, cache) : null;
    return row?.repoSlug ?? "unknown";
  }

  return dir.split("/").pop() || "unknown";
}

/**
 * Local branch names in the given directory's repository. Used to detect
 * branch-scoped memories whose branch no longer exists. Returns [] outside
 * a git repo - callers must treat that as "unknown", not "no branches",
 * or every branch-scoped memory would look orphaned. Falls back to the
 * cached main checkout when the worktree was deleted: refs/heads is shared
 * across worktrees, so the branch list is identical from either.
 */
export async function listBranches(cwd: string, cache?: RepoPathCache): Promise<string[]> {
  const dir = (await resolveSpawnCwd(cwd, cache)) ?? cwd;
  // The format string is interpolated because Bun's shell parser rejects
  // bare parentheses in template literals.
  const fmt = "%(refname:short)";
  try {
    const out = await $`git for-each-ref --format=${fmt} refs/heads`.cwd(dir).quiet();
    if (out.exitCode !== 0) return [];
    return out.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
