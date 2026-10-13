import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-082: CLI error handling and help flags.
 *
 * Automatable: pure CLI calls testing three error paths (unquoted
 * multi-word query, bogus store name, missing label argument) plus the
 * help flags. Errors exit non-zero with actionable messages, not stack
 * traces. -h/--help print usage and exit 0 from anywhere in the
 * argument list - before or after the subcommand - without executing
 * the subcommand.
 */

const useCase: UseCase = {
  name: "UC-082-cli-error-handling",
  preconditions: [
    "- Bun on PATH; thatch installed",
    "- A DB with at least the global store (for the bogus-store test to list alternatives)",
  ].join("\n"),
  steps: [
    "1. Run `thatch search some topic` (unquoted, multi-word query).",
    "2. Run `thatch search \"query\" bogus-store` (valid query, nonexistent store).",
    "3. Run `thatch show` (missing label argument).",
    "4. Run `thatch forget` (missing label argument).",
    "5. Run `thatch` with no arguments (unknown/no command).",
    "6. Run `thatch chat list -h` (help flag AFTER the subcommand).",
    "7. Run `thatch -h chat list` (help flag BEFORE the subcommand).",
    "8. Run `thatch --help` (help as the whole command).",
  ].join("\n"),
  expected: [
    "- Step 1 exits non-zero with an error message telling the user to quote the query.",
    "- Step 2 exits non-zero with an error message listing the stores that do exist.",
    "- Steps 3-5 call usage() and exit 1.",
    "- Steps 6-8 print USAGE, exit 0, and produce no stdout (the subcommand",
    "  does not run; usage goes to stderr).",
    "- No command produces a stack trace or silent success on bad input.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env };

    // Step 1: unquoted multi-word query
    const r1 = await $`${bin} search some topic`.env(env).quiet().nothrow();
    if (r1.exitCode === 0) {
      console.log("  FAIL: unquoted `thatch search some topic` should exit non-zero");
      return "FAIL";
    }
    const err1 = r1.stderr.toString();
    if (!err1.includes("quote")) {
      console.log(`  FAIL: unquoted query error should mention quoting: ${err1}`);
      return "FAIL";
    }

    // Step 2: bogus store name
    const r2 = await $`${bin} search "query" bogus-store`.env(env).quiet().nothrow();
    if (r2.exitCode === 0) {
      console.log('  FAIL: `thatch search "query" bogus-store` should exit non-zero');
      return "FAIL";
    }
    const err2 = r2.stderr.toString();
    if (!err2.includes("store")) {
      console.log(`  FAIL: bogus store error should mention store: ${err2}`);
      return "FAIL";
    }

    // Step 3: missing label for show
    const r3 = await $`${bin} show`.env(env).quiet().nothrow();
    if (r3.exitCode === 0) {
      console.log("  FAIL: `thatch show` with no label should exit non-zero");
      return "FAIL";
    }
    const err3 = r3.stderr.toString();
    if (!err3.includes("USAGE")) {
      console.log(`  FAIL: missing label should print usage: ${err3}`);
      return "FAIL";
    }

    // Step 4: missing label for forget
    const r4 = await $`${bin} forget`.env(env).quiet().nothrow();
    if (r4.exitCode === 0) {
      console.log("  FAIL: `thatch forget` with no label should exit non-zero");
      return "FAIL";
    }
    const err4 = r4.stderr.toString();
    if (!err4.includes("USAGE")) {
      console.log(`  FAIL: missing label should print usage: ${err4}`);
      return "FAIL";
    }

    // Step 5: no arguments
    const r5 = await $`${bin}`.env(env).quiet().nothrow();
    if (r5.exitCode === 0) {
      console.log("  FAIL: `thatch` with no args should exit non-zero");
      return "FAIL";
    }
    const err5 = r5.stderr.toString();
    if (!err5.includes("USAGE")) {
      console.log(`  FAIL: no args should print usage: ${err5}`);
      return "FAIL";
    }

    // Steps 6-8: help flags print usage, exit 0, and never execute the
    // subcommand. Usage goes to stderr, so empty stdout proves the roster
    // (or any subcommand output) never ran.
    const helpProbes: Array<[string, string[]]> = [
      ["thatch chat list -h", ["chat", "list", "-h"]],
      ["thatch -h chat list", ["-h", "chat", "list"]],
      ["thatch --help", ["--help"]],
    ];
    for (const [label, argv] of helpProbes) {
      const r = await $`${bin} ${argv}`.env(env).quiet().nothrow();
      if (r.exitCode !== 0) {
        console.log(`  FAIL: \`${label}\` should exit 0, got ${r.exitCode}`);
        return "FAIL";
      }
      if (!r.stderr.toString().includes("USAGE")) {
        console.log(`  FAIL: \`${label}\` should print usage to stderr`);
        return "FAIL";
      }
      if (r.stdout.toString().length > 0) {
        console.log(`  FAIL: \`${label}\` should produce no stdout (subcommand ran?): ${r.stdout.toString()}`);
        return "FAIL";
      }
    }

    return "PASS";
  },
};

registerUseCase(useCase);
