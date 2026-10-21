import { $ } from "bun";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-124: Custom-dir skills install and MCP JSON output
 * (`thatch setup --skills-only <dir>` and `thatch setup --mcp-json`).
 *
 * Automatable: yes - CLI assertions that an explicit skills directory
 * installs the skill files there for any harness (no host flag required),
 * and that --mcp-json prints the MCP server config as JSON without writing
 * anything. `setup-skills.test.ts` covers the unit contract; this is the
 * end-to-end runbook version.
 */

const useCase: UseCase = {
  name: "UC-124-skills-custom-dir-mcp-json",
  preconditions: [
    "- Thatch and `bun` on PATH",
    "- Fixture directory writable",
  ].join("\n"),
  steps: [
    "1. From a project root: `thatch setup --skills-only ./custom-skills`",
    "   (no --claude/--cursor)",
    "2. From the same project root: `thatch setup --claude --skills-only ./custom-skills-2`",
    "   (host flag combined with an explicit directory), then the same with",
    "   `--local`",
    "3. `thatch setup --skills-only ./custom-skills --global`",
    "4. `thatch setup --mcp-json` (standalone)",
    "5. `thatch setup --skills-only ./custom-skills-3 --mcp-json` (combined)",
    "6. `thatch setup --claude --skills-only=./custom-skills-4` (= form)",
    "7. `thatch setup --claude --skills-only --mcp-json` (host + json)",
  ].join("\n"),
  expected: [
    "- The explicit-directory run installs the 37 shared skills into the given",
    "  directory and nothing else: none of `.mcp.json`, `CLAUDE.md`, `.claude/`,",
    "  or `.cursor/` appears in the project.",
    "- The output reports the skills dir plus `37 added` (fresh install).",
    "- Host or scope flags combined with an explicit directory still exit 0 but",
    "  print a note that the flags have no effect.",
    "- `--global` combined with an explicit directory exits 1 with the",
    "  cannot-be-combined error.",
    "- `--mcp-json` alone prints only the JSON on stdout and writes no files.",
    "  The JSON is an `mcpServers` object with a `thatch` entry of",
    "  `type: \"stdio\"`, a `command`, and `args: [\"mcp\"]`.",
    "- The combined run installs the skills (report on stderr) and stdout carries",
    "  only the same JSON.",
    "- The `=` form installs to the directory after the equals sign, same as the",
    "  space form.",
    "- A host flag combined with `--mcp-json` keeps stdout pure: the JSON is",
    "  the only stdout output, and the install report goes to stderr.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const dir = ctx.dir;
    const run = (args: string[]) => $`${bin} ${args}`.env(env).cwd(dir).quiet().nothrow();
    // 37 is the shared-skill roster size, asserted as a literal because the
    // CLI prints the count in prose ("37 added"). Bump it here when
    // SHARED_SKILLS grows.
    const countThatchSkills = (skillsDir: string): number =>
      readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && d.name.startsWith("thatch-"))
        .length;

    const setupFilesAbsent = (): boolean => {
      for (const [label, path] of [
        [".mcp.json", join(dir, ".mcp.json")],
        ["CLAUDE.md", join(dir, "CLAUDE.md")],
        [".claude", join(dir, ".claude")],
        [".cursor", join(dir, ".cursor")],
      ] as const) {
        if (existsSync(path)) {
          console.log(`  FAIL: explicit-dir setup wrote ${label} (expected skills to the given dir only)`);
          return false;
        }
      }
      return true;
    };

    // --- Step 1: explicit directory, no host flag ---

    const customDir = join(dir, "custom-skills");
    const r1 = await run(["setup", "--skills-only", "./custom-skills"]);
    if (r1.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --skills-only ./custom-skills` exited non-zero");
      console.log(`  stderr: ${r1.stderr.toString()}`);
      return "FAIL";
    }
    const installed = existsSync(customDir) ? countThatchSkills(customDir) : -1;
    if (installed !== 37) {
      console.log(`  FAIL: custom-dir skills count is ${installed === -1 ? "missing" : installed}, expected 37`);
      return "FAIL";
    }
    if (!setupFilesAbsent()) return "FAIL";
    const out1 = r1.stdout.toString();
    if (!out1.includes(customDir) || !out1.includes("37 added")) {
      console.log("  FAIL: custom-dir stdout does not report the skills dir + '37 added'");
      return "FAIL";
    }

    // --- Step 2: host flag combined with an explicit directory warns ---

    const r2 = await run(["setup", "--claude", "--skills-only", "./custom-skills-2"]);
    if (r2.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --claude --skills-only ./custom-skills-2` exited non-zero");
      return "FAIL";
    }
    if (countThatchSkills(join(dir, "custom-skills-2")) !== 37) {
      console.log("  FAIL: host-flag run did not install 37 skills to the explicit dir");
      return "FAIL";
    }
    if (!setupFilesAbsent()) return "FAIL";
    if (!r2.stdout.toString().includes("have no effect")) {
      console.log("  FAIL: host-flag + explicit-dir run does not print the no-effect note");
      return "FAIL";
    }

    // The --local arm of the same note: scope flag, same dir, skills now
    // installed (37 unchanged), note still prints.
    const r2c = await run(["setup", "--local", "--skills-only", "./custom-skills-2"]);
    if (r2c.exitCode !== 0) {
      console.log("  FAIL: `--local --skills-only ./custom-skills-2` exited non-zero");
      return "FAIL";
    }
    if (!r2c.stdout.toString().includes("have no effect") || !r2c.stdout.toString().includes("37 unchanged")) {
      console.log("  FAIL: --local + explicit-dir run does not print the no-effect note with skills unchanged");
      return "FAIL";
    }

    // --- Step 3: --global with an explicit directory is rejected ---

    const r3 = await run(["setup", "--skills-only", "./custom-skills", "--global"]);
    if (r3.exitCode === 0) {
      console.log("  FAIL: --global combined with an explicit skills dir should exit 1");
      return "FAIL";
    }
    if (!r3.stderr.toString().includes("cannot be combined with --global")) {
      console.log("  FAIL: --global rejection does not print the cannot-combine error");
      return "FAIL";
    }

    // --- Step 4: standalone --mcp-json prints pure JSON, writes nothing ---

    // The three --mcp-json steps (4, 5, 7) share one contract: the WHOLE
    // stdout parses as JSON with the expected thatch entry. A parse failure
    // means human output leaked onto stdout.
    const parseMcpJson = (label: string, out: Buffer): any => {
      try {
        return JSON.parse(out.toString());
      } catch {
        console.log(`  FAIL: ${label} stdout is not pure JSON`);
        console.log(`  stdout: ${out.toString()}`);
        return null;
      }
    };

    const r4 = await run(["setup", "--mcp-json"]);
    if (r4.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --mcp-json` exited non-zero");
      console.log(`  stderr: ${r4.stderr.toString()}`);
      return "FAIL";
    }
    const parsed = parseMcpJson("--mcp-json", r4.stdout);
    const entry = parsed?.mcpServers?.thatch;
    if (entry?.type !== "stdio" || entry?.args?.[0] !== "mcp" || typeof entry?.command !== "string" || entry.command === "") {
      console.log("  FAIL: --mcp-json output is not the expected mcpServers.thatch entry");
      console.log(`  stdout: ${r4.stdout.toString()}`);
      return "FAIL";
    }
    if (!setupFilesAbsent()) return "FAIL";

    // --- Step 5: combined skills install + MCP JSON ---
    // With --mcp-json set, stdout carries only the JSON (the install report
    // goes to stderr), so the whole stdout parses.

    const r5 = await run(["setup", "--skills-only", "./custom-skills-3", "--mcp-json"]);
    if (r5.exitCode !== 0) {
      console.log("  FAIL: combined `--skills-only ./custom-skills-3 --mcp-json` exited non-zero");
      return "FAIL";
    }
    if (countThatchSkills(join(dir, "custom-skills-3")) !== 37) {
      console.log("  FAIL: combined run did not install 37 skills to the explicit dir");
      return "FAIL";
    }
    if (!r5.stderr.toString().includes("37 added") || !r5.stderr.toString().includes("custom-skills-3")) {
      console.log("  FAIL: combined run does not report the install on stderr");
      return "FAIL";
    }
    const combined = parseMcpJson("combined run", r5.stdout);
    if (combined?.mcpServers?.thatch?.args?.[0] !== "mcp") {
      console.log("  FAIL: combined run JSON is not the expected mcpServers.thatch entry");
      return "FAIL";
    }

    // --- Step 6: the --skills-only=<dir> form ---

    const r6 = await run(["setup", "--claude", "--skills-only=./custom-skills-4"]);
    if (r6.exitCode !== 0) {
      console.log("  FAIL: `--claude --skills-only=./custom-skills-4` exited non-zero");
      console.log(`  stderr: ${r6.stderr.toString()}`);
      return "FAIL";
    }
    if (countThatchSkills(join(dir, "custom-skills-4")) !== 37) {
      console.log("  FAIL: = form did not install 37 skills to the directory after the equals sign");
      return "FAIL";
    }
    if (!setupFilesAbsent()) return "FAIL";

    // --- Step 7: --mcp-json with a host flag keeps stdout pure ---

    const r7 = await run(["setup", "--claude", "--skills-only", "--mcp-json"]);
    if (r7.exitCode !== 0) {
      console.log("  FAIL: `--claude --skills-only --mcp-json` exited non-zero");
      return "FAIL";
    }
    const hostJson = parseMcpJson("host-flag combined run", r7.stdout);
    if (hostJson?.mcpServers?.thatch?.args?.[0] !== "mcp") {
      console.log("  FAIL: host-flag combined run JSON is not the expected mcpServers.thatch entry");
      return "FAIL";
    }
    if (!r7.stderr.toString().includes("37 added")) {
      console.log("  FAIL: host-flag combined run does not report the install on stderr");
      return "FAIL";
    }

    // Cleanup: the custom dirs live inside the fixture copy. Step 7 also
    // created the repo .claude/skills; the fixture copy is disposable.
    for (const d of ["custom-skills", "custom-skills-2", "custom-skills-3", "custom-skills-4"]) {
      rmSync(join(dir, d), { recursive: true, force: true });
    }
    return "PASS";
  },
};

registerUseCase(useCase);
