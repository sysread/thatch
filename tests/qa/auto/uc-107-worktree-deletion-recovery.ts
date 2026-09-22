import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB, repoPathCache } from "../../../src/db";
import { detectRepo, resolveSpawnCwd } from "../../../src/git";
import { TOOL_DEFS } from "../../../src/tool-defs";

/**
 * UC-107: Worktree deletion recovery.
 *
 * Automatable: yes - a real git repo + worktree in a temp dir, a real
 * ThatchDB on a temp SQLite file, and detectRepo/resolveSpawnCwd (they
 * spawn git, not opencode). No model tokens, no opencode session.
 */

const useCase: UseCase = {
  name: "UC-107-worktree-deletion-recovery",
  preconditions: [
    "- git and bun are on PATH; no network, no opencode session.",
  ].join("\n"),
  steps: [
    "1. Create a main repo with an origin remote and a linked worktree; open a ThatchDB on a temp SQLite file.",
    "2. detectRepo in the live worktree resolves owner/repo and records a repo_paths row keyed on the realpath.",
    "3. Delete the worktree; detectRepo on the dead path recovers the identity from the cache.",
    "4. resolveSpawnCwd on the dead path returns the main checkout; without a cache it returns null.",
    "5. A deleted directory with no cache entry resolves to 'unknown' (degrades to global), never the branch-name basename.",
    "6. watch_command_create exposes the cd override in its tool schema.",
  ].join("\n"),
  expected: [
    "- Live resolution writes exactly one cache row (realpath key) with the correct main checkout and slug.",
    "- Identity survives worktree deletion via the cache; the spawn cwd falls back to the main checkout.",
    "- A cache miss on a deleted directory yields 'unknown', preserving the unknown-to-global contract.",
    "- watch_command_create accepts an optional cd parameter.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const tool = TOOL_DEFS.find((t) => t.name === "watch_command_create");
    if (!tool || !tool.opencodeOnly) {
      console.log("  FAIL: watch_command_create missing or not opencode-only");
      return "FAIL";
    }
    if (!("cd" in tool.args)) {
      console.log("  FAIL: watch_command_create has no cd parameter");
      return "FAIL";
    }

    const base = mkdtempSync(join(tmpdir(), "thatch-qa-wt-"));
    try {
      const mainRepo = join(base, "main");
      mkdirSync(mainRepo);
      const git = async (cmd: string, dir: string) => {
        const { $ } = await import("bun");
        const proc = await $`git ${{ raw: cmd }}`.cwd(dir).quiet();
        if (proc.exitCode !== 0) throw new Error(`git ${cmd} failed: ${proc.stderr.toString()}`);
        return proc.stdout.toString().trim();
      };

      await git("init", mainRepo);
      await git("config user.email qa@example.com", mainRepo);
      await git("config user.name QA", mainRepo);
      writeFileSync(join(mainRepo, ".gitkeep"), "");
      await git("add .gitkeep", mainRepo);
      await git("commit -m init", mainRepo);
      await git("remote add origin git@github.com:acme/widgets.git", mainRepo);
      const worktree = join(base, "wt-feature");
      await git(`worktree add -b feature ${worktree}`, mainRepo);

      const db = new ThatchDB(join(base, "qa.db"));
      try {
        const cache = repoPathCache(db);

        // Step 2: live resolution records one realpath-keyed row.
        if ((await detectRepo(worktree, cache)) !== "acme/widgets") {
          console.log("  FAIL: detectRepo did not resolve owner/repo in the live worktree");
          return "FAIL";
        }
        const { realpathSync } = await import("node:fs");
        const rows = db.repoPathGet(realpathSync(worktree));
        if (!rows || rows.repoSlug !== "acme/widgets" || rows.mainPath !== realpathSync(mainRepo)) {
          console.log(`  FAIL: unexpected cache row: ${JSON.stringify(rows)}`);
          return "FAIL";
        }

        // Step 3: identity survives worktree deletion.
        rmSync(worktree, { recursive: true, force: true });
        if (existsSync(worktree)) {
          console.log("  FAIL: worktree was not deleted");
          return "FAIL";
        }
        if ((await detectRepo(worktree, cache)) !== "acme/widgets") {
          console.log("  FAIL: identity was not recovered from the cache after deletion");
          return "FAIL";
        }

        // Step 4: the spawn cwd falls back to the main checkout.
        if ((await resolveSpawnCwd(worktree, cache)) !== realpathSync(mainRepo)) {
          console.log("  FAIL: resolveSpawnCwd did not fall back to the main checkout");
          return "FAIL";
        }
        if ((await resolveSpawnCwd(worktree)) !== null) {
          console.log("  FAIL: resolveSpawnCwd must return null without a cache");
          return "FAIL";
        }

        // Step 5: a cache miss on a deleted directory is "unknown", never
        // the branch-shaped basename.
        const dead = join(base, "wt-untracked");
        if ((await detectRepo(dead)) !== "unknown") {
          console.log(`  FAIL: deleted dir without cache must be unknown, got: ${await detectRepo(dead)}`);
          return "FAIL";
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }

    return "PASS";
  },
};

registerUseCase(useCase);
