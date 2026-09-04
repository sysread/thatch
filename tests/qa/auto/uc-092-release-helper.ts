import { $ } from "bun";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-092: Release helper.
 *
 * Automatable: tests the release script's version bumping logic in a
 * controlled temp git repo with a mocked mise (to skip the slow check)
 * and stdin piped to "n" (to abort at the commit prompt). Verifies the
 * version is bumped and then reverted on abort.
 */

const useCase: UseCase = {
  name: "UC-092-release-helper",
  preconditions: [
    "- A clean working tree on a branch ready for release",
    "- bin/release executable",
    "- Bun 1.3.14 and mise installed",
  ].join("\n"),
  steps: [
    "1. Run `bin/release patch` (or minor or major).",
    "2. The script reads the current version from package.json.",
    "3. The script computes the next version.",
    "4. The script prints current/bump/next.",
    "5. The script checks CI is green via gh (mocked: completed/success).",
    "6. The script runs mise run check (mocked: exit 0).",
    "7. The script bumps package.json via npm version.",
    "8. The script prompts: commit, tag, and push?",
    "9. On 'no': package.json is reverted and the script exits 0.",
    "10. With CI status 'in_progress' (mocked gh): the script refuses with a CI error.",
  ].join("\n"),
  expected: [
    "- The version is bumped correctly in package.json.",
    "- On 'no' at the prompt: package.json is reverted and the script exits 0.",
    "- Non-completed CI status refuses the release with exit 1.",
  ].join("\n"),

  async run(ctx: QaContext) {
    // Create a temp git repo with a package.json
    const tmpRepo = join(ctx.dir, "release-repo-092");
    mkdirSync(tmpRepo, { recursive: true });

    await $`git init`.cwd(tmpRepo).quiet();
    await $`git config user.email test@test.com`.cwd(tmpRepo).quiet();
    await $`git config user.name test`.cwd(tmpRepo).quiet();

    // Write a minimal package.json
    writeFileSync(
      join(tmpRepo, "package.json"),
      JSON.stringify({ name: "@jeffober/thatch", version: "1.2.3" }, null, 2) + "\n",
    );
    await $`git add -A && git commit -m init`.cwd(tmpRepo).quiet();

    // Create a fake mise that exits 0 (to skip the real check)
    const fakeBinDir = join(ctx.dir, "fake-bin-092");
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(join(fakeBinDir, "mise"), "#!/usr/bin/env bash\nexit 0\n");
    await $`chmod +x ${fakeBinDir}/mise`.quiet();

    // Fake gh returning green CI. bin/release's preflight refuses to run
    // when `gh run list` does not report a completed/success run; without
    // this mock the script bails in the fixture repo (no GitHub remote).
    // Unknown gh subcommands fail closed - never exec the real gh, since
    // this dir is first on PATH and would recurse.
    writeFileSync(
      join(fakeBinDir, "gh"),
      "#!/usr/bin/env bash\n" +
      'if [ "$1" = "run" ] && [ "$2" = "list" ]; then\n' +
      '  echo \'[{"status":"completed","conclusion":"success"}]\'\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 127\n',
    );
    await $`chmod +x ${fakeBinDir}/gh`.quiet();

    const releaseBin = `${ctx.repoRoot}/bin/release`;
    const env = {
      ...ctx.env,
      PATH: `${fakeBinDir}:${ctx.env.PATH}`,
    };

    // Run bin/release patch with "n" piped to stdin (abort at prompt)
    const result = await $`echo "n" | ${releaseBin} patch`.cwd(tmpRepo).env(env).quiet().nothrow();

    if (result.exitCode !== 0) {
      console.log(`  FAIL: bin/release patch exited ${result.exitCode}`);
      const output = result.stdout.toString() + result.stderr.toString();
      console.log(`  output: ${output.slice(0, 2000)}`);
      return "FAIL";
    }

    // Verify the output shows version bump info
    const output = result.stdout.toString();
    if (!output.includes("1.2.3")) {
      console.log(`  FAIL: output should show current version 1.2.3: ${output}`);
      return "FAIL";
    }
    if (!output.includes("1.2.4")) {
      console.log(`  FAIL: output should show next version 1.2.4: ${output}`);
      return "FAIL";
    }

    // Verify package.json was reverted (because we answered "n")
    const pkgAfter = await $`cat package.json`.cwd(tmpRepo).quiet();
    const pkgJson = JSON.parse(pkgAfter.stdout.toString());
    if (pkgJson.version !== "1.2.3") {
      console.log(`  FAIL: package.json should be reverted to 1.2.3, got ${pkgJson.version}`);
      return "FAIL";
    }

    // Test minor bump
    const result2 = await $`echo "n" | ${releaseBin} minor`.cwd(tmpRepo).env(env).quiet().nothrow();
    if (result2.exitCode !== 0) {
      console.log(`  FAIL: bin/release minor exited ${result2.exitCode}`);
      return "FAIL";
    }
    const output2 = result2.stdout.toString();
    if (!output2.includes("1.3.0")) {
      console.log(`  FAIL: minor bump should show 1.3.0: ${output2}`);
      return "FAIL";
    }

    // Test major bump
    const result3 = await $`echo "n" | ${releaseBin} major`.cwd(tmpRepo).env(env).quiet().nothrow();
    if (result3.exitCode !== 0) {
      console.log(`  FAIL: bin/release major exited ${result3.exitCode}`);
      return "FAIL";
    }
    const output3 = result3.stdout.toString();
    if (!output3.includes("2.0.0")) {
      console.log(`  FAIL: major bump should show 2.0.0: ${output3}`);
      return "FAIL";
    }

    // Verify invalid argument is rejected
    const result4 = await $`${releaseBin} bogus`.cwd(tmpRepo).env(env).quiet().nothrow();
    if (result4.exitCode === 0) {
      console.log("  FAIL: bin/release with bogus arg should exit non-zero");
      return "FAIL";
    }

    // CI-gate scenario: a non-completed CI status must refuse the release.
    // This locks in the `gh run list` preflight added in 854c55b - the
    // unmocked gate is what silently broke this use case and UC-093.
    const fakeBinDirCi = join(ctx.dir, "fake-bin-092-ci-running");
    mkdirSync(fakeBinDirCi, { recursive: true });
    writeFileSync(join(fakeBinDirCi, "mise"), "#!/usr/bin/env bash\nexit 0\n");
    await $`chmod +x ${fakeBinDirCi}/mise`.quiet();
    writeFileSync(
      join(fakeBinDirCi, "gh"),
      "#!/usr/bin/env bash\n" +
      'if [ "$1" = "run" ] && [ "$2" = "list" ]; then\n' +
      '  echo \'[{"status":"in_progress","conclusion":null}]\'\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 127\n',
    );
    await $`chmod +x ${fakeBinDirCi}/gh`.quiet();

    const envCi = { ...ctx.env, PATH: `${fakeBinDirCi}:${ctx.env.PATH}` };
    const result5 = await $`echo "n" | ${releaseBin} patch`.cwd(tmpRepo).env(envCi).quiet().nothrow();
    if (result5.exitCode !== 1) {
      console.log(`  FAIL: bin/release should exit 1 when CI is not completed, got ${result5.exitCode}`);
      return "FAIL";
    }
    const output5 = result5.stdout.toString() + result5.stderr.toString();
    if (!output5.includes("CI is still running")) {
      console.log(`  FAIL: CI-gate refusal should explain the running CI: ${output5.slice(0, 1000)}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
