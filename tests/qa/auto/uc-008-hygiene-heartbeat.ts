import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { hygieneReport } from "../../../src/hygiene";

/**
 * UC-008: Hygiene heartbeat.
 *
 * Automatable: `thatch hygiene` calls hygieneReport(), a pure function over
 * the DB and git state. Seeds all three signal types (dedup pairs, stale
 * memories, orphaned branches), then verifies the report both via direct
 * calls and the CLI. The non-git-directory case verifies the branch check
 * is skipped (listBranches returns [] outside a repo).
 */

const useCase: UseCase = {
  name: "UC-008-hygiene-heartbeat",
  preconditions: [
    "- A store with: one memory not updated or recalled in 90+ days; one memory scoped to a git branch that no longer exists; two near-duplicate memories (similarity > 0.85)",
    "- A second, clean store for the negative case",
  ].join("\n"),
  steps: [
    "1. `thatch hygiene` (from the repo)",
    "2. `thatch reminder` (Claude Code hook shape) and `thatch reminder --json` (Cursor)",
    "3. Start an opencode session and a Claude Code / Cursor session (the session-start path)",
    "4. Run the same commands from a directory that is **not** a git repo",
  ].join("\n"),
  expected: [
    '- The report names three signals — pending duplicate pairs, stale-memory count, orphaned-branch memory count — and **only the non-zero ones**. A fully healthy store prints "Store is healthy." (or `null`) and the reminder omits the hygiene block entirely.',
    "- Both `reminder` shapes fold the hygiene block into the session-start text only when it is non-null.",
    "- Outside a git repo, the orphaned-branch check is **skipped** — a missing branch list would otherwise make everything look orphaned; stale and dup signals still report.",
    "- Signals are advisory: thatch never deletes or merges memories itself. The agent acts on the nudge to fix the store, by the same `memory_forget` / `dedup_mark_checked` tools as UC-002.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env };
    const dbPath = ctx.env.THATCH_DB_PATH;
    const store = "test-hygiene";
    const model = new MockEmbeddingModel();

    // --- Seed the DB with all three signal types ---

    const db = new ThatchDB(dbPath);

    // Two identical memories: same text → same embedding → cosine 1.0,
    // which is above the 0.85 dedup threshold.
    const dupEmb = await model.passageEmbed("the API rate limit is 100 requests per minute");
    db.remember(store, "api-rate-limit", "the API rate limit is 100 req/min", dupEmb, "mock");
    db.remember(store, "api-rate-limit-v2", "the API rate limit is 100 req/min", dupEmb, "mock");

    // A memory that will be backdated to be stale (see raw SQL below).
    const staleEmb = await model.passageEmbed("old database connection settings");
    db.remember(store, "old-db-config", "old database connection settings", staleEmb, "mock");

    // A memory scoped to a branch that does not exist in any live repo.
    const branchEmb = await model.passageEmbed("work done on a deleted feature branch");
    db.remember(store, "deleted-branch-work", "work done on a deleted feature branch", branchEmb, "mock", { branch: "feature/deleted" });

    db.close();

    // Backdate the stale memory's timestamps to 100 days ago. ThatchDB.remember
    // always stamps updated_at = now(), so we update it post-save via a raw
    // SQLite connection. staleEntryCount checks max(updated_at,
    // COALESCE(last_recalled_at, updated_at)) < cutoff (90 days ago).
    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const rawDb = new Database(dbPath);
    rawDb.run(
      "UPDATE entries SET updated_at = ?, last_recalled_at = ? WHERE store = ? AND label = ?",
      [oldDate, oldDate, store, "old-db-config"],
    );
    rawDb.close();

    // --- Test 1: All three signals fire from a real git repo ---
    // Create a temp git repo with a known branch so the orphaned-branch
    // check has live branches to compare against. In CI, the checked-out
    // repo has a detached HEAD with no local branches, so listBranches
    // returns [] and the hygiene code correctly skips the orphaned check.
    // Using a dedicated repo makes the test deterministic.
    const gitRepo = join(ctx.dir, "git-repo");
    mkdirSync(gitRepo, { recursive: true });
    await $`git init`.cwd(gitRepo).quiet();
    await $`git config user.email test@test.com`.cwd(gitRepo).quiet();
    await $`git config user.name test`.cwd(gitRepo).quiet();
    writeFileSync(join(gitRepo, "README"), "init");
    await $`git add -A && git commit -m init`.cwd(gitRepo).quiet();

    const db1 = new ThatchDB(dbPath);
    const report1 = await hygieneReport(db1, store, gitRepo);
    db1.close();

    if (!report1) {
      console.log("  FAIL: hygieneReport from git repo returned null (expected all three signals)");
      return "FAIL";
    }
    if (!report1.includes("duplicate-candidate")) {
      console.log(`  FAIL: report missing dedup signal: ${report1}`);
      return "FAIL";
    }
    if (!report1.includes("days")) {
      console.log(`  FAIL: report missing stale signal: ${report1}`);
      return "FAIL";
    }
    if (!report1.includes("deleted branches")) {
      console.log(`  FAIL: report missing orphaned-branch signal: ${report1}`);
      return "FAIL";
    }

    // --- Test 2: Branch check is skipped outside a git repo ---
    // ctx.dir is now a git repo (createFixture runs git init).
    // Use a temp dir OUTSIDE ctx.dir so listBranches can't walk up
    // to ctx.dir's .git. hygieneReport skips the orphaned-branch
    // check to avoid false positives. Dedup and stale signals still appear.
    const nonGitDir = join(tmpdir(), "thatch-qa-nogit");
    mkdirSync(nonGitDir, { recursive: true });
    const db2 = new ThatchDB(dbPath);
    const report2 = await hygieneReport(db2, store, nonGitDir);
    db2.close();

    if (!report2) {
      console.log("  FAIL: hygieneReport from non-git dir returned null (expected dedup + stale)");
      return "FAIL";
    }
    if (!report2.includes("duplicate-candidate")) {
      console.log(`  FAIL: non-git report missing dedup signal: ${report2}`);
      return "FAIL";
    }
    if (!report2.includes("days")) {
      console.log(`  FAIL: non-git report missing stale signal: ${report2}`);
      return "FAIL";
    }
    if (report2.includes("deleted branches")) {
      console.log(`  FAIL: non-git report should NOT contain orphaned-branch signal: ${report2}`);
      return "FAIL";
    }

    // --- Test 3: CLI `thatch hygiene` runs without error ---

    // The CLI auto-detects the store from cwd. In a non-git dir it returns
    // the dir basename. We seed that store with a single fresh, non-stale,
    // non-duplicate memory so the CLI should print "Store is healthy."
    const cliStore = ctx.dir.split("/").pop()!;
    const db3 = new ThatchDB(dbPath);
    const cliEmb = await model.passageEmbed("a unique cli test memory");
    db3.remember(cliStore, "cli-test", "a unique cli test memory", cliEmb, "mock");
    db3.close();

    const cliResult = await $`${bin} hygiene`.env(env).cwd(ctx.dir).quiet().nothrow();
    if (cliResult.exitCode !== 0) {
      console.log(`  FAIL: 'thatch hygiene' exited ${cliResult.exitCode}`);
      return "FAIL";
    }
    const cliOut = cliResult.stdout.toString().trim();
    if (cliOut !== "Store is healthy.") {
      console.log(`  FAIL: expected 'Store is healthy.', got: ${cliOut}`);
      return "FAIL";
    }

    // --- Test 4: A store with no entries returns null (healthy) ---

    const db4 = new ThatchDB(dbPath);
    const healthyReport = await hygieneReport(db4, "global", nonGitDir);
    db4.close();

    if (healthyReport !== null) {
      console.log(`  FAIL: healthy store should return null, got: ${healthyReport}`);
      return "FAIL";
    }

    // Clean up the non-git temp dir.
    rmSync(nonGitDir, { recursive: true, force: true });

    return "PASS";
  },
};

registerUseCase(useCase);
