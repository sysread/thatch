import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { checkSetup, setupClaudeCode } from "../../../src/setup";

/**
 * UC-062: Setup markers broken.
 *
 * Automatable: yes — appendBlock and checkSetup are pure file functions.
 * This test runs setup, corrupts CLAUDE.md by removing the end marker,
 * re-runs setup (which should leave the file alone), and verifies
 * checkSetup returns "markers-broken".
 */

const useCase: UseCase = {
  name: "UC-062-setup-markers-broken",
  preconditions: [
    "- `thatch setup --claude` has run at least once (start marker exists)",
    "- `bun` on PATH",
  ].join("\n"),
  steps: [
    "1. Run `thatch setup --claude`.",
    "2. Edit CLAUDE.md to delete the end marker while leaving the start marker intact.",
    "3. Re-run `thatch setup --claude`.",
    "4. Call `checkSetup` to verify markers-broken status.",
  ].join("\n"),
  expected: [
    "- `appendBlock` detects the start marker is present but the end marker is missing. It does not write to the file — the file content is unchanged after re-run.",
    "- `checkSetup` returns `{ status: 'markers-broken', host: 'claude', file: '<path>', message: '...' }`. The message names the corrupted file and instructs the user to run `thatch setup --claude`.",
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

      // Step 2: corrupt the file — remove the end marker.
      const content = readFileSync(claudeMdPath, "utf8");
      const endMarker = '"Forget X" - `memory_recall` to find it, then `memory_forget`.';
      const corrupted = content.replace(endMarker, "USER EDITED THIS LINE AND REMOVED THE MARKER");
      writeFileSync(claudeMdPath, corrupted);

      // Step 3: re-run setup. appendBlock should leave the file alone.
      setupClaudeCode("/usr/local/bin/thatch", false, projectDir, homeDir);

      // The file should be unchanged (appendBlock returned without writing).
      if (readFileSync(claudeMdPath, "utf8") !== corrupted) {
        console.log("  FAIL: appendBlock should not modify file with broken markers");
        return "FAIL";
      }

      // Step 4: checkSetup returns markers-broken.
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
