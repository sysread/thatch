import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-091: CI gate.
 *
 * Automatable: runs `mise run check` from the repo root and verifies
 * it exits 0. The check runs typecheck, tests, and markdownlint.
 */

const useCase: UseCase = {
  name: "UC-091-ci-gate",
  preconditions: [
    "- A clean checkout of the main branch (no uncommitted changes)",
    "- Bun 1.3.14 installed (pinned via mise)",
    "- mise installed and configured",
  ].join("\n"),
  steps: [
    "1. From the repo root on a clean main branch, run `mise run check`.",
    "2. Verify the typecheck step passes (bunx tsc -p tsconfig.check.json).",
    "3. Verify the test step passes (bun test).",
    "4. Verify the markdownlint step passes (bunx markdownlint-cli2).",
    "5. Check .github/workflows/ci.yml and verify the same jobs run on push/PR to main.",
  ].join("\n"),
  expected: [
    "- mise run check exits 0 on a clean main branch.",
    "- Typecheck passes with zero errors.",
    "- All unit tests pass.",
    "- Markdownlint passes.",
    "- CI runs the same three jobs on push/PR to main.",
  ].join("\n"),

  async run(ctx: QaContext) {
    // Run mise run check from the real repo root (not the fixture copy,
    // because the fixture is a git archive extract without node_modules
    // symlinked properly for mise).
    const result = await $`mise run check`.cwd(ctx.repoRoot).quiet().nothrow();

    if (result.exitCode !== 0) {
      console.log(`  FAIL: mise run check exited ${result.exitCode}`);
      const stderr = result.stderr.toString();
      const stdout = result.stdout.toString();
      if (stderr) console.log(`  stderr: ${stderr.slice(0, 2000)}`);
      if (stdout) console.log(`  stdout: ${stdout.slice(0, 2000)}`);
      return "FAIL";
    }

    // Verify CI workflow exists and runs the same jobs
    const ciResult = await $`cat .github/workflows/ci.yml`.cwd(ctx.repoRoot).quiet().nothrow();
    if (ciResult.exitCode !== 0) {
      console.log("  FAIL: .github/workflows/ci.yml not found");
      return "FAIL";
    }
    const ciContent = ciResult.stdout.toString();
    if (!ciContent.includes("tsc")) {
      console.log("  FAIL: CI workflow missing typecheck step");
      return "FAIL";
    }
    if (!ciContent.includes("bun test") && !ciContent.includes("bun-test")) {
      console.log("  FAIL: CI workflow missing test step");
      return "FAIL";
    }
    if (!ciContent.includes("markdownlint")) {
      console.log("  FAIL: CI workflow missing markdownlint step");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
