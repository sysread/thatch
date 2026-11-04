import { $ } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../../src/db";

/**
 * UC-131: CLI memory write (`thatch remember`).
 *
 * Automatable: the write path is the memory_remember tool's execute()
 * behind shell parsing, over a controlled DB. Runs the real CLI in the
 * fixture repo (origin test-org/test-repo, so the default store is
 * detected): derived label, --label/--branch/--confidence flags, piped
 * stdin, --store global, the tool's overwrite-without-branch gotcha
 * (the scope survives), an 8KB stdin body (the old long-content failure
 * class), the write-time similarity warning, and the failure paths
 * (duplicate label, bad confidence, unknown flag, no content) exiting 1.
 */

const useCase: UseCase = {
  name: "UC-131-cli-memory-write",
  preconditions: [
    "- Bun on PATH (the test runs the repo binary directly)",
    "- A fixture repo with a git origin remote, so the default store is detected",
  ].join("\n"),
  steps: [
    "1. Run `thatch remember \"<text>\"` with no label and verify the save confirmation on stdout: it starts with [saved] test-org/test-repo :: (the derived label), and the model-load note stays on stderr.",
    "2. Verify with `thatch show` that the entry landed in the default (project) store with the derived label.",
    "3. Pipe content on stdin with --label, --branch, and --confidence; verify [saved] and that `thatch show` reports the branch and confidence.",
    "4. Run with --store global and verify the entry lands in the global store.",
    "5. Re-save the branch-scoped label with --overwrite but NO --branch; verify the save succeeds and the entry is STILL branch-scoped (the tool's gotcha, not CLI magic).",
    "6. Pipe an 8KB body; verify the save and that the stored content is intact.",
    "7. Save the same body under two labels; verify the second output carries the write-time semantically-similar warning and still exits 0.",
    "8. Failure paths: a duplicate label without --overwrite, a bad --confidence, an unknown flag, and a no-content run (stdin: ignore) each exit 1 with a plain error.",
  ].join("\n"),
  expected: [
    "- Success prints the tool's confirmation ([saved] <store> :: <label>) on stdout, one clean line scripts can parse; the embedding-model note goes to stderr.",
    "- Without --label, the label derives from the content's first line; without --store, the write lands in the cwd repo's project store (test-org/test-repo).",
    "- --branch and --confidence land on the entry exactly as the tool would store them; --store global targets the global store.",
    "- Overwriting a branch-scoped entry without --branch preserves the branch scope - identical to the memory_remember tool, and exit 0 either way.",
    "- An 8KB piped body saves whole: no client-side long-content failure.",
    "- A semantically similar write still saves (exit 0) and appends the similarity warning after the [saved] line.",
    "- Every failure exits 1 with a plain stderr message and no stack trace.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(env).cwd(ctx.dir).quiet().nothrow();

    // 1. Default store detection + derived label. Stdout must be the one
    // parseable confirmation line; the model note belongs on stderr.
    const smoke = await run(["remember", "cli remember smoke test body"]);
    if (smoke.exitCode !== 0) {
      console.log(`  FAIL: smoke save exited ${smoke.exitCode}:\n${smoke.stderr.toString()}`);
      return "FAIL";
    }
    const smokeOut = smoke.stdout.toString();
    if (!smokeOut.startsWith("[saved] test-org/test-repo :: cli remember smoke test body")) {
      console.log(`  FAIL: unexpected save confirmation:\n${smokeOut}`);
      return "FAIL";
    }
    if (smokeOut.includes("Loading embedding model")) {
      console.log(`  FAIL: model-load note leaked to stdout:\n${smokeOut}`);
      return "FAIL";
    }

    // 2. The entry is readable through the ordinary CLI surface.
    const show = await run(["show", "cli remember smoke test body"]);
    if (show.exitCode !== 0 || !show.stdout.toString().includes("cli remember smoke test body")) {
      console.log(`  FAIL: show after derived-label save:\n${show.stdout.toString()}\n${show.stderr.toString()}`);
      return "FAIL";
    }

    // 3. Flags: explicit label, branch scope, confidence.
    const flagged = $`echo "piped memory body" | bun ${bin} remember --label piped-memory --branch topic-branch --confidence 3`
      .env(env).cwd(ctx.dir).quiet().nothrow();
    const flaggedOut = (await flagged).stdout.toString();
    if ((await flagged).exitCode !== 0 || !flaggedOut.startsWith("[saved] test-org/test-repo :: piped-memory")) {
      console.log(`  FAIL: flagged save:\n${flaggedOut}\n${(await flagged).stderr.toString()}`);
      return "FAIL";
    }
    const flaggedShow = await run(["show", "piped-memory"]);
    const flaggedText = flaggedShow.stdout.toString();
    if (!flaggedText.includes("branch: topic-branch") || !flaggedText.includes("confidence: 3")) {
      console.log(`  FAIL: branch/confidence not stored:\n${flaggedText}`);
      return "FAIL";
    }

    // 4. --store global targets the global store.
    const global = $`echo "global store body" | bun ${bin} remember --label global-cli-memory --store global`
      .env(env).cwd(ctx.dir).quiet().nothrow();
    const globalOut = (await global).stdout.toString();
    if ((await global).exitCode !== 0 || !globalOut.startsWith("[saved] global :: global-cli-memory")) {
      console.log(`  FAIL: --store global save:\n${globalOut}\n${(await global).stderr.toString()}`);
      return "FAIL";
    }

    // 5. The overwrite gotcha: overwrite WITHOUT --branch keeps the
    // existing branch scope, exactly like the tool.
    const overwrite = $`echo "rewritten body" | bun ${bin} remember --label piped-memory --overwrite`
      .env(env).cwd(ctx.dir).quiet().nothrow();
    if ((await overwrite).exitCode !== 0) {
      console.log(`  FAIL: overwrite save exited ${(await overwrite).exitCode}:\n${(await overwrite).stderr.toString()}`);
      return "FAIL";
    }
    const afterOverwrite = await run(["show", "piped-memory"]);
    if (!afterOverwrite.stdout.toString().includes("branch: topic-branch")) {
      console.log(`  FAIL: overwrite without --branch should keep the branch scope:\n${afterOverwrite.stdout.toString()}`);
      return "FAIL";
    }

    // 6. Long content through stdin: the old ~1400-char client-side
    // failure class must not bite the CLI path.
    const longBody = `# Long cli memory\n\n${"word ".repeat(1600).trim()}`;
    const longFile = join(ctx.dir, "long-body.txt");
    writeFileSync(longFile, longBody);
    const long = $`cat ${longFile} | bun ${bin} remember --label long-body`
      .env(env).cwd(ctx.dir).quiet().nothrow();
    if ((await long).exitCode !== 0 || !(await long).stdout.toString().startsWith("[saved]")) {
      console.log(`  FAIL: 8KB stdin save:\n${(await long).stdout.toString()}\n${(await long).stderr.toString()}`);
      return "FAIL";
    }
    const raw = new ThatchDB(env.THATCH_DB_PATH);
    const stored = raw.showEntry("test-org/test-repo", "long-body");
    raw.close();
    if (!stored || !stored.content.includes(longBody.split("\n")[1].slice(0, 40)) || stored.content.length < longBody.length) {
      console.log(`  FAIL: long body not stored intact (stored ${stored?.content.length ?? 0} chars)`);
      return "FAIL";
    }

    // 7. The write-time similarity warning rides AFTER the [saved] line,
    // and the save still succeeds.
    await run(["remember", "semantic similarity probe body"]);
    const similar = await run(["remember", "semantic similarity probe body", "--label", "similar-probe-2"]);
    if (similar.exitCode !== 0) {
      console.log(`  FAIL: similar save exited ${similar.exitCode}:\n${similar.stderr.toString()}`);
      return "FAIL";
    }
    const similarOut = similar.stdout.toString();
    if (!similarOut.startsWith("[saved]") || !similarOut.includes("semantically similar")) {
      console.log(`  FAIL: expected [saved] plus similarity warning:\n${similarOut}`);
      return "FAIL";
    }

    // 8. Failure paths: exit 1, plain stderr, no stack trace.
    const dup = await run(["remember", "another body", "--label", "piped-memory"]);
    if (dup.exitCode !== 1 || !dup.stderr.toString().includes("already exists")) {
      console.log(`  FAIL: duplicate label should exit 1:\n${dup.stdout.toString()}\n${dup.stderr.toString()}`);
      return "FAIL";
    }
    const badConf = await run(["remember", "body", "--confidence", "high"]);
    if (badConf.exitCode !== 1 || !badConf.stderr.toString().includes("--confidence expects an integer 1-10")) {
      console.log(`  FAIL: bad confidence should exit 1:\n${badConf.stderr.toString()}`);
      return "FAIL";
    }
    const unknown = await run(["remember", "body", "--prjoect", "x"]);
    if (unknown.exitCode !== 1 || !unknown.stderr.toString().includes("unknown flag")) {
      console.log(`  FAIL: unknown flag should exit 1:\n${unknown.stderr.toString()}`);
      return "FAIL";
    }
    // No positional content and stdin: ignore (no pipe to read): the
    // error names both input shapes instead of hanging or saving air.
    const noContent = Bun.spawn(["bun", bin, "remember"], {
      cwd: ctx.dir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const noContentErr = await new Response(noContent.stderr).text();
    if ((await noContent.exited) !== 1 || !noContentErr.includes("no content provided")) {
      console.log(`  FAIL: no-content run should exit 1 with guidance:\n${noContentErr}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
