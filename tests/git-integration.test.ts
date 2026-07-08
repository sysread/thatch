import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRepo, listBranches } from "../src/git";

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
