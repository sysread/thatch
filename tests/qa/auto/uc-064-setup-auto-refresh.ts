import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { checkSetup, setupClaudeCode } from "../../../src/setup";

/**
 * UC-064: Setup auto-refresh.
 *
 * Automatable: yes — setupClaudeCode and checkSetup are pure file functions.
 * This test runs setup, introduces drift, then calls setupClaudeCode again
 * (simulating what the MCP server does on startup) and verifies the drift
 * is fixed. All operations are idempotent.
 */

const useCase: UseCase = {
  name: "UC-064-setup-auto-refresh",
  preconditions: [
    "- `thatch setup --claude` has run at least once (markers exist)",
    "- `bun` on PATH",
  ].join("\n"),
  steps: [
    "1. Run `thatch setup --claude`.",
    "2. Introduce drift: edit the thatch block in CLAUDE.md, modify a hook, and change a SKILL.md.",
    "3. Call `setupClaudeCode` again (simulating MCP server auto-refresh).",
    "4. Verify drifted files were refreshed to canonical content.",
  ].join("\n"),
  expected: [
    "- `checkSetup` returns `{ status: 'installed', ... }` because markers are present.",
    "- The thatch block in CLAUDE.md is replaced with canonical content. Hooks are replaced. Drifted skill files are overwritten.",
    "- Non-thatch hooks are preserved.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const projectDir = join(ctx.dir, "uc064-project");
    const homeDir = join(ctx.dir, "uc064-home");
    const configDir = join(ctx.dir, "uc064-config");
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

      // Step 1: initial setup.
      setupClaudeCode("/usr/local/bin/thatch", false, projectDir, homeDir);

      const claudeMdPath = join(projectDir, "CLAUDE.md");
      const settingsPath = join(projectDir, ".claude", "settings.json");
      const claudeMdBefore = readFileSync(claudeMdPath, "utf8");
      const settingsBefore = readFileSync(settingsPath, "utf8");

      const skillsDir = join(configDir, "skills");
      const skillPath = join(skillsDir, "thatch-fact-extractor", "SKILL.md");
      const skillCanonical = readFileSync(skillPath, "utf8");

      // Verify setup is detected as installed.
      const status = checkSetup(projectDir, homeDir);
      if (!status || status.status !== "installed") {
        console.log(`  FAIL: expected installed, got ${status?.status}`);
        return "FAIL";
      }

      // Step 2: introduce drift inside the thatch block (between markers).
      writeFileSync(claudeMdPath, claudeMdBefore.replace(
        "Tools: `memory_remember`",
        "DRIFTED CONTENT HERE",
      ));
      const settingsParsed = JSON.parse(settingsBefore);
      settingsParsed.hooks.SessionStart[0].hooks[0].command = "drifted-cmd";
      // Add a non-thatch hook.
      settingsParsed.hooks.SessionStart.push({
        hooks: [{ type: "command", command: "echo external-hook" }],
      });
      writeFileSync(settingsPath, JSON.stringify(settingsParsed, null, 2) + "\n");
      writeFileSync(skillPath, "# DRIFTED SKILL\n");

      // Step 3: auto-refresh (call setupClaudeCode again, like the MCP server does).
      setupClaudeCode("/usr/local/bin/thatch", false, projectDir, homeDir);

      // Step 4: verify drift is fixed.
      if (readFileSync(claudeMdPath, "utf8") !== claudeMdBefore) {
        console.log("  FAIL: CLAUDE.md not restored to canonical content");
        return "FAIL";
      }

      const settingsAfter = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (!settingsAfter.hooks.SessionStart?.some(
        (g: any) => g.hooks?.some((h: any) => h.command?.includes("thatch reminder")),
      )) {
        console.log("  FAIL: thatch hook missing after auto-refresh");
        return "FAIL";
      }
      if (!settingsAfter.hooks.SessionStart?.some(
        (g: any) => g.hooks?.some((h: any) => h.command?.includes("external-hook")),
      )) {
        console.log("  FAIL: non-thatch hook not preserved after auto-refresh");
        return "FAIL";
      }

      if (readFileSync(skillPath, "utf8") !== skillCanonical) {
        console.log("  FAIL: drifted SKILL.md not overwritten");
        return "FAIL";
      }

      return "PASS";
    } finally {
      rmSync(join(projectDir, "CLAUDE.md"), { force: true });
      rmSync(join(projectDir, ".claude"), { recursive: true, force: true });
      rmSync(join(projectDir, ".mcp.json"), { force: true });
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
