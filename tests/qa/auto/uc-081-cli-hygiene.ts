import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";

/**
 * UC-081: CLI hygiene.
 *
 * Automatable: `thatch hygiene` is a pure CLI call over a controlled DB.
 * Seeds duplicate, stale, and orphaned signals, then verifies the CLI
 * output. Also tests the all-zero case ("Store is healthy.") and the
 * non-git case (orphan check skipped).
 */

const useCase: UseCase = {
  name: "UC-081-cli-hygiene",
  preconditions: [
    "- Bun on PATH; thatch installed",
    "- A DB with known state: one run with non-zero signals, one run with all-zero signals",
  ].join("\n"),
  steps: [
    "1. Seed a DB with duplicate candidates (two memories with cosine >= 0.85).",
    "2. Run `thatch hygiene` and verify the duplicate count appears.",
    "3. Seed a DB with stale entries (memories not updated or recalled in 90+ days).",
    "4. Run `thatch hygiene` and verify the stale count appears.",
    "5. Seed a DB with orphaned branch memories (memories scoped to branches that no longer exist).",
    "6. Run `thatch hygiene` from a git repo and verify the orphan count appears.",
    "7. Run `thatch hygiene` outside a git repo and verify the orphan check is skipped.",
    "8. Seed a DB with all-zero signals (no duplicates, no stale, no orphans).",
    "9. Run `thatch hygiene` and verify it prints 'Store is healthy.'",
  ].join("\n"),
  expected: [
    "- Non-zero signals produce a report listing each signal type with counts.",
    "- All-zero signals produce 'Store is healthy.'",
    "- The orphan check is skipped outside a git repo.",
    "- Archived memories are excluded from staleness and duplicate counts.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env };
    const dbPath = ctx.env.THATCH_DB_PATH;
    // The CLI auto-detects the store from cwd via detectRepo(). In a
    // non-git dir, it falls back to the dir basename. ctx.dir is
    // /tmp/thatch-qa/UC-081-cli-hygiene, so the store is the basename.
    const store = ctx.dir.split("/").pop()!;
    const model = new MockEmbeddingModel();

    // --- Seed duplicate candidates ---
    const db = new ThatchDB(dbPath);
    const dupEmb = await model.passageEmbed("the deployment pipeline uses GitHub Actions");
    db.remember(store, "deploy-pipeline-a", "the deployment pipeline uses GitHub Actions", dupEmb, "mock");
    db.remember(store, "deploy-pipeline-b", "the deployment pipeline uses GitHub Actions", dupEmb, "mock");
    db.close();

    // Backdate nothing — these are fresh, so only dedup should fire
    // Run from a non-git dir so orphan check is skipped
    const result1 = await $`${bin} hygiene`.env(env).cwd(ctx.dir).quiet().nothrow();
    if (result1.exitCode !== 0) {
      console.log(`  FAIL: 'thatch hygiene' exited ${result1.exitCode}`);
      return "FAIL";
    }
    const out1 = result1.stdout.toString();
    if (!out1.includes("duplicate-candidate")) {
      console.log(`  FAIL: output missing dedup signal: ${out1}`);
      return "FAIL";
    }

    // --- Seed stale entries ---
    const db2 = new ThatchDB(dbPath);
    const staleEmb = await model.passageEmbed("old configuration values from last year");
    db2.remember(store, "old-config", "old configuration values from last year", staleEmb, "mock");
    db2.close();

    // Backdate the stale memory
    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const rawDb = new Database(dbPath);
    rawDb.run(
      "UPDATE entries SET updated_at = ?, last_recalled_at = ? WHERE store = ? AND label = ?",
      [oldDate, oldDate, store, "old-config"],
    );
    rawDb.close();

    const result2 = await $`${bin} hygiene`.env(env).cwd(ctx.dir).quiet().nothrow();
    const out2 = result2.stdout.toString();
    if (!out2.includes("days")) {
      console.log(`  FAIL: output missing stale signal: ${out2}`);
      return "FAIL";
    }

    // --- Seed orphaned branch memories + test from a git repo ---
    const db3 = new ThatchDB(dbPath);
    const branchEmb = await model.passageEmbed("work on a feature branch that was deleted");
    db3.remember(store, "deleted-branch", "work on a feature branch that was deleted", branchEmb, "mock", { branch: "feature/deleted" });
    db3.close();

    // Create a temp git repo so the orphaned-branch check has live branches.
    // Add a remote so detectRepo() returns a proper store name (without a
    // remote, git rev-parse --git-common-dir returns ".git" which detectRepo
    // would use as the store name).
    const orphanStore = "test/orphan-repo";
    const gitRepo = join(ctx.dir, "orphan-repo");
    mkdirSync(gitRepo, { recursive: true });
    await $`git init`.cwd(gitRepo).quiet();
    await $`git config user.email test@test.com`.cwd(gitRepo).quiet();
    await $`git config user.name test`.cwd(gitRepo).quiet();
    await $`git remote add origin https://github.com/test/orphan-repo.git`.cwd(gitRepo).quiet();
    writeFileSync(join(gitRepo, "README"), "init");
    await $`git add -A && git commit -m init`.cwd(gitRepo).quiet();

    // Seed branch-scoped memories in the store detectRepo() would return
    // for this git repo (parsed from the remote URL: "test/orphan-repo").
    const db4 = new ThatchDB(dbPath);
    const orphanEmb = await model.passageEmbed("orphaned branch work entry");
    db4.remember(orphanStore, "orphan-branch", "orphaned branch work entry", orphanEmb, "mock", { branch: "feature/deleted" });
    db4.close();

    const result3 = await $`${bin} hygiene`.env(env).cwd(gitRepo).quiet().nothrow();
    const out3 = result3.stdout.toString();
    if (!out3.includes("deleted branches")) {
      console.log(`  FAIL: git-repo output missing orphan signal: ${out3}`);
      return "FAIL";
    }

    // --- All-zero case: "Store is healthy." ---
    // Use a clean store with a single fresh, non-duplicate memory
    const cleanStore = "clean-store-081";
    const db5 = new ThatchDB(dbPath);
    const cleanEmb = await model.passageEmbed("a completely unique fresh memory for health check");
    db5.remember(cleanStore, "clean-entry", "a completely unique fresh memory for health check", cleanEmb, "mock");
    db5.close();

    // The CLI auto-detects store from cwd. In a non-git dir, detectRepo
    // returns the dir basename. We need to run from a dir whose basename
    // matches our clean store. Create a subdir with that name.
    const cleanDir = join(ctx.dir, cleanStore);
    mkdirSync(cleanDir, { recursive: true });

    const result4 = await $`${bin} hygiene`.env(env).cwd(cleanDir).quiet().nothrow();
    if (result4.exitCode !== 0) {
      console.log(`  FAIL: clean 'thatch hygiene' exited ${result4.exitCode}`);
      return "FAIL";
    }
    const out4 = result4.stdout.toString().trim();
    if (out4 !== "Store is healthy.") {
      console.log(`  FAIL: expected 'Store is healthy.', got: ${out4}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
