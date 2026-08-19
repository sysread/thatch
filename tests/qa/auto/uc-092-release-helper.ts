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
    "5. The script runs mise run check.",
    "6. The script bumps package.json via npm version.",
    "7. The script prompts: commit, tag, and push?",
    "8. On 'no': package.json is reverted and the script exits 0.",
  ].join("\n"),
  expected: [
    "- The version is bumped correctly in package.json.",
    "- mise run check must pass before the bump proceeds.",
    "- On 'no' at the prompt: package.json is reverted and the script exits 0.",
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

    return "PASS";
  },
};

registerUseCase(useCase);
