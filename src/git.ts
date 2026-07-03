import { $ } from "bun";

/**
 * Extracts an `owner/repo` slug from a git remote URL. Handles the common
 * Git hosting formats: SSH shorthand, HTTPS, plain SSH, and git://.
 *
 * Returns null when the URL doesn't match any known format.
 */
export function parseGitUrl(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, "");

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
  const opts = cwd ? { cwd } : {};

  const remote = await $`git remote get-url origin`.cwd(opts.cwd ?? process.cwd()).quiet();
  if (remote.exitCode === 0) {
    const parsed = parseGitUrl(remote.stdout.toString());
    if (parsed) return parsed;
  }

  const gitDir = await $`git rev-parse --git-common-dir`.cwd(opts.cwd ?? process.cwd()).quiet();
  if (gitDir.exitCode === 0) {
    const dir = gitDir.stdout.toString().trim();
    const parent = dir.endsWith("/.git") ? dir.slice(0, -5) : dir;
    const name = parent.split("/").pop() || "unknown";
    if (name !== "unknown") return name;
  }

  return (cwd || process.cwd()).split("/").pop() || "unknown";
}
