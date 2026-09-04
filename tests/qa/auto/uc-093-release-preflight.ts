import { $ } from "bun";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-093: Release preflight.
 *
 * Automatable: tests the release script's pre-flight check that catches
 * a tagged-but-not-published state. Creates a temp git repo with a tag
 * matching the current version, mocks npm to return E404, and verifies
 * the script errors with recovery instructions and exits 1. Also tests
 * the non-404 case (warns but proceeds).
 */

const useCase: UseCase = {
  name: "UC-093-release-preflight",
  preconditions: [
    "- bin/release executable",
    "- A git tag v$curr that exists locally (from a prior release attempt)",
    "- npm registry reachable for the pre-flight check",
  ].join("\n"),
  steps: [
    "1. Ensure a git tag v$curr exists (simulating a prior release that tagged but did not publish).",
    "2. Verify the npm package @jeffober/thatch@$curr returns E404 (not published).",
    "3. Run bin/release patch (or any bump).",
    "4. The script detects the existing tag and queries the npm registry.",
    "5. Verify the script errors with recovery instructions and exits 1.",
    "6. Separately: simulate a non-404 npm failure (network timeout, registry 500).",
    "7. Run bin/release patch again.",
    "8. Verify the script warns about the npm check failure but proceeds.",
  ].join("\n"),
  expected: [
    "- When the tag exists and npm returns E404: the script errors with a message explaining the prior release failed, and gives recovery instructions. Exit 1.",
    "- When the npm check fails for a non-404 reason: the script warns but proceeds.",
    "- The pre-flight check runs before mise run check and before the version bump.",
  ].join("\n"),

  async run(ctx: QaContext) {
    // Create a temp git repo with a package.json and a tag
    const tmpRepo = join(ctx.dir, "release-preflight-093");
    mkdirSync(tmpRepo, { recursive: true });

    await $`git init`.cwd(tmpRepo).quiet();
    await $`git config user.email test@test.com`.cwd(tmpRepo).quiet();
    await $`git config user.name test`.cwd(tmpRepo).quiet();

    writeFileSync(
      join(tmpRepo, "package.json"),
      JSON.stringify({ name: "@jeffober/thatch", version: "1.0.0" }, null, 2) + "\n",
    );
    await $`git add -A && git commit -m init`.cwd(tmpRepo).quiet();
    // Create a tag matching the current version
    await $`git tag v1.0.0`.cwd(tmpRepo).quiet();

    // --- Test 1: E404 (tagged but not published) ---
    const fakeBinDir = join(ctx.dir, "fake-bin-093");
    mkdirSync(fakeBinDir, { recursive: true });

    // Fake gh returning green CI. bin/release's CI preflight refuses to run
    // when `gh run list` does not report a completed/success run; without
    // this mock the script bails in the fixture repo (no GitHub remote)
    // before ever reaching the npm preflight under test. Unknown gh
    // subcommands fail closed - never exec the real gh, since this dir is
    // first on PATH and would recurse.
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

    // Fake npm that returns E404
    writeFileSync(
      join(fakeBinDir, "npm"),
      "#!/usr/bin/env bash\n" +
      'if [ "$1" = "view" ]; then\n' +
      '  echo "npm error code E404" >&2\n' +
      '  echo "npm error 404 Not Found" >&2\n' +
      '  exit 1\n' +
      'fi\n' +
      'exec npm "$@"\n',
    );
    await $`chmod +x ${fakeBinDir}/npm`.quiet();

    const releaseBin = `${ctx.repoRoot}/bin/release`;
    const env404 = {
      ...ctx.env,
      PATH: `${fakeBinDir}:${ctx.env.PATH}`,
    };

    const result404 = await $`${releaseBin} patch`.cwd(tmpRepo).env(env404).quiet().nothrow();

    if (result404.exitCode === 0) {
      console.log("  FAIL: bin/release should exit 1 when tag exists and npm returns E404");
      return "FAIL";
    }
    const out404 = result404.stdout.toString() + result404.stderr.toString();
    if (!out404.includes("tagged but not published") && !out404.includes("E404") && !out404.includes("previous release failed")) {
      console.log(`  FAIL: error should mention tagged-but-not-published: ${out404.slice(0, 1000)}`);
      return "FAIL";
    }

    // --- Test 2: Non-404 npm failure (warns but proceeds) ---
    const fakeBinDir2 = join(ctx.dir, "fake-bin-093-warn");
    mkdirSync(fakeBinDir2, { recursive: true });

    // Fake npm that returns a non-404 error for `npm view`, and handles
    // `npm version` by patching package.json directly (avoids recursion
    // from calling the real npm which would find this fake script again).
    writeFileSync(
      join(fakeBinDir2, "npm"),
      "#!/usr/bin/env bash\n" +
      'if [ "$1" = "view" ]; then\n' +
      '  echo "npm error code ECONNREFUSED" >&2\n' +
      '  echo "npm error network" >&2\n' +
      '  exit 1\n' +
      'elif [ "$1" = "version" ]; then\n' +
      '  # Simulate npm version --no-git-tag-version: update package.json\n' +
      '  shift; v="$1"; shift\n' +
      '  node -e "\n' +
      '    const fs = require(\"fs\");\n' +
      '    const pkg = JSON.parse(fs.readFileSync(\"package.json\",\"utf8\"));\n' +
      '    const [maj,min,pat] = pkg.version.split(\".\").map(Number);\n' +
      '    if (\"$v\" === \"patch\") pkg.version = maj+\".\"+min+\".\"+(pat+1);\n' +
      '    else if (\"$v\" === \"minor\") pkg.version = maj+\".\"+(min+1)+\".0\";\n' +
      '    else if (\"$v\" === \"major\") pkg.version = (maj+1)+\".0.0\";\n' +
      '    fs.writeFileSync(\"package.json\", JSON.stringify(pkg,null,2)+\"\\n\");\n' +
      '  "\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 0\n',
    );
    await $`chmod +x ${fakeBinDir2}/npm`.quiet();

    // Also need a fake mise to skip the check step
    writeFileSync(join(fakeBinDir2, "mise"), "#!/usr/bin/env bash\nexit 0\n");
    await $`chmod +x ${fakeBinDir2}/mise`.quiet();

    // And a fake gh with green CI so the script reaches the npm check.
    writeFileSync(
      join(fakeBinDir2, "gh"),
      "#!/usr/bin/env bash\n" +
      'if [ "$1" = "run" ] && [ "$2" = "list" ]; then\n' +
      '  echo \'[{"status":"completed","conclusion":"success"}]\'\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 127\n',
    );
    await $`chmod +x ${fakeBinDir2}/gh`.quiet();

    const envWarn = {
      ...ctx.env,
      PATH: `${fakeBinDir2}:${ctx.env.PATH}`,
    };

    // Run with "n" piped to stdin to abort at the commit prompt
    const resultWarn = await $`echo "n" | ${releaseBin} patch`.cwd(tmpRepo).env(envWarn).quiet().nothrow();

    if (resultWarn.exitCode !== 0) {
      console.log(`  FAIL: bin/release should proceed on non-404 npm error, exited ${resultWarn.exitCode}`);
      const out = resultWarn.stdout.toString() + resultWarn.stderr.toString();
      console.log(`  output: ${out.slice(0, 1000)}`);
      return "FAIL";
    }
    const outWarn = resultWarn.stdout.toString();
    if (!outWarn.includes("WARN") && !outWarn.includes("warn")) {
      console.log(`  FAIL: non-404 error should produce a warning: ${outWarn.slice(0, 500)}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
