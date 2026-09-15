import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { checkSetup, setupClaudeCode } from "../../../src/setup";

/**
 * UC-062: Setup markers broken.
 *
 * Automatable: yes — appendBlock and checkSetup are pure file functions.
 * Two corruption classes, two contracts:
 *
 * - A corrupted SENTINEL block (end marker deleted): the heal path repairs
 *   it on the next setup run - the sentinel block is rewritten fresh, and
 *   checkSetup reports installed again.
 * - A corrupted LEGACY prose block with a foreign tail (content after the
 *   block is not recognizably the instructions): the heal guard refuses,
 *   the file is untouched, and checkSetup returns "markers-broken" so the
 *   user is told to repair it.
 */

const useCase: UseCase = {
  name: "UC-062-setup-markers-broken",
  preconditions: [
    "- `thatch setup --claude` has run at least once (sentinel block exists)",
    "- `bun` on PATH",
  ].join("\n"),
  steps: [
    "1. Run `thatch setup --claude`.",
    "2. Edit CLAUDE.md to delete `<!-- thatch:end -->` while leaving the block start intact.",
    "3. Re-run `thatch setup --claude`; verify the block was repaired (heal path).",
    "4. Fabricate a legacy-start block with a foreign tail; re-run; verify the file is untouched.",
    "5. Call `checkSetup` to verify markers-broken status for the untouched case.",
  ].join("\n"),
  expected: [
    "- A sentinel block missing its end marker is repaired by re-running setup: sentinels present again, instructions current, user content after the block preserved.",
    "- A legacy prose-start block whose tail is NOT recognizably the instructions is left untouched (the heal guard refuses to eat unknown content).",
    "- `checkSetup` returns `{ status: 'markers-broken', host: 'claude', file: '<path>', message: '...' }` for the untouched corruption. The message names the corrupted file and instructs the user to run `thatch setup --claude`.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const projectDir = join(ctx.dir, "uc062-project");
    const homeDir = join(ctx.dir, "uc062-home");
    const configDir = join(ctx.dir, "uc062-config");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const origCursorProjectDir = process.env.CURSOR_PROJECT_DIR;
    const origClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const origHome = process.env.HOME;

    try {
      process.env.CLAUDE_PROJECT_DIR = projectDir;
      process.env.CLAUDE_CONFIG_DIR = configDir;
      process.env.HOME = homeDir;
      delete process.env.CURSOR_PROJECT_DIR;

      // Step 1: run setup.
      setupClaudeCode("/usr/local/bin/thatch", false, projectDir, homeDir);

      const claudeMdPath = join(projectDir, "CLAUDE.md");
      if (!existsSync(claudeMdPath)) {
        console.log("  FAIL: CLAUDE.md not written by setup");
        return "FAIL";
      }

      // Step 2+3: corrupt the sentinel block (end marker deleted), then
      // re-run setup: the heal path repairs the block.
      const content = readFileSync(claudeMdPath, "utf8");
      const truncated = content.replace("<!-- thatch:end -->", "");
      if (truncated === content) {
        console.log("  FAIL: expected a sentinel end marker to corrupt");
        return "FAIL";
      }
      writeFileSync(claudeMdPath, truncated);
      setupClaudeCode("/usr/local/bin/thatch", false, projectDir, homeDir);
      const repaired = readFileSync(claudeMdPath, "utf8");
      if (!repaired.includes("<!-- thatch:begin -->") || !repaired.includes("<!-- thatch:end -->")) {
        console.log("  FAIL: heal should restore both sentinels");
        return "FAIL";
      }
      const repairedCheck = checkSetup(projectDir, homeDir);
      if (!repairedCheck || repairedCheck.status !== "installed") {
        console.log(`  FAIL: healed file should check installed, got ${repairedCheck?.status}`);
        return "FAIL";
      }

      // Step 4: a LEGACY prose-start block with a FOREIGN tail (no
      // instructions signature after the start) must be left untouched -
      // the heal guard cannot tell instructions from user content.
      const foreignTail =
        "# Persistence\n\nThatch provides persistent memory across Claude Code sessions.\n\n" +
        "USER CONTENT THAT IS NOT THATCH INSTRUCTIONS\n";
      writeFileSync(claudeMdPath, foreignTail);
      setupClaudeCode("/usr/local/bin/thatch", false, projectDir, homeDir);
      if (readFileSync(claudeMdPath, "utf8") !== foreignTail) {
        console.log("  FAIL: appendBlock should not modify a legacy block with a foreign tail");
        return "FAIL";
      }

      // Step 5: checkSetup returns markers-broken for the untouched case.
      const result = checkSetup(projectDir, homeDir);
      if (!result || result.status !== "markers-broken") {
        console.log(`  FAIL: expected markers-broken, got ${result?.status}`);
        return "FAIL";
      }
      if (result.host !== "claude") {
        console.log(`  FAIL: expected host claude, got ${result.host}`);
        return "FAIL";
      }
      if (!existsSync(result.file)) {
        console.log(`  FAIL: file path does not exist: ${result.file}`);
        return "FAIL";
      }
      if (!result.message.includes("thatch setup --claude")) {
        console.log("  FAIL: message should mention 'thatch setup --claude'");
        return "FAIL";
      }

      return "PASS";
    } finally {
      rmSync(join(projectDir, "CLAUDE.md"), { force: true });
      rmSync(join(projectDir, ".claude"), { recursive: true, force: true });
      rmSync(join(configDir, "CLAUDE.md"), { force: true });
      rmSync(join(configDir, "settings.json"), { force: true });
      rmSync(join(configDir, "skills"), { recursive: true, force: true });

      if (origClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
      if (origCursorProjectDir === undefined) delete process.env.CURSOR_PROJECT_DIR;
      else process.env.CURSOR_PROJECT_DIR = origCursorProjectDir;
      if (origClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = origClaudeConfigDir;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  },
};

registerUseCase(useCase);
