import { $ } from "bun";

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
 * Resolves the canonical repository identity from the given directory.
 *
 * Resolution chain:
 * 1. Parse `owner/repo` from `git remote get-url origin`
 * 2. Fall back to the basename of the git-common-dir (worktree-safe)
 * 3. Fall back to the directory basename
 */
export async function detectRepo(cwd?: string): Promise<string> {
  const dir = cwd ?? process.env.CURSOR_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  try {
    const remote = await $`git remote get-url origin`.cwd(dir).quiet();
    if (remote.exitCode === 0) {
      const parsed = parseGitUrl(remote.stdout.toString());
      if (parsed) return parsed;
    }
  } catch {
    // no remote 'origin', or not a git repo
  }

  try {
    const gitDir = await $`git rev-parse --git-common-dir`.cwd(dir).quiet();
    if (gitDir.exitCode === 0) {
      const d = gitDir.stdout.toString().trim();
      const parent = d.endsWith("/.git") ? d.slice(0, -5) : d;
      const name = parent.split("/").pop() || "unknown";
      if (name !== "unknown") return name;
    }
  } catch {
    // not a git repo
  }

  return dir.split("/").pop() || "unknown";
}

/**
 * Local branch names in the given directory's repository. Used to detect
 * branch-scoped memories whose branch no longer exists. Returns [] outside
 * a git repo — callers must treat that as "unknown", not "no branches",
 * or every branch-scoped memory would look orphaned.
 */
export async function listBranches(cwd: string): Promise<string[]> {
  // The format string is interpolated because Bun's shell parser rejects
  // bare parentheses in template literals.
  const fmt = "%(refname:short)";
  try {
    const out = await $`git for-each-ref --format=${fmt} refs/heads`.cwd(cwd).quiet();
    if (out.exitCode !== 0) return [];
    return out.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
