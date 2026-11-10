import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB, MEMORY_HELD_MARKER } from "../../../src/db";

/**
 * UC-144: Forget tombstones (Layer 2 of the memory recursion guard).
 *
 * Automatable: the tombstone write, the hold, and the un-guard are all
 * deterministic over a controlled DB. Covers the incident's unstamped
 * arm end to end (save -> unstamped display of the content -> forget ->
 * the re-derivation mint is HELD, surfaced, and saves nothing), the
 * `thatch tombstones` listing and clear, the un-guard-then-save flow,
 * overwrite non-bypass, store scoping, and the no-op double-forget.
 */

const useCase: UseCase = {
  name: "UC-144-forget-tombstones",
  preconditions: [
    "- Bun on PATH (the test runs the repo binary directly)",
    "- A fixture repo with a git origin remote, so the default store is detected",
  ].join("\n"),
  steps: [
    "1. Save a memory; display its content through an UNSTAMPED surface (the residual class: quoted content in an ordinary output); forget the memory.",
    "2. Attempt the re-derivation mint (`thatch remember` with the same content); verify it is HELD: exit 1, stderr begins with [held], the message names the deleted memory's label, date, and the un-guard command, and nothing was saved.",
    "3. Verify `thatch tombstones [store]` lists the standing guard (label, date, hash prefix) and that a second forget of the same label is a clean no-op (the guard stays, no duplicate row).",
    "4. Verify the un-guard: `thatch tombstones --clear <label> <store>` prints [tombstone-cleared] with the entries-untouched note; repeating the original remember then SAVES.",
    "5. Verify a re-created entry with genuinely different content saves normally (no hold); verify `--overwrite` of matching content is still held; verify a global-store guard does not hold a project-store write.",
  ].join("\n"),
  expected: [
    "- A held write is neither saved nor silently dropped: the [held] message surfaces the guard, names the un-guard command, and contains no [saved] marker anywhere (the MCP drain gate is inclusion-based).",
    "- The tombstone survives the refused write intact; nothing but the deliberate CLI clear removes it.",
    "- `thatch tombstones --clear` removes the guard and never touches entries; the repeat remember then saves.",
    "- The guard is on content: overwrite cannot bypass it, and different content passes; it is store-scoped like every other memory surface.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(env).cwd(ctx.dir).quiet().nothrow();
    const body = "uc143 guarded body unique phrase";

    // 1. The incident's unstamped arm: the memory's content rides an
    // ordinary (unstamped) output - the residual class the tombstone
    // backstop exists for - and the forget follows.
    const save = await run(["remember", body, "--label", "uc143-memory"]);
    if (save.exitCode !== 0) {
      console.log(`  FAIL: save exited ${save.exitCode}:\n${save.stderr.toString()}`);
      return "FAIL";
    }
    const forget = await run(["forget", "uc143-memory"]);
    if (forget.exitCode !== 0 || !forget.stdout.toString().includes("[forgotten]")) {
      console.log(`  FAIL: forget failed:\n${forget.stdout.toString()}`);
      return "FAIL";
    }

    // 2. The re-derivation mint is held: exit 1, the [held] message on
    // stderr (after the CLI's model-load note), nothing saved, the guard
    // intact.
    const mint = await run(["remember", body, "--label", "uc143-echo"]);
    const mintErr = mint.stderr.toString();
    if (mint.exitCode !== 1 || !mintErr.includes(MEMORY_HELD_MARKER)) {
      console.log(`  FAIL: the mint should be held with exit 1:\n${mintErr}`);
      return "FAIL";
    }
    if (!mintErr.includes('label "uc143-memory"') || !mintErr.includes("deliberately deleted on")) {
      console.log(`  FAIL: held message must name the guard:\n${mintErr}`);
      return "FAIL";
    }
    if (!mintErr.includes("thatch tombstones --clear uc143-memory test-org/test-repo")) {
      console.log(`  FAIL: held message must name the un-guard command:\n${mintErr}`);
      return "FAIL";
    }
    // The MCP queue's drain gate is inclusion-based: no [saved] token
    // anywhere in the message, or a wording tweak would someday drain a
    // queue on a write that never happened.
    if (mintErr.includes("[saved]")) {
      console.log(`  FAIL: held message contains the save marker:\n${mintErr}`);
      return "FAIL";
    }
    const raw = new ThatchDB(env.THATCH_DB_PATH);
    const afterMint = raw.showEntry("test-org/test-repo", "uc143-echo");
    const guardsAfterMint = raw.listMemoryTombstones("test-org/test-repo");
    raw.close();
    if (afterMint !== null) {
      console.log("  FAIL: the held mint was saved anyway");
      return "FAIL";
    }
    if (guardsAfterMint.length !== 1 || guardsAfterMint[0].label !== "uc143-memory") {
      console.log(`  FAIL: guard not intact after the hold:\n${JSON.stringify(guardsAfterMint)}`);
      return "FAIL";
    }

    // 3. The listing and the no-op double-forget.
    const listed = await run(["tombstones"]);
    const listOut = listed.stdout.toString();
    if (listed.exitCode !== 0 || !listOut.includes("uc143-memory") || !listOut.includes("forgotten 20")) {
      console.log(`  FAIL: tombstones listing:\n${listOut}`);
      return "FAIL";
    }
    const refetch = await run(["forget", "uc143-memory"]);
    if (refetch.exitCode !== 0 || refetch.stdout.toString().includes("[forgotten]")) {
      console.log(`  FAIL: sequential double-forget should be a clean no-op:\n${refetch.stdout.toString()}`);
      return "FAIL";
    }
    const raw2 = new ThatchDB(env.THATCH_DB_PATH);
    const guardsAfterRefetch = raw2.listMemoryTombstones("test-org/test-repo");
    raw2.close();
    if (guardsAfterRefetch.length !== 1) {
      console.log(`  FAIL: no-op forget changed the guard set:\n${JSON.stringify(guardsAfterRefetch)}`);
      return "FAIL";
    }

    // 4. The un-guard: clear, then the repeat remember saves.
    const clear = await run(["tombstones", "--clear", "uc143-memory", "test-org/test-repo"]);
    const clearOut = clear.stdout.toString();
    if (clear.exitCode !== 0 || !clearOut.includes("[tombstone-cleared] test-org/test-repo :: uc143-memory")) {
      console.log(`  FAIL: clear output:\n${clearOut}`);
      return "FAIL";
    }
    if (!clearOut.includes("entries untouched")) {
      console.log(`  FAIL: clear must note entries are untouched:\n${clearOut}`);
      return "FAIL";
    }
    const readmit = await run(["remember", body, "--label", "uc143-memory"]);
    if (readmit.exitCode !== 0 || !readmit.stdout.toString().startsWith("[saved]")) {
      console.log(`  FAIL: repeat remember after clear should save:\n${readmit.stdout.toString()}\n${readmit.stderr.toString()}`);
      return "FAIL";
    }
    const clearMiss = await run(["tombstones", "--clear", "uc143-memory", "test-org/test-repo"]);
    if (clearMiss.exitCode !== 0 || !clearMiss.stdout.toString().includes("No tombstone")) {
      console.log(`  FAIL: clearing a cleared guard should report nothing to clear:\n${clearMiss.stdout.toString()}`);
      return "FAIL";
    }

    // 5. Threshold, store scoping, and overwrite.
    // Genuinely different content passes the guard.
    const different = await run(["remember", "a genuinely different body about another topic", "--label", "uc143-different"]);
    if (different.exitCode !== 0 || !different.stdout.toString().startsWith("[saved]")) {
      console.log(`  FAIL: different content should save:\n${different.stdout.toString()}\n${different.stderr.toString()}`);
      return "FAIL";
    }
    // Store scoping: a guard in the global store holds global writes only
    // - the same content saves into the project store (the store-scoping
    // residual, by design). Runs BEFORE the project-store guard below so
    // only the global guard stands.
    const globalSave = $`echo ${body} | bun ${bin} remember --label uc143-global --store global`
      .env(env).cwd(ctx.dir).quiet().nothrow();
    if ((await globalSave).exitCode !== 0) {
      console.log(`  FAIL: global save failed:\n${(await globalSave).stderr.toString()}`);
      return "FAIL";
    }
    await run(["forget", "uc143-global", "global"]);
    const globalMint = $`echo ${body} | bun ${bin} remember --label uc143-global-echo --store global`
      .env(env).cwd(ctx.dir).quiet().nothrow();
    if ((await globalMint).exitCode !== 1 || !(await globalMint).stderr.toString().includes(MEMORY_HELD_MARKER)) {
      console.log(`  FAIL: global guard should hold the global echo:\n${(await globalMint).stderr.toString()}`);
      return "FAIL";
    }
    if (!(await globalMint).stderr.toString().includes("thatch tombstones --clear uc143-global global")) {
      console.log(`  FAIL: global held message must name the global un-guard:\n${(await globalMint).stderr.toString()}`);
      return "FAIL";
    }
    const crossStore = await run(["remember", body, "--label", "uc143-cross"]);
    if (crossStore.exitCode !== 0 || !crossStore.stdout.toString().startsWith("[saved]")) {
      console.log(`  FAIL: cross-store write should save (store scoping):\n${crossStore.stdout.toString()}\n${crossStore.stderr.toString()}`);
      return "FAIL";
    }
    // Overwrite of matching content is still held: the guard is on
    // content, not labels. A fresh project-store guard for the body; the
    // live uc143-different entry must survive the refused write
    // untouched.
    await run(["remember", body, "--label", "uc143-overwrite-src"]);
    await run(["forget", "uc143-overwrite-src"]);
    const overwrite = await run(["remember", body, "--label", "uc143-different", "--overwrite"]);
    if (overwrite.exitCode !== 1 || !overwrite.stderr.toString().includes(MEMORY_HELD_MARKER)) {
      console.log(`  FAIL: overwrite of guarded content must be held:\n${overwrite.stderr.toString()}`);
      return "FAIL";
    }
    const differentShow = await run(["show", "uc143-different"]);
    if (!differentShow.stdout.toString().includes("a genuinely different body about another topic")) {
      console.log(`  FAIL: the refused overwrite must not touch the live entry:\n${differentShow.stdout.toString()}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
