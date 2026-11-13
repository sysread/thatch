import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { ThatchDB } from "../src/db";
import { hygieneReport } from "../src/index";
import { sessionStartReminder } from "../src/prompts";

let dir: string;
let db: ThatchDB;
let dbPath: string;
const repo = "test-owner/test-repo";
const emb = new Float32Array(4).fill(0.5);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thatch-hygiene-test-"));
  dbPath = join(dir, "test.db");
  db = new ThatchDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function gitInit(cwd: string, branches: string[]): Promise<void> {
  await $`git init`.cwd(cwd).quiet();
  await $`git config user.email test@example.com`.cwd(cwd).quiet();
  await $`git config user.name Test`.cwd(cwd).quiet();
  await $`git commit --allow-empty -m init`.cwd(cwd).quiet();
  for (const b of branches) {
    await $`git branch ${b}`.cwd(cwd).quiet();
  }
}

describe("hygieneReport", () => {
  test("healthy store reports nothing", async () => {
    db.remember(repo, "fresh", "content", emb, "m");
    expect(await hygieneReport(db, repo, dir)).toBeNull();
  });

  test("counts duplicate-candidate pairs", async () => {
    db.remember(repo, "dup-a", "content", emb, "m");
    db.remember(repo, "dup-b", "content", emb, "m");

    const report = await hygieneReport(db, repo, dir);
    expect(report).toContain("1 duplicate-candidate pair pending review");
  });

  test("counts prediction duplicate pairs", async () => {
    const reworded = new Float32Array(emb);
    reworded[0] += 0.001;
    db.createPrediction(repo, "prefer minimal diffs", "", emb, "m");
    db.createPrediction(repo, "prefer small diffs", "", reworded, "m");

    const report = await hygieneReport(db, repo, dir);
    expect(report).toContain("1 prediction duplicate pair pending review");
  });

  test("prediction duplicate line names the pair ids when few", async () => {
    // The nudge -> verdict loop needs the pair ids; naming them inline
    // closes it without a listing call (prediction_find_duplicates for
    // the full list). The scan orders rows by id, so the pair renders
    // in sorted order, not creation order.
    const reworded = new Float32Array(emb);
    reworded[0] += 0.001;
    const idA = db.createPrediction(repo, "prefer minimal diffs", "", emb, "m");
    const idB = db.createPrediction(repo, "prefer small diffs", "", reworded, "m");

    const report = await hygieneReport(db, repo, dir);
    const pair = [idA, idB].sort().join(", ");
    expect(report).toContain(`1 prediction duplicate pair pending review: (${pair})`);
  });

  test("prediction duplicate line keeps the count only past the id cap", async () => {
    // Four rows sharing one embedding pair up six ways - past the cap the
    // ids would crowd out the line, so the count stands alone.
    const ids = ["a", "b", "c", "d"].map((s) =>
      db.createPrediction(repo, `prefer ${s} diffs`, "", emb, "m"));
    expect(db.findPredictionDuplicates(repo).length).toBe(6);

    const report = await hygieneReport(db, repo, dir);
    expect(report).toContain("6 prediction duplicate pairs pending review");
    for (const id of ids) {
      expect(report).not.toContain(id);
    }
  });

  test("counts stale memories", async () => {
    db.remember(repo, "ancient", "content", emb, "m");
    const raw = new Database(dbPath);
    raw.run("UPDATE entries SET updated_at = '2000-01-01T00:00:00Z'");
    raw.close();

    const report = await hygieneReport(db, repo, dir);
    expect(report).toContain("1 memory neither updated nor recalled in 90+ days");
  });

  test("counts memories scoped to deleted branches", async () => {
    await gitInit(dir, ["feature/live"]);
    db.remember(repo, "alive", "content", emb, "m", { branch: "feature/live" });
    db.remember(repo, "orphan-1", "content", new Float32Array([1, 0, 0, 0]), "m", { branch: "feature/dead" });

    const report = await hygieneReport(db, repo, dir);
    expect(report).toContain("scoped to deleted branches (feature/dead)");
    expect(report).not.toContain("feature/live");
  });

  test("fully-archived branches stay out of the orphaned list", async () => {
    await gitInit(dir, ["feature/live"]);
    db.remember(repo, "alive", "content", emb, "m", { branch: "feature/live" });
    db.remember(repo, "orphan-1", "content", new Float32Array([1, 0, 0, 0]), "m", { branch: "feature/dead" });
    // feature/gone is deleted AND every entry on it is archived: it must not
    // appear by name, and the count must cover only feature/dead.
    db.remember(repo, "orphan-archived", "content", new Float32Array([0, 1, 0, 0]), "m", {
      branch: "feature/gone",
      archived: true,
    });

    const report = await hygieneReport(db, repo, dir);
    expect(report).toContain("1 memory scoped to deleted branches (feature/dead)");
    expect(report).not.toContain("feature/gone");
    expect(report).not.toContain("feature/live");
  });

  test("branches that exist only on a remote are not orphaned", async () => {
    await gitInit(dir, ["feature/local"]);
    // feature/pr-open exists only as a remote-tracking ref: pushed, PR open,
    // no local checkout. listBranches must see it, or the memory gets
    // false-flagged as scoped to a deleted branch.
    await $`git update-ref refs/remotes/origin/feature/pr-open HEAD`.cwd(dir).quiet();
    db.remember(repo, "pr-open", "content", emb, "m", { branch: "feature/pr-open" });

    const report = await hygieneReport(db, repo, dir);
    expect(report).toBeNull();
  });

  test("skips the branch check outside a git repo", async () => {
    db.remember(repo, "scoped", "content", emb, "m", { branch: "feature/anything" });
    // dir is not a git repo → listBranches returns [] → check must not run,
    // otherwise every scoped memory would be reported as orphaned.
    const report = await hygieneReport(db, repo, dir);
    expect(report ?? "").not.toContain("deleted branches");
  });
});

describe("sessionStartReminder hygiene block", () => {
  test("appends the hygiene report when present", () => {
    const text = sessionStartReminder(repo, 'Store "x": 2 duplicate-candidate pairs pending review.');
    expect(text).toContain("[thatch hygiene]");
    expect(text).toContain("2 duplicate-candidate pairs");
    expect(text).toContain("thatch_find_duplicates");
  });

  test("omits the block when hygiene is null", () => {
    const text = sessionStartReminder(repo, null);
    expect(text).not.toContain("[thatch hygiene]");
  });

  test("single-arg call remains valid", () => {
    const text = sessionStartReminder(repo);
    expect(text).toContain(repo);
    expect(text).not.toContain("[thatch hygiene]");
  });
});
