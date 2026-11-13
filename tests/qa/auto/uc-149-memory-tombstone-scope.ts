import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB, MEMORY_HELD_MARKER } from "../../../src/db";

/**
 * UC-149: Tombstone guard scope - creation only.
 *
 * The November 2026 scope inversion: the deletion guard policed every
 * write path and, on overwrites, its only observable effect was holding
 * legitimate corrections of live siblings whose content sat near a
 * deleted near-duplicate. It now governs entry creation only. This case
 * pins the three arms end to end over the CLI: an overwrite onto a live
 * row passes with the guards standing (no silent clearing - the CLI
 * un-guard is the only clear), an overwrite onto an absent label is a
 * creation and is held, and the guards survive both writes untouched.
 */

const useCase: UseCase = {
  name: "UC-149-memory-tombstone-scope",
  preconditions: [
    "- Bun on PATH (the test runs the repo binary directly)",
    "- A fixture repo with a git origin remote, so the default store is detected",
  ].join("\n"),
  steps: [
    "1. Save a keeper and a near-duplicate of it (same body, different labels); forget the duplicate so its guard stands.",
    "2. Overwrite the live keeper with the same body: it must SAVE (an update, not a creation), and the guard must remain standing afterward.",
    "3. Save a second memory and forget it (a second guard), then re-save its body with --overwrite under its now-absent label: an overwrite onto no live row is a creation and must be HELD.",
    "4. Verify the guard set is untouched by both writes - only the CLI clear removes guards - and the held write saved nothing.",
  ].join("\n"),
  expected: [
    "- An overwrite resolving to a live entry bypasses the tombstone guard: the write saves and the live entry's content is replaced.",
    "- The bypass never clears guards: tombstones stand until `thatch tombstones --clear` removes them.",
    "- An overwrite onto an absent label is a creation: matching content is held with the surfaced [held] message and nothing is saved.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const store = "test-org/test-repo";
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(env).cwd(ctx.dir).quiet().nothrow();
    const body = "uc149 shared body unique phrase";
    const guardCount = () => {
      const raw = new ThatchDB(env.THATCH_DB_PATH);
      const n = raw.listMemoryTombstones(store).length;
      raw.close();
      return n;
    };

    // 1. The collateral setup: a live keeper plus a deleted
    // near-duplicate whose guard sits in the keeper's content
    // neighborhood.
    const saveKeeper = await run(["remember", body, "--label", "uc149-keeper"]);
    if (saveKeeper.exitCode !== 0 || !saveKeeper.stdout.toString().startsWith("[saved]")) {
      console.log(`  FAIL: keeper save failed:\n${saveKeeper.stdout.toString()}\n${saveKeeper.stderr.toString()}`);
      return "FAIL";
    }
    const saveDup = await run(["remember", body, "--label", "uc149-dup"]);
    if (saveDup.exitCode !== 0) {
      console.log(`  FAIL: duplicate save failed:\n${saveDup.stderr.toString()}`);
      return "FAIL";
    }
    const forgetDup = await run(["forget", "uc149-dup"]);
    if (forgetDup.exitCode !== 0 || !forgetDup.stdout.toString().includes("[forgotten]")) {
      console.log(`  FAIL: duplicate forget failed:\n${forgetDup.stdout.toString()}`);
      return "FAIL";
    }
    if (guardCount() !== 1) {
      console.log(`  FAIL: expected one standing guard after the forget, saw ${guardCount()}`);
      return "FAIL";
    }

    // 2. The bypass: the same guarded body overwrites the LIVE keeper
    // and must save - an update cannot resurrect the deleted duplicate.
    const overwrite = await run(["remember", body, "--label", "uc149-keeper", "--overwrite"]);
    if (overwrite.exitCode !== 0 || !overwrite.stdout.toString().startsWith("[saved]")) {
      console.log(`  FAIL: overwrite onto a live entry must save (guard is create-only):\n${overwrite.stdout.toString()}\n${overwrite.stderr.toString()}`);
      return "FAIL";
    }
    const keeperShow = await run(["show", "uc149-keeper"]);
    if (!keeperShow.stdout.toString().includes(body)) {
      console.log(`  FAIL: the overwrite must replace the live entry's content:\n${keeperShow.stdout.toString()}`);
      return "FAIL";
    }
    // No silent clearing: the guard the write tripped still stands.
    if (guardCount() !== 1) {
      console.log(`  FAIL: the bypass must not clear guards, saw ${guardCount()}`);
      return "FAIL";
    }

    // 3. The creation arm with the overwrite flag: the label has no
    // live entry, so the write is a creation and the guard holds it.
    const saveGone = await run(["remember", "uc149 gone body second phrase", "--label", "uc149-gone"]);
    if (saveGone.exitCode !== 0) {
      console.log(`  FAIL: second save failed:\n${saveGone.stderr.toString()}`);
      return "FAIL";
    }
    const forgetGone = await run(["forget", "uc149-gone"]);
    if (forgetGone.exitCode !== 0 || !forgetGone.stdout.toString().includes("[forgotten]")) {
      console.log(`  FAIL: second forget failed:\n${forgetGone.stdout.toString()}`);
      return "FAIL";
    }
    if (guardCount() !== 2) {
      console.log(`  FAIL: expected two standing guards, saw ${guardCount()}`);
      return "FAIL";
    }
    const resave = await run(["remember", "uc149 gone body second phrase", "--label", "uc149-gone", "--overwrite"]);
    const resaveErr = resave.stderr.toString();
    if (resave.exitCode !== 1 || !resaveErr.includes(MEMORY_HELD_MARKER)) {
      console.log(`  FAIL: an overwrite onto an absent label is a creation and must be held:\n${resaveErr}`);
      return "FAIL";
    }

    // 4. The guards survived both writes; the held write saved nothing.
    if (guardCount() !== 2) {
      console.log(`  FAIL: the held creation must not change the guard set, saw ${guardCount()}`);
      return "FAIL";
    }
    const raw = new ThatchDB(env.THATCH_DB_PATH);
    const savedAnyway = raw.entryExists(store, raw.slugify("uc149-gone"));
    raw.close();
    if (savedAnyway) {
      console.log("  FAIL: the held creation was saved anyway");
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
