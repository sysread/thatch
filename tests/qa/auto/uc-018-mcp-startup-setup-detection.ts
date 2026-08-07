import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { checkSetup, setupClaudeCode } from "../../../src/setup";

/**
 * UC-018: MCP startup setup detection.
 *
 * Automatable: yes — checkSetup is a pure function that reads env vars and
 * checks files. We manage CLAUDE_PROJECT_DIR and CLAUDE_CONFIG_DIR via
 * process.env (saving and restoring in a finally block), create temp project
 * and home dirs, and verify all four outcomes: null (no env var), installed,
 * not-installed, and markers-broken (with the file path in the result).
 */

const useCase: UseCase = {
  name: "UC-018-mcp-startup-setup-detection",
  preconditions: [
    "- Thatch installed and `bun` on PATH",
    "- MCP server launched by Claude Code (`thatch mcp` with `CLAUDE_PROJECT_DIR` set)",
    "  or Cursor (`thatch mcp` with `CURSOR_PROJECT_DIR` set)",
  ].join("\n"),
  steps: [
    "1. Start a Claude Code session in a project where `thatch setup --claude` was",
    "   never run (no `CLAUDE.md` with thatch markers, neither local nor global).",
    "2. Call any thatch tool (e.g. `mcp__thatch__store_list`).",
    "3. Repeat in a project where setup was run but `CLAUDE.md` was edited externally",
    "   and the thatch block's end marker was deleted.",
    "4. Repeat in a project where setup was run correctly.",
    "5. Repeat all steps for Cursor (substituting `--cursor`, `AGENTS.md`,",
    "   `CURSOR_PROJECT_DIR`).",
  ].join("\n"),
  expected: [
    '- **Not-installed**: The first `tools/call` response is prepended with a',
    '  warning: "[thatch] Thatch is running as an MCP server but has not been set',
    '  up for Claude Code. ... Tell the user to run: thatch setup --claude". The',
    "  warning also appears on stderr. Subsequent tool responses are clean (warning",
    "  is one-shot).",
    "- **Markers-broken**: The first `tools/call` response is prepended with a",
    "  warning naming the corrupted file and instructing the user to run",
    "  `thatch setup` (or manually remove the corrupted block and re-run).",
    "- **Installed**: No warning. Tool responses are clean from the first call.",
    '- **Cursor**: Same behavior, with "Cursor" substituted for "Claude Code" and',
    "  `thatch setup --cursor` in the message. When both `CURSOR_PROJECT_DIR` and",
    "  `CLAUDE_PROJECT_DIR` are set, Cursor detection takes priority.",
    "- **No env var**: When neither `CURSOR_PROJECT_DIR` nor `CLAUDE_PROJECT_DIR` is",
    "  set (manual `thatch mcp` invocation), `checkSetup` returns `null` and no",
    "  warning is emitted.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const projectDir = join(ctx.dir, "uc018-project");
    const homeDir = join(ctx.dir, "uc018-home");
    const configDir = join(ctx.dir, "uc018-claude-config");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const origCursorProjectDir = process.env.CURSOR_PROJECT_DIR;
    const origClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const origHome = process.env.HOME;
    const failures: string[] = [];

    try {
      // --- No env var: checkSetup returns null ---
      {
        delete process.env.CLAUDE_PROJECT_DIR;
        delete process.env.CURSOR_PROJECT_DIR;
        const result = checkSetup(projectDir, homeDir);
        if (result !== null) {
          failures.push(`no env var: expected null, got ${JSON.stringify(result)}`);
        }
      }

      // --- Not-installed: no CLAUDE.md anywhere ---
      {
        process.env.CLAUDE_PROJECT_DIR = projectDir;
        delete process.env.CURSOR_PROJECT_DIR;
        process.env.CLAUDE_CONFIG_DIR = configDir;
        // Ensure no CLAUDE.md in project or config dir.
        rmSync(join(projectDir, "CLAUDE.md"), { force: true });
        rmSync(join(configDir, "CLAUDE.md"), { force: true });

        const result = checkSetup(projectDir, homeDir);
        if (!result || result.status !== "not-installed") {
          failures.push(`not-installed: expected status "not-installed", got ${result?.status}`);
        } else {
          if (result.host !== "claude") {
            failures.push(`not-installed: expected host "claude", got ${result.host}`);
          }
          if (!result.message.includes("thatch setup --claude")) {
            failures.push("not-installed: message does not mention 'thatch setup --claude'");
          }
        }
      }

      // --- Installed: setup was run correctly (local) ---
      {
        process.env.CLAUDE_PROJECT_DIR = projectDir;
        process.env.CLAUDE_CONFIG_DIR = configDir;
        rmSync(join(projectDir, "CLAUDE.md"), { force: true });
        rmSync(join(configDir, "CLAUDE.md"), { force: true });

        setupClaudeCode("/usr/local/bin/thatch", false, projectDir, homeDir);

        const result = checkSetup(projectDir, homeDir);
        if (!result || result.status !== "installed") {
          failures.push(`installed: expected status "installed", got ${result?.status}`);
        } else {
          if (result.scope !== "local") {
            failures.push(`installed: expected scope "local", got ${result.scope}`);
          }
          if (result.host !== "claude") {
            failures.push(`installed: expected host "claude", got ${result.host}`);
          }
        }

        // Cleanup for next test.
        rmSync(join(projectDir, "CLAUDE.md"), { force: true });
        rmSync(join(projectDir, ".claude"), { recursive: true, force: true });
      }

      // --- Markers-broken: start marker present, end marker missing ---
      {
        process.env.CLAUDE_PROJECT_DIR = projectDir;
        process.env.CLAUDE_CONFIG_DIR = configDir;
        // Write a CLAUDE.md with the start marker but no end marker.
        const brokenContent =
          "# Persistence\n\n" +
          "Thatch provides persistent memory across Claude Code sessions.\n\n" +
          "Some user content that removed the end marker.\n";
        writeFileSync(join(projectDir, "CLAUDE.md"), brokenContent);

        const result = checkSetup(projectDir, homeDir);
        if (!result || result.status !== "markers-broken") {
          failures.push(`markers-broken: expected status "markers-broken", got ${result?.status}`);
        } else {
          if (result.host !== "claude") {
            failures.push(`markers-broken: expected host "claude", got ${result.host}`);
          }
          if (!result.message.includes("thatch setup --claude")) {
            failures.push("markers-broken: message does not mention 'thatch setup --claude'");
          }
          // The result must name the corrupted file.
          if (!result.file || !existsSync(result.file)) {
            failures.push(`markers-broken: file path missing or does not exist: ${result.file}`);
          }
          // The file path should be the local CLAUDE.md.
          if (result.file !== join(projectDir, "CLAUDE.md")) {
            failures.push(`markers-broken: file path should be ${join(projectDir, "CLAUDE.md")}, got ${result.file}`);
          }
        }

        rmSync(join(projectDir, "CLAUDE.md"), { force: true });
      }

      // --- Installed (global): setup was run with --global ---
      {
        process.env.CLAUDE_PROJECT_DIR = projectDir;
        process.env.CLAUDE_CONFIG_DIR = configDir;
        rmSync(join(configDir, "CLAUDE.md"), { force: true });
        rmSync(join(configDir, "settings.json"), { force: true });

        setupClaudeCode("/usr/local/bin/thatch", true, projectDir, homeDir);

        const result = checkSetup(projectDir, homeDir);
        if (!result || result.status !== "installed") {
          failures.push(`installed (global): expected status "installed", got ${result?.status}`);
        } else {
          if (result.scope !== "global") {
            failures.push(`installed (global): expected scope "global", got ${result.scope}`);
          }
        }

        rmSync(join(configDir, "CLAUDE.md"), { force: true });
        rmSync(join(configDir, "settings.json"), { force: true });
        rmSync(join(configDir, "skills"), { recursive: true, force: true });
      }

      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`  FAIL: ${f}`);
        }
        return "FAIL";
      }

      return "PASS";
    } finally {
      if (origClaudeProjectDir === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
      }
      if (origCursorProjectDir === undefined) {
        delete process.env.CURSOR_PROJECT_DIR;
      } else {
        process.env.CURSOR_PROJECT_DIR = origCursorProjectDir;
      }
      if (origClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = origClaudeConfigDir;
      }
      if (origHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = origHome;
      }
    }
  },
};

registerUseCase(useCase);
