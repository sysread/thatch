import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupClaudeCode } from "../src/setup";
import { claudeInstructions } from "../src/prompts";

let projectDir: string;
let fakeHome: string;
let originalHome: string | undefined;
let originalConfigDir: string | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "thatch-setup-project-"));
  fakeHome = mkdtempSync(join(tmpdir(), "thatch-setup-home-"));
  originalHome = process.env.HOME;
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = fakeHome;
  // Clear XDG and CLAUDE_CONFIG_DIR so each test starts at the default ~/.claude path.
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  }
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("setupClaudeCode (project-local)", () => {
  test("writes .mcp.json with stdio server config", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.mcpConfig).toBe(join(projectDir, ".mcp.json"));
    expect(existsSync(result.mcpConfig!)).toBe(true);

    const config = JSON.parse(readFileSync(result.mcpConfig!, "utf8"));
    expect(config.mcpServers.thatch.type).toBe("stdio");
    expect(config.mcpServers.thatch.command).toBe("/usr/local/bin/thatch");
    expect(config.mcpServers.thatch.args).toEqual(["mcp"]);
  });

  test("appends instructions to CLAUDE.md", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(existsSync(result.claudeMd)).toBe(true);
    const content = readFileSync(result.claudeMd, "utf8");
    expect(content).toContain("# Persistence");
    expect(content).toContain("Thatch provides persistent memory across Claude Code sessions");
    expect(content).toContain("mcp__thatch__memory_remember");
  });

  test("creates CLAUDE.md if it doesn't exist", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);
    expect(existsSync(result.claudeMd)).toBe(true);
  });

  test("appends to existing CLAUDE.md without clobbering", () => {
    const claudeMd = join(projectDir, "CLAUDE.md");
    writeFileSync(claudeMd, "# My Project\n\nSome existing content.\n");

    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const content = readFileSync(claudeMd, "utf8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Some existing content.");
    expect(content).toContain("# Persistence");
  });

  test("is idempotent — re-running doesn't duplicate instructions", () => {
    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);
    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const content = readFileSync(join(projectDir, "CLAUDE.md"), "utf8");
    const count = (content.match(/Thatch provides persistent memory across Claude Code sessions/g) || []).length;
    expect(count).toBe(1);
  });

  test("writes hooks to .claude/settings.json", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(existsSync(result.settings)).toBe(true);
    const settings = JSON.parse(readFileSync(result.settings, "utf8"));
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.PostToolBatch).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();

    const sessionCmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(sessionCmd).toContain("thatch");
    expect(sessionCmd).toContain("reminder");

    const bufferCmd = settings.hooks.PostToolBatch[0].hooks[0].command;
    expect(bufferCmd).toContain("thatch");
    expect(bufferCmd).toContain("buffer-batch");

    const flushCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(flushCmd).toContain("thatch");
    expect(flushCmd).toContain("flush-tools");
  });

  test("UserPromptSubmit uses thatch flush-tools (not the legacy echo nudge)", () => {
    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const settings = JSON.parse(readFileSync(join(projectDir, ".claude", "settings.json"), "utf8"));
    const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;
    expect(cmd).toContain("flush-tools");
    expect(cmd).not.toMatch(/^\s*echo\s/);
  });

  test("preserves existing hooks when adding thatch hooks", () => {
    const settingsPath = join(projectDir, ".claude", "settings.json");
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo 'other hook'" }] },
        ],
      },
    }));

    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const sessionHooks = settings.hooks.SessionStart;
    expect(sessionHooks.length).toBe(2);
    expect(sessionHooks.some((g: any) => g.hooks[0].command.includes("other hook"))).toBe(true);
    expect(sessionHooks.some((g: any) => g.hooks[0].command.includes("thatch"))).toBe(true);
  });

  test("re-running setup replaces thatch hooks (not duplicates)", () => {
    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);
    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const settings = JSON.parse(readFileSync(join(projectDir, ".claude", "settings.json"), "utf8"));
    const thatchHooks = settings.hooks.SessionStart.filter((g: any) =>
      g.hooks[0].command.includes("thatch"),
    );
    expect(thatchHooks.length).toBe(1);

    // All three hook events remain idempotent on re-runs.
    expect(settings.hooks.PostToolBatch.filter((g: any) =>
      g.hooks[0].command.includes("thatch")).length).toBe(1);
    expect(settings.hooks.UserPromptSubmit.filter((g: any) =>
      g.hooks[0].command.includes("thatch")).length).toBe(1);
  });

  test("re-running setup replaces legacy echo thatch hook with flush-tools", () => {
    // Simulate a pre-existing setup that used the old echo write-nudge.
    const settingsPath = join(projectDir, ".claude", "settings.json");
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "echo '[thatch] some legacy nudge'" }] },
        ],
      },
    }));

    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const thatchHooks = settings.hooks.UserPromptSubmit.filter((g: any) =>
      g.hooks[0].command.includes("thatch"),
    );
    expect(thatchHooks.length).toBe(1);
    expect(thatchHooks[0].hooks[0].command).toContain("flush-tools");
  });

  test("installs skill files to ~/.claude/skills/", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    // Shared skills only — opencode-only skills (thatch-code-review) are not
    // installed for Claude Code because they require sub-agent support.
    expect(result.skills.length).toBe(10);
    const skillNames = result.skills.map((s) => s.name);
    expect(skillNames).toContain("thatch-fact-extractor");
    expect(skillNames).toContain("thatch-dedup-classifier");
    expect(skillNames).toContain("thatch-project-primer");
    expect(skillNames).toContain("thatch-review-pedantic");
    expect(skillNames).toContain("thatch-review-acceptance");
    expect(skillNames).toContain("thatch-review-state-flow");
    expect(skillNames).toContain("thatch-review-no-slop");
    expect(skillNames).toContain("thatch-review-breadcrumbs");
    expect(skillNames).toContain("thatch-review-synthesizer");
    expect(skillNames).toContain("thatch-session-reflection");
    expect(skillNames).not.toContain("thatch-code-review");

    for (const skill of result.skills) {
      expect(existsSync(skill.path)).toBe(true);
      const content = readFileSync(skill.path, "utf8");
      expect(content).toContain("name: thatch-");
    }
  });
});

describe("setupClaudeCode (global)", () => {
  test("does not write .mcp.json", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);
    expect(result.mcpConfig).toBeNull();
  });

  test("writes instructions to ~/.claude/CLAUDE.md", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);

    const expectedPath = join(fakeHome, ".claude", "CLAUDE.md");
    expect(result.claudeMd).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    const content = readFileSync(expectedPath, "utf8");
    expect(content).toContain("Thatch provides persistent memory");
  });

  test("writes hooks to ~/.claude/settings.json", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);

    const expectedPath = join(fakeHome, ".claude", "settings.json");
    expect(result.settings).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });

  test("returns claude mcp add command for global", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);
    expect(result.mcpAddCommand).toBe("claude mcp add --scope user thatch -- /usr/local/bin/thatch mcp");
  });

  test("project-local does not return mcp add command", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);
    expect(result.mcpAddCommand).toBeNull();
  });
});

describe("claudeInstructions content", () => {
  test("includes all tool names with mcp__thatch__ prefix", () => {
    const text = claudeInstructions();
    expect(text).toContain("mcp__thatch__memory_remember");
    expect(text).toContain("mcp__thatch__memory_recall");
    expect(text).toContain("mcp__thatch__memory_list");
    expect(text).toContain("mcp__thatch__memory_show");
    expect(text).toContain("mcp__thatch__memory_forget");
    expect(text).toContain("mcp__thatch__store_list");
    expect(text).toContain("mcp__thatch__find_duplicates");
    expect(text).toContain("mcp__thatch__dedup_mark_checked");
  });

  test("includes session startup instructions", () => {
    const text = claudeInstructions();
    expect(text).toContain("Session Startup");
    expect(text).toContain("user preferences and personality");
    expect(text).toContain("project architecture and conventions");
  });

  test("includes when-to-write guidance", () => {
    const text = claudeInstructions();
    expect(text).toContain("One signal is enough");
    expect(text).toContain("When to Write");
  });
});

describe("CLAUDE_CONFIG_DIR override", () => {
  test("global install writes settings + CLAUDE.md + skills under $CLAUDE_CONFIG_DIR", () => {
    const customDir = mkdtempSync(join(tmpdir(), "thatch-custom-config-"));
    process.env.CLAUDE_CONFIG_DIR = customDir;
    try {
      const result = setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);

      expect(result.claudeMd).toBe(join(customDir, "CLAUDE.md"));
      expect(result.settings).toBe(join(customDir, "settings.json"));
      // skills are returned with absolute paths under the custom dir
      for (const skill of result.skills) {
        expect(skill.path.startsWith(customDir + "/")).toBe(true);
      }
      // Default ~/.claude paths must NOT be created under the fake home.
      expect(existsSync(join(fakeHome, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(fakeHome, ".claude", "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(fakeHome, ".claude", "skills"))).toBe(false);
      // The actual files MUST live under the custom config dir.
      expect(existsSync(join(customDir, "settings.json"))).toBe(true);
      expect(existsSync(join(customDir, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(customDir, "skills"))).toBe(true);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  test("project-local install keeps project paths but puts skills under $CLAUDE_CONFIG_DIR", () => {
    const customDir = mkdtempSync(join(tmpdir(), "thatch-custom-config-"));
    process.env.CLAUDE_CONFIG_DIR = customDir;
    try {
      const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

      // Project-local: CLAUDE.md and settings stay in the project repo.
      expect(result.claudeMd).toBe(join(projectDir, "CLAUDE.md"));
      expect(result.settings).toBe(join(projectDir, ".claude", "settings.json"));
      expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(projectDir, ".claude", "settings.json"))).toBe(true);

      // Skills always live under the Claude config dir — even for project-local.
      for (const skill of result.skills) {
        expect(skill.path.startsWith(customDir + "/")).toBe(true);
      }
      expect(existsSync(join(customDir, "skills"))).toBe(true);

      // Default ~/.claude/skills must NOT exist in the fake home.
      expect(existsSync(join(fakeHome, ".claude", "skills"))).toBe(false);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  test("unset CLAUDE_CONFIG_DIR falls back to ~/.claude (the default)", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);

    expect(result.claudeMd).toBe(join(fakeHome, ".claude", "CLAUDE.md"));
    expect(result.settings).toBe(join(fakeHome, ".claude", "settings.json"));
  });
});
