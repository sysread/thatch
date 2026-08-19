import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { checkSetup } from "../../../src/setup";

/**
 * UC-063: Setup not-run warning.
 *
 * Automatable: yes — checkSetup is a pure function that reads env vars and
 * checks files. This test creates a project dir with no CLAUDE.md and
 * verifies checkSetup returns "not-installed" for both Claude and Cursor.
 */

const useCase: UseCase = {
  name: "UC-063-setup-not-run-warning",
  preconditions: [
    "- Thatch installed and `bun` on PATH",
    "- MCP server launched by Claude Code or Cursor",
    "- `thatch setup` was never run — no CLAUDE.md or AGENTS.md with thatch markers",
  ].join("\n"),
  steps: [
    "1. Set CLAUDE_PROJECT_DIR to a project directory with no CLAUDE.md. Call `checkSetup`.",
    "2. Set CURSOR_PROJECT_DIR to a project directory with no AGENTS.md. Call `checkSetup`.",
  ].join("\n"),
  expected: [
    '- `checkSetup` returns `{ status: "not-installed", host: "claude", message: "..." }`. The message tells the agent to instruct the user to run `thatch setup --claude`.',
    '- For Cursor: same behavior with "Cursor" in the message, `thatch setup --cursor` as the command, and `host: "cursor"`.',
  ].join("\n"),

  async run(ctx: QaContext) {
    const projectDir = join(ctx.dir, "uc063-project");
    const homeDir = join(ctx.dir, "uc063-home");
    const claudeConfigDir = join(ctx.dir, "uc063-claude-config");
    const cursorConfigDir = join(ctx.dir, "uc063-cursor-config");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(claudeConfigDir, { recursive: true });
    mkdirSync(cursorConfigDir, { recursive: true });

    const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const origCursorProjectDir = process.env.CURSOR_PROJECT_DIR;
    const origClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const origCursorConfigDir = process.env.CURSOR_CONFIG_DIR;
    const origHome = process.env.HOME;

    try {
      // Claude: not-installed.
      {
        process.env.CLAUDE_PROJECT_DIR = projectDir;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
        process.env.HOME = homeDir;
        delete process.env.CURSOR_PROJECT_DIR;
        delete process.env.CURSOR_CONFIG_DIR;

        // Ensure no CLAUDE.md in project or config dir.
        rmSync(join(projectDir, "CLAUDE.md"), { force: true });
        rmSync(join(claudeConfigDir, "CLAUDE.md"), { force: true });

        const result = checkSetup(projectDir, homeDir);
        if (!result || result.status !== "not-installed") {
          console.log(`  FAIL: Claude expected not-installed, got ${result?.status}`);
          return "FAIL";
        }
        if (result.host !== "claude") {
          console.log(`  FAIL: expected host claude, got ${result.host}`);
          return "FAIL";
        }
        if (!result.message.includes("thatch setup --claude")) {
          console.log("  FAIL: Claude message should mention 'thatch setup --claude'");
          return "FAIL";
        }
      }

      // Cursor: not-installed.
      {
        process.env.CURSOR_PROJECT_DIR = projectDir;
        process.env.CURSOR_CONFIG_DIR = cursorConfigDir;
        process.env.HOME = homeDir;
        delete process.env.CLAUDE_PROJECT_DIR;

        // Ensure no AGENTS.md in project or config dir.
        rmSync(join(projectDir, "AGENTS.md"), { force: true });
        rmSync(join(cursorConfigDir, "AGENTS.md"), { force: true });

        const result = checkSetup(projectDir, homeDir);
        if (!result || result.status !== "not-installed") {
          console.log(`  FAIL: Cursor expected not-installed, got ${result?.status}`);
          return "FAIL";
        }
        if (result.host !== "cursor") {
          console.log(`  FAIL: expected host cursor, got ${result.host}`);
          return "FAIL";
        }
        if (!result.message.includes("thatch setup --cursor")) {
          console.log("  FAIL: Cursor message should mention 'thatch setup --cursor'");
          return "FAIL";
        }
      }

      return "PASS";
    } finally {
      if (origClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
      if (origCursorProjectDir === undefined) delete process.env.CURSOR_PROJECT_DIR;
      else process.env.CURSOR_PROJECT_DIR = origCursorProjectDir;
      if (origClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = origClaudeConfigDir;
      if (origCursorConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR;
      else process.env.CURSOR_CONFIG_DIR = origCursorConfigDir;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  },
};

registerUseCase(useCase);
