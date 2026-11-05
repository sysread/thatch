import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-082: CLI error handling and help.
 *
 * Automatable: pure CLI calls testing three error paths (unquoted
 * multi-word query, bogus store name, missing label argument) plus the
 * help system. Errors exit non-zero with actionable messages, not stack
 * traces. Help is per command: a help flag BEFORE the subcommand (or as
 * the whole command, or via `thatch help`) prints the global subcommand
 * list and exits 0; a help flag AFTER a subcommand prints that
 * subcommand's own page - its synopsis, flags, and notes - and exits 0.
 * A bad command prints the global list and exits 1.
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
    "5. Run `thatch` with no arguments.",
    "6. Run `thatch bogus` (unknown subcommand).",
    "7. Run `thatch --help` and `thatch help` (global help forms).",
    "8. Run `thatch chat list --help` (per-subcommand help).",
    "9. Run `thatch session get -h` (per-subcommand help, short form).",
    "10. Run `thatch help chat list` (help by name, nested path).",
    "11. Run `thatch -h chat list` (help flag BEFORE the subcommand).",
  ].join("\n"),
  expected: [
    "- Step 1 exits non-zero with an error message telling the user to quote the query.",
    "- Step 2 exits non-zero with an error message listing the stores that do exist.",
    "- Steps 3-4 print that subcommand's own usage page to stderr and exit 1.",
    "- Steps 5-6 print the global subcommand list to stderr and exit 1.",
    "- Steps 7-11 print help to stderr, exit 0, and produce no stdout (help is",
    "  never stdout data). Steps 8-10 show the named subcommand's page",
    "  (synopsis contains the command path); steps 7 and 11 show the global",
    "  list (contains `thatch stores`).",
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

    // Steps 3-4: missing label prints THAT subcommand's usage page
    for (const cmd of ["show", "forget"]) {
      const r = await $`${bin} ${cmd}`.env(env).quiet().nothrow();
      if (r.exitCode === 0) {
        console.log(`  FAIL: \`thatch ${cmd}\` with no label should exit non-zero`);
        return "FAIL";
      }
      const err = r.stderr.toString();
      if (!err.includes("USAGE") || !err.includes(`thatch ${cmd}`)) {
        console.log(`  FAIL: missing label should print ${cmd}'s own usage page: ${err}`);
        return "FAIL";
      }
    }

    // Steps 5-6: no arguments and an unknown subcommand print the global
    // subcommand list, exit 1.
    for (const probe of [[], ["bogus"]] as string[][]) {
      const r = await $`${bin} ${probe}`.env(env).quiet().nothrow();
      if (r.exitCode === 0) {
        console.log(`  FAIL: \`thatch ${probe.join(" ")}\` should exit non-zero`);
        return "FAIL";
      }
      const err = r.stderr.toString();
      if (!err.includes("USAGE") || !err.includes("thatch stores")) {
        console.log(`  FAIL: should print the global subcommand list: ${err}`);
        return "FAIL";
      }
    }

    // Steps 7-11: help prints to stderr, exits 0, and never executes a
    // subcommand (empty stdout proves it). The global forms show the
    // subcommand list; a help flag after a subcommand shows that page.
    const helpProbes: Array<{ label: string; argv: string[]; page: string }> = [
      { label: "thatch --help", argv: ["--help"], page: "thatch stores" },
      { label: "thatch help", argv: ["help"], page: "thatch stores" },
      { label: "thatch -h chat list", argv: ["-h", "chat", "list"], page: "thatch stores" },
      { label: "thatch chat list --help", argv: ["chat", "list", "--help"], page: "thatch chat list" },
      { label: "thatch session get -h", argv: ["session", "get", "-h"], page: "thatch session get" },
      { label: "thatch help chat list", argv: ["help", "chat", "list"], page: "thatch chat list" },
    ];
    for (const { label, argv, page } of helpProbes) {
      const r = await $`${bin} ${argv}`.env(env).quiet().nothrow();
      if (r.exitCode !== 0) {
        console.log(`  FAIL: \`${label}\` should exit 0, got ${r.exitCode}`);
        return "FAIL";
      }
      const err = r.stderr.toString();
      if (!err.includes("USAGE") || !err.includes(page)) {
        console.log(`  FAIL: \`${label}\` should print the ${page} page to stderr: ${err}`);
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
