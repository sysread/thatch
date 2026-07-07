import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupClaudeCode } from "../src/setup";
import { claudeInstructions } from "../src/prompts";

let projectDir: string;
let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "thatch-setup-project-"));
  fakeHome = mkdtempSync(join(tmpdir(), "thatch-setup-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  // Clear XDG so setup uses our fake HOME
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  process.env.HOME = originalHome;
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
    expect(settings.hooks.UserPromptSubmit).toBeDefined();

    const sessionCmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(sessionCmd).toContain("thatch");
    expect(sessionCmd).toContain("reminder");

    const promptCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(promptCmd).toContain("thatch");
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
  });

  test("installs skill files to ~/.claude/skills/", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.skills.length).toBe(2);
    const skillNames = result.skills.map((s) => s.name);
    expect(skillNames).toContain("thatch-fact-extractor");
    expect(skillNames).toContain("thatch-dedup-classifier");

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

    const expectedPath = join(fakeHome, "CLAUDE.md");
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
