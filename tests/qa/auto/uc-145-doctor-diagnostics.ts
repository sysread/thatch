import { $ } from "bun";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { THATCH_BEGIN, THATCH_END } from "../../../src/setup";

/**
 * UC-145: Doctor diagnostics (`thatch doctor`).
 *
 * Automatable: yes - the doctor is a read-only CLI over file state and
 * the DB. Runs the real CLI in the fixture environment: the clean state
 * (exit 0, not-detected lines), the orphaned regime marker (exit 1 with
 * both repair paths), the legacy home-root CLAUDE.md block, and the
 * read-only contract (the planted state survives the run untouched).
 * `spawnsOpencode: false` - no opencode binary is needed; the doctor's
 * daemon check reads the chat registry only.
 */

const useCase: UseCase = {
  name: "UC-145-doctor-diagnostics",
  preconditions: [
    "- Bun on PATH (the test runs the repo binary directly)",
    "- A fixture environment (HOME, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, THATCH_DB_PATH all fixture-scoped)",
  ].join("\n"),
  steps: [
    "1. Run `thatch doctor` in a clean fixture: expect exit 0, a database pass line, and not-detected info lines for claude and cursor.",
    "2. Plant an orphaned plugin-regime marker (regime-claude beside the fixture db, no plugin directory): expect exit 1 and the fail naming both repair paths.",
    "3. Plant a legacy thatch block at ~/CLAUDE.md: expect the legacy warn line.",
    "4. Re-run the doctor: expect the same findings and the planted files byte-identical afterwards (the doctor never mutates state).",
  ].join("\n"),
  expected: [
    "- Clean state: stdout carries one line per check with a `[pass]`/`[warn]`/`[fail]`/`[info]` verdict tag, a `summary:` line, and the process exits 0.",
    "- Orphaned marker: the regime check fails with `no plugin directory exists` and a fix naming `thatch setup --claude` and `thatch setup --claude --hooks`; exit 1.",
    "- Legacy block: a warn naming ~/CLAUDE.md and the removal path.",
    "- Read-only: the regime marker and ~/CLAUDE.md are unchanged after the run (advice, never mutation).",
  ].join("\n"),
  spawnsOpencode: false,

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const run = () => $`bun ${bin} doctor`.env(ctx.env).cwd(ctx.dir).quiet().nothrow();

    // --- Step 1: the clean fixture - exit 0, coverage lines, no alarms ---

    const r1 = await run();
    const out1 = r1.stdout.toString();
    if (r1.exitCode !== 0) {
      console.log(`  FAIL: clean-state doctor exited ${r1.exitCode} (expected 0):\n${out1}\n${r1.stderr.toString()}`);
      return "FAIL";
    }
    if (!out1.includes("[pass] database: reachable")) {
      console.log(`  FAIL: no database pass line:\n${out1}`);
      return "FAIL";
    }
    // Claude and cursor carry no install state in the fixture: their
    // sections collapse to one not-detected line each - information, not
    // alarms (the mixed-host contract: absent hosts are not failures).
    if (!out1.includes("[info] install: not detected")) {
      console.log(`  FAIL: expected not-detected info lines for claude/cursor:\n${out1}`);
      return "FAIL";
    }
    if (!out1.includes("summary: 0 fail")) {
      console.log(`  FAIL: expected a zero-fail summary:\n${out1}`);
      return "FAIL";
    }

    // --- Step 2: the orphaned regime marker - exit 1, both repair paths ---

    const markerPath = join(dirname(ctx.env.THATCH_DB_PATH!), "regime-claude");
    writeFileSync(markerPath, "plugin", "utf-8");
    const r2 = await run();
    const out2 = r2.stdout.toString();
    if (r2.exitCode !== 1) {
      console.log(`  FAIL: orphaned-marker doctor exited ${r2.exitCode} (expected 1):\n${out2}`);
      return "FAIL";
    }
    const regimeLine = out2.split("\n").find((l) => l.includes("[fail] regime:"));
    if (!regimeLine || !regimeLine.includes("no plugin directory exists")) {
      console.log(`  FAIL: expected the orphaned-marker fail line:\n${out2}`);
      return "FAIL";
    }
    if (!out2.includes("thatch setup --claude --hooks")) {
      console.log(`  FAIL: the regime fix must name the hooks-regime return path:\n${out2}`);
      return "FAIL";
    }

    // --- Step 3: the legacy home-root CLAUDE.md block ---

    const legacyMd = join(ctx.env.HOME!, "CLAUDE.md");
    writeFileSync(legacyMd, `# Notes\n\n${THATCH_BEGIN}\nstale instructions\n${THATCH_END}\n`, "utf-8");
    const r3 = await run();
    const out3 = r3.stdout.toString();
    if (!out3.includes("[warn] legacy block:")) {
      console.log(`  FAIL: expected the legacy-block warn:\n${out3}`);
      return "FAIL";
    }

    // --- Step 4: the read-only contract - planted state survives ---

    const markerAfter = readFileSync(markerPath, "utf-8");
    const mdAfter = readFileSync(legacyMd, "utf-8");
    if (markerAfter !== "plugin" || !mdAfter.includes(THATCH_BEGIN)) {
      console.log("  FAIL: the doctor mutated planted state (marker or ~/CLAUDE.md changed)");
      return "FAIL";
    }
    if (!existsSync(markerPath)) {
      console.log("  FAIL: the doctor deleted the regime marker");
      return "FAIL";
    }
    // And the findings are stable across runs (no first-run-only state).
    const r4 = await run();
    if (r4.exitCode !== 1 || !r4.stdout.toString().includes("[fail] regime:")) {
      console.log(`  FAIL: findings not stable across runs:\n${r4.stdout.toString()}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
