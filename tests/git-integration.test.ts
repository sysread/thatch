import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { detectRepo, listBranches, resolveMainCheckout, resolveSpawnCwd, type RepoPathCache, type RepoPathRow } from "../src/git";

let cwd: string;
let origCwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "thatch-git-test-"));
  origCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(cwd, { recursive: true, force: true });
});

async function shell(cmd: string) {
  const parts = cmd.split(" ");
  const { $ } = await import("bun");
  const proc = await $`${{ raw: parts[0] }} ${parts.slice(1)}`.cwd(cwd).quiet();
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString().trim() };
}

async function gitInit() {
  await shell("git init");
  await shell("git config user.email test@example.com");
  await shell("git config user.name Test");
  // Initial commit so the repo isn't empty
  await shell("touch .gitkeep");
  await shell("git add .gitkeep");
  await shell("git commit -m init");
}

describe("detectRepo", () => {
  test("resolves owner/repo from HTTPS remote", async () => {
    await gitInit();
    await shell("git remote add origin https://github.com/anomalyco/thatch.git");
    const repo = await detectRepo(cwd);
    expect(repo).toBe("anomalyco/thatch");
  });

  test("resolves owner/repo from SSH shorthand remote", async () => {
    await gitInit();
    await shell("git remote add origin git@github.com:anomalyco/thatch.git");
    const repo = await detectRepo(cwd);
    expect(repo).toBe("anomalyco/thatch");
  });

  test("resolves owner/repo from remote without .git suffix", async () => {
    await gitInit();
    await shell("git remote add origin https://github.com/jeff.ober/thatch");
    const repo = await detectRepo(cwd);
    expect(repo).toBe("jeff.ober/thatch");
  });

  test("falls back to directory basename when no remote", async () => {
    await gitInit();
    // No remote set
    const repo = await detectRepo(cwd);
    // git-common-dir in a plain repo returns ".git", parent is the temp dir
    expect(repo).not.toBe("unknown");
    expect(typeof repo).toBe("string");
  });

  test("falls back to directory basename outside git", async () => {
    const repo = await detectRepo(cwd);
    // No git repo at all — should use CWD basename
    expect(typeof repo).toBe("string");
    expect(repo).not.toBe("unknown");
  });
});

describe("listBranches", () => {
  test("lists local branches", async () => {
    await gitInit();
    await shell("git branch feature/x");
    const branches = await listBranches(cwd);
    expect(branches).toContain("feature/x");
    expect(branches.length).toBe(2); // default branch + feature/x
  });

  test("returns empty outside a git repo", async () => {
    expect(await listBranches(cwd)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Worktree deletion recovery: the repo_paths cache records identity while
// the directory is alive and answers for it after deletion.
// ---------------------------------------------------------------------------

function memoryCache(): RepoPathCache & { rows: Map<string, RepoPathRow> } {
  const rows = new Map<string, RepoPathRow>();
  return {
    rows,
    get: (p) => rows.get(p) ?? null,
    put: (r) => rows.set(r.worktreePath, r),
    evict: (p) => rows.delete(p),
  };
}

describe("worktree deletion recovery", () => {
  let base: string;
  let mainRepo: string;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "thatch-wt-recovery-"));
    mainRepo = join(base, "main");
    mkdirSync(mainRepo);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  async function git(cmd: string, dir: string) {
    const { $ } = await import("bun");
    // The subcommand string is raw-interpolated as one chunk; inputs are
    // test-controlled paths, not user data.
    const proc = await $`git ${{ raw: cmd }}`.cwd(dir).quiet();
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString().trim() };
  }

  /** Real remote + commit so detectRepo resolves owner/repo everywhere. */
  async function setupMainRepo() {
    await git("init", mainRepo);
    await git("config user.email test@example.com", mainRepo);
    await git("config user.name Test", mainRepo);
    writeFileSync(join(mainRepo, ".gitkeep"), "");
    await git("add .gitkeep", mainRepo);
    await git("commit -m init", mainRepo);
    await git("remote add origin git@github.com:acme/widgets.git", mainRepo);
  }

  async function addWorktree() {
    worktree = join(base, "wt-feature");
    const out = await git(`worktree add -b feature ${worktree}`, mainRepo);
    if (out.exitCode !== 0) throw new Error(`worktree add failed: ${out.stdout}`);
  }

  test("detectRepo records the worktree and recovers identity after deletion", async () => {
    await setupMainRepo();
    await addWorktree();
    const cache = memoryCache();

    // Live resolution works and records the row, keyed on the realpath.
    expect(await detectRepo(worktree, cache)).toBe("acme/widgets");
    const key = realpathSync(worktree);
    expect(cache.rows.get(key)?.repoSlug).toBe("acme/widgets");
    expect(cache.rows.get(key)?.mainPath).toBe(realpathSync(mainRepo));

    // The worktree dies (merged and cleaned up).
    rmSync(worktree, { recursive: true, force: true });
    expect(existsSync(worktree)).toBe(false);

    // Identity recovers from the cache; without the cache the result is
    // "unknown", never the branch-shaped basename of the dead directory.
    expect(await detectRepo(worktree, cache)).toBe("acme/widgets");
    expect(await detectRepo(worktree)).toBe("unknown");
  });

  test("an existing non-git directory still resolves to its basename", async () => {
    await setupMainRepo();
    const cache = memoryCache();
    const plainDir = join(base, "plain");
    mkdirSync(plainDir);
    expect(await detectRepo(plainDir, cache)).toBe("plain");
    expect(cache.rows.size).toBe(0);
  });

  test("cache keys are canonicalized: a symlinked path and its realpath share one row", async () => {
    await setupMainRepo();
    await addWorktree();
    const cache = memoryCache();
    const link = join(base, "worktree-link");
    symlinkSync(worktree, link);

    // Resolution through the symlink writes ONE row keyed on the realpath.
    expect(await detectRepo(link, cache)).toBe("acme/widgets");
    expect(cache.rows.size).toBe(1);
    expect(cache.rows.has(realpathSync(worktree))).toBe(true);

    // Deletion recovery via a DIFFERENT path form of the same directory:
    // the raw key misses (cache holds the /private/var realpath form), the
    // parent-realpath key hits.
    rmSync(worktree, { recursive: true, force: true });
    expect(existsSync(link)).toBe(false); // the symlink dangles with its target
    expect(await detectRepo(worktree, cache)).toBe("acme/widgets");
  });

  test("a recycled main checkout (different origin) evicts the row definitively", async () => {
    await setupMainRepo();
    await addWorktree();
    const cache = memoryCache();
    expect(await detectRepo(worktree, cache)).toBe("acme/widgets");

    // The main checkout is re-cloned from somewhere else under the same path.
    rmSync(mainRepo, { recursive: true, force: true });
    mkdirSync(mainRepo);
    await git("init", mainRepo);
    await git("config user.email test@example.com", mainRepo);
    await git("config user.name Test", mainRepo);
    writeFileSync(join(mainRepo, ".gitkeep"), "");
    await git("add .gitkeep", mainRepo);
    await git("commit -m init", mainRepo);
    await git("remote add origin git@github.com:other/thing.git", mainRepo);

    rmSync(worktree, { recursive: true, force: true });
    expect(await detectRepo(worktree, cache)).toBe("unknown");
    expect(cache.rows.size).toBe(0);
  });

  test("a missing main checkout keeps the row and degrades to unknown", async () => {
    await setupMainRepo();
    await addWorktree();
    const cache = memoryCache();
    expect(await detectRepo(worktree, cache)).toBe("acme/widgets");

    // Main checkout itself disappears - possibly a transient state (re-clone
    // in progress), so the row must survive for a later attempt.
    rmSync(mainRepo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    expect(await detectRepo(worktree, cache)).toBe("unknown");
    expect(cache.rows.size).toBe(1);
  });

  test("resolveSpawnCwd: live dir wins, deleted dir falls back to the main checkout", async () => {
    await setupMainRepo();
    await addWorktree();
    const cache = memoryCache();
    expect(await detectRepo(worktree, cache)).toBe("acme/widgets");

    // A live directory is returned as given, not canonicalized.
    expect(await resolveSpawnCwd(worktree, cache)).toBe(worktree);
    rmSync(worktree, { recursive: true, force: true });
    expect(await resolveSpawnCwd(worktree, cache)).toBe(realpathSync(mainRepo));
    expect(await resolveSpawnCwd(join(base, "nope"), cache)).toBeNull();
    // Without a cache the fallback is unavailable; callers keep their
    // current failure behavior.
    expect(await resolveSpawnCwd(worktree)).toBeNull();
  });

  test("listBranches falls back to the cached main checkout after deletion", async () => {
    await setupMainRepo();
    await addWorktree();
    const cache = memoryCache();
    expect(await detectRepo(worktree, cache)).toBe("acme/widgets");
    await git("branch wt-only-branch", worktree);

    rmSync(worktree, { recursive: true, force: true });
    // refs/heads is shared across worktrees, so the branch list from the
    // main checkout is the same list the worktree would have returned.
    const branches = await listBranches(worktree, cache);
    expect(branches).toContain("wt-only-branch");
    // Without the cache: [] (the old fail-safe).
    expect(await listBranches(worktree)).toEqual([]);
  });

  test("resolveMainCheckout returns the main repo for root and worktree checkouts, null outside git", async () => {
    await setupMainRepo();
    await addWorktree();
    const mainFromRoot = await resolveMainCheckout(mainRepo);
    const mainFromWt = await resolveMainCheckout(worktree);
    expect(mainFromRoot).not.toBeNull();
    expect(mainFromWt).not.toBeNull();
    expect(realpathSync(mainFromRoot!)).toBe(realpathSync(mainRepo));
    expect(realpathSync(mainFromWt!)).toBe(realpathSync(mainRepo));
    expect(await resolveMainCheckout(join(base, "plain-no-git"))).toBeNull();
  });

  test("a bare repo is not cached (no meaningful main checkout)", async () => {
    const bare = join(base, "bare.git");
    await git(`init --bare ${bare}`, base);
    const cache = memoryCache();
    const slug = await detectRepo(bare, cache);
    expect(slug).toBe(basename(bare)); // common-dir fallback name
    expect(cache.rows.size).toBe(0);
  });
});
