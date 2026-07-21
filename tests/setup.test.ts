import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import yaml from "yaml";
import { setupClaudeCode, setupCursor, checkSetup } from "../src/setup";
import { claudeInstructions, cursorInstructions } from "../src/prompts";
import { SHARED_SKILLS, OPENCODE_ONLY_SKILLS } from "../src/skills";

let projectDir: string;
let fakeHome: string;
let originalHome: string | undefined;
let originalConfigDir: string | undefined;
let originalCursorConfigDir: string | undefined;
let originalClaudeProjectDir: string | undefined;
let originalCursorProjectDir: string | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "thatch-setup-project-"));
  fakeHome = mkdtempSync(join(tmpdir(), "thatch-setup-home-"));
  originalHome = process.env.HOME;
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  originalCursorConfigDir = process.env.CURSOR_CONFIG_DIR;
  originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  originalCursorProjectDir = process.env.CURSOR_PROJECT_DIR;
  process.env.HOME = fakeHome;
  // Clear XDG and config dir overrides so each test starts at defaults.
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CURSOR_CONFIG_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CURSOR_PROJECT_DIR;
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  }
  if (originalCursorConfigDir === undefined) {
    delete process.env.CURSOR_CONFIG_DIR;
  } else {
    process.env.CURSOR_CONFIG_DIR = originalCursorConfigDir;
  }
  if (originalClaudeProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir;
  }
  if (originalCursorProjectDir === undefined) {
    delete process.env.CURSOR_PROJECT_DIR;
  } else {
    process.env.CURSOR_PROJECT_DIR = originalCursorProjectDir;
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
    expect(result.skills.length).toBe(15);
    const skillNames = result.skills.map((s) => s.name);
    expect(skillNames).toContain("thatch-fact-extractor");
    expect(skillNames).toContain("thatch-dedup-classifier");
    expect(skillNames).toContain("thatch-project-primer");
    expect(skillNames).toContain("thatch-review-pedantic");
    expect(skillNames).toContain("thatch-review-acceptance");
    expect(skillNames).toContain("thatch-review-state-flow");
    expect(skillNames).toContain("thatch-review-no-slop");
    expect(skillNames).toContain("thatch-review-breadcrumbs");
    expect(skillNames).toContain("thatch-review-mark-and-sweep");
    expect(skillNames).toContain("thatch-review-synthesizer");
    expect(skillNames).toContain("thatch-review-context");
    expect(skillNames).toContain("thatch-workflow-research");
    expect(skillNames).toContain("thatch-change-walkthrough");
    expect(skillNames).toContain("thatch-code-walkthrough");
    expect(skillNames).toContain("thatch-session-reflection");
    expect(skillNames).not.toContain("thatch-code-review");

    for (const skill of result.skills) {
      expect(existsSync(skill.path)).toBe(true);
      const content = readFileSync(skill.path, "utf8");
      // Syntax check: YAML frontmatter with name/description (not content fidelity)
      expect(content.trimStart().startsWith("---")).toBe(true);
      expect(content).toContain("\nname: thatch-");
      expect(content).toContain("description:");
      // Frontmatter closes with second ---
      const frontEnd = content.indexOf("\n---", 3);
      expect(frontEnd).toBeGreaterThan(3);
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
    expect(text).toContain("mcp__thatch__extraction_done");
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

// ---------------------------------------------------------------------------
// setupCursor
// ---------------------------------------------------------------------------

describe("setupCursor (project-local)", () => {
  test("writes .cursor/mcp.json with stdio server config", () => {
    const result = setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.mcpConfig).toBe(join(projectDir, ".cursor", "mcp.json"));
    expect(existsSync(result.mcpConfig)).toBe(true);

    const config = JSON.parse(readFileSync(result.mcpConfig, "utf8"));
    expect(config.mcpServers.thatch.type).toBe("stdio");
    expect(config.mcpServers.thatch.command).toBe("/usr/local/bin/thatch");
    expect(config.mcpServers.thatch.args).toEqual(["mcp"]);
  });

  test("appends instructions to AGENTS.md", () => {
    const result = setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.agentsMd).toBe(join(projectDir, "AGENTS.md"));
    expect(existsSync(result.agentsMd)).toBe(true);
    const content = readFileSync(result.agentsMd, "utf8");
    expect(content).toContain("# Persistence");
    expect(content).toContain("Thatch provides persistent memory across Cursor sessions");
    expect(content).toContain("mcp__thatch__memory_remember");
  });

  test("creates AGENTS.md if it doesn't exist", () => {
    const result = setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);
    expect(existsSync(result.agentsMd)).toBe(true);
  });

  test("appends to existing AGENTS.md without clobbering", () => {
    const agentsMd = join(projectDir, "AGENTS.md");
    writeFileSync(agentsMd, "# My Project\n\nSome existing content.\n");

    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const content = readFileSync(agentsMd, "utf8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Some existing content.");
    expect(content).toContain("# Persistence");
  });

  test("is idempotent — re-running doesn't duplicate instructions", () => {
    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);
    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const content = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    const count = (content.match(/Thatch provides persistent memory across Cursor sessions/g) || []).length;
    expect(count).toBe(1);
  });

  test("writes hooks to .cursor/hooks.json with flat format", () => {
    const result = setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.hooks).toBe(join(projectDir, ".cursor", "hooks.json"));
    expect(existsSync(result.hooks)).toBe(true);
    const config = JSON.parse(readFileSync(result.hooks, "utf8"));
    expect(config.version).toBe(1);
    expect(config.hooks.sessionStart).toBeDefined();
    expect(config.hooks.postToolUse).toBeDefined();
    expect(config.hooks.beforeSubmitPrompt).toBeDefined();

    // Flat format: array of { command } objects (no nesting)
    const sessionCmd = config.hooks.sessionStart[0].command;
    expect(sessionCmd).toContain("thatch");
    expect(sessionCmd).toContain("reminder");
    expect(sessionCmd).toContain("--json");

    const bufferCmd = config.hooks.postToolUse[0].command;
    expect(bufferCmd).toContain("thatch");
    expect(bufferCmd).toContain("buffer-tool");

    const flushCmd = config.hooks.beforeSubmitPrompt[0].command;
    expect(flushCmd).toContain("thatch");
    expect(flushCmd).toContain("flush-tools");
    expect(flushCmd).toContain("--json");
  });

  test("postToolUse uses buffer-tool (not buffer-batch)", () => {
    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const config = JSON.parse(readFileSync(join(projectDir, ".cursor", "hooks.json"), "utf8"));
    const cmd = config.hooks.postToolUse[0].command as string;
    expect(cmd).toContain("buffer-tool");
    expect(cmd).not.toContain("buffer-batch");
  });

  test("preserves existing hooks when adding thatch hooks", () => {
    const hooksPath = join(projectDir, ".cursor", "hooks.json");
    mkdirSync(join(projectDir, ".cursor"), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: "echo 'other hook'" }],
      },
    }));

    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const config = JSON.parse(readFileSync(hooksPath, "utf8"));
    const sessionHooks = config.hooks.sessionStart;
    expect(sessionHooks.length).toBe(2);
    expect(sessionHooks.some((h: any) => h.command.includes("other hook"))).toBe(true);
    expect(sessionHooks.some((h: any) => h.command.includes("thatch"))).toBe(true);
  });

  test("re-running setup replaces thatch hooks (not duplicates)", () => {
    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);
    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const config = JSON.parse(readFileSync(join(projectDir, ".cursor", "hooks.json"), "utf8"));
    const thatchHooks = config.hooks.sessionStart.filter((h: any) =>
      h.command.includes("thatch"),
    );
    expect(thatchHooks.length).toBe(1);

    expect(config.hooks.postToolUse.filter((h: any) =>
      h.command.includes("thatch")).length).toBe(1);
    expect(config.hooks.beforeSubmitPrompt.filter((h: any) =>
      h.command.includes("thatch")).length).toBe(1);
  });

  test("installs skill files to ~/.cursor/skills/", () => {
    const result = setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.skills.length).toBe(15);
    const skillNames = result.skills.map((s) => s.name);
    expect(skillNames).toContain("thatch-fact-extractor");
    expect(skillNames).toContain("thatch-dedup-classifier");
    expect(skillNames).toContain("thatch-project-primer");
    expect(skillNames).toContain("thatch-review-mark-and-sweep");
    expect(skillNames).toContain("thatch-change-walkthrough");
    expect(skillNames).toContain("thatch-code-walkthrough");
    expect(skillNames).not.toContain("thatch-code-review");

    for (const skill of result.skills) {
      expect(existsSync(skill.path)).toBe(true);
      expect(skill.path).toContain(".cursor/skills");
      const content = readFileSync(skill.path, "utf8");
      expect(content).toContain("name: thatch-");
    }
  });
});

describe("setupCursor (global)", () => {
  test("writes MCP config to ~/.cursor/mcp.json (not project-local)", () => {
    const result = setupCursor("/usr/local/bin/thatch", true, projectDir, fakeHome);

    expect(result.mcpConfig).toBe(join(fakeHome, ".cursor", "mcp.json"));
    expect(existsSync(result.mcpConfig)).toBe(true);
    // Project-local mcp.json must NOT be created.
    expect(existsSync(join(projectDir, ".cursor", "mcp.json"))).toBe(false);
  });

  test("writes instructions to ~/.cursor/AGENTS.md", () => {
    const result = setupCursor("/usr/local/bin/thatch", true, projectDir, fakeHome);

    expect(result.agentsMd).toBe(join(fakeHome, ".cursor", "AGENTS.md"));
    expect(existsSync(result.agentsMd)).toBe(true);
    const content = readFileSync(result.agentsMd, "utf8");
    expect(content).toContain("Thatch provides persistent memory");
  });

  test("writes hooks to ~/.cursor/hooks.json", () => {
    const result = setupCursor("/usr/local/bin/thatch", true, projectDir, fakeHome);

    expect(result.hooks).toBe(join(fakeHome, ".cursor", "hooks.json"));
    expect(existsSync(result.hooks)).toBe(true);
  });

  test("skills installed to ~/.cursor/skills/", () => {
    const result = setupCursor("/usr/local/bin/thatch", true, projectDir, fakeHome);

    for (const skill of result.skills) {
      expect(skill.path.startsWith(join(fakeHome, ".cursor", "skills"))).toBe(true);
    }
  });

  test("global writes MCP config directly (no mcpAddCommand needed)", () => {
    const result = setupCursor("/usr/local/bin/thatch", true, projectDir, fakeHome);
    // CursorSetupResult has no mcpAddCommand field — global config is just a file.
    expect((result as any).mcpAddCommand).toBeUndefined();
    // The config file itself is the registration.
    expect(existsSync(result.mcpConfig)).toBe(true);
  });
});

describe("cursorInstructions content", () => {
  test("includes all tool names with mcp__thatch__ prefix", () => {
    const text = cursorInstructions();
    expect(text).toContain("mcp__thatch__memory_remember");
    expect(text).toContain("mcp__thatch__memory_recall");
    expect(text).toContain("mcp__thatch__memory_list");
    expect(text).toContain("mcp__thatch__memory_show");
    expect(text).toContain("mcp__thatch__memory_forget");
    expect(text).toContain("mcp__thatch__store_list");
    expect(text).toContain("mcp__thatch__find_duplicates");
    expect(text).toContain("mcp__thatch__dedup_mark_checked");
    expect(text).toContain("mcp__thatch__extraction_done");
  });

  test("references Cursor (not Claude Code)", () => {
    const text = cursorInstructions();
    expect(text).toContain("Cursor sessions");
    expect(text).not.toContain("Claude Code sessions");
  });

  test("references AGENTS.md (not CLAUDE.md) in what-not-to-store", () => {
    const text = cursorInstructions();
    expect(text).toContain("AGENTS.md");
    expect(text).not.toContain("CLAUDE.md");
  });

  test("includes session startup instructions", () => {
    const text = cursorInstructions();
    expect(text).toContain("Session Startup");
    expect(text).toContain("user preferences and personality");
    expect(text).toContain("project architecture and conventions");
  });
});

describe("checkSetup", () => {
  test("returns null when neither CURSOR_PROJECT_DIR nor CLAUDE_PROJECT_DIR is set", () => {
    const result = checkSetup(projectDir, fakeHome);
    expect(result).toBe(null);
  });

  test("detects local Claude Code install", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("installed");
    expect(result?.scope).toBe("local");
    expect(result?.host).toBe("claude");
  });

  test("detects global Claude Code install", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("installed");
    expect(result?.scope).toBe("global");
    expect(result?.host).toBe("claude");
  });

  test("detects not-installed for Claude Code", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("not-installed");
    expect(result?.host).toBe("claude");
    expect(result?.message).toContain("thatch setup --claude");
  });

  test("detects markers-broken for Claude Code (local)", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    const broken = "# Persistence\n\nThatch provides persistent memory across Claude Code sessions.\n\nSome user content without the end marker.\n";
    writeFileSync(join(projectDir, "CLAUDE.md"), broken);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("markers-broken");
    expect(result?.host).toBe("claude");
    expect(result?.message).toContain("thatch setup --claude");
  });

  test("local takes priority over global for Claude Code", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);
    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("installed");
    expect(result?.scope).toBe("local");
  });

  test("detects local Cursor install", () => {
    process.env.CURSOR_PROJECT_DIR = projectDir;
    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("installed");
    expect(result?.scope).toBe("local");
    expect(result?.host).toBe("cursor");
  });

  test("detects not-installed for Cursor", () => {
    process.env.CURSOR_PROJECT_DIR = projectDir;

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("not-installed");
    expect(result?.host).toBe("cursor");
    expect(result?.message).toContain("thatch setup --cursor");
  });

  test("detects markers-broken for Cursor (global)", () => {
    process.env.CURSOR_PROJECT_DIR = projectDir;
    const configDir = join(fakeHome, ".cursor");
    mkdirSync(configDir, { recursive: true });
    const broken = "# Persistence\n\nThatch provides persistent memory across Cursor sessions.\n\nTruncated without end marker.\n";
    writeFileSync(join(configDir, "AGENTS.md"), broken);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("markers-broken");
    expect(result?.host).toBe("cursor");
    expect(result?.message).toContain("thatch setup --cursor --global");
  });

  test("Cursor takes priority over Claude Code when both env vars are set", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    process.env.CURSOR_PROJECT_DIR = projectDir;
    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.host).toBe("cursor");
  });
});

describe("skill artifact registry parity", () => {
  const artifactsDir = join(dirname(new URL(import.meta.url).pathname), "..", "artifacts", "skills");

  test("every .md file in artifacts/skills/ is registered (except common.md)", () => {
    const files = readdirSync(artifactsDir)
      .filter((f) => f.endsWith(".md") && f !== "common.md")
      .map((f) => f.replace(/\.md$/, ""));
    const registered = [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS].map((s) => s.name);
    for (const file of files) {
      expect(registered).toContain(file);
    }
  });

  test("every registered skill has a .md file in artifacts/skills/", () => {
    const files = readdirSync(artifactsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    for (const skill of [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]) {
      expect(files).toContain(skill.name);
    }
  });

  test("loaded skill content has no backslash-backtick escape artifacts", () => {
    for (const skill of [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]) {
      expect(skill.content).not.toContain("\\`");
    }
  });

  test("REVIEW_COMMON is interpolated only into review specialist skills", () => {
    // The loader interpolates `${REVIEW_COMMON}` when it appears on its own
    // line (the directive form used by the six review specialists). Inline
    // mentions of the token in other skills (e.g. as prose examples) must
    // NOT trigger interpolation — that would splice the review framework
    // into the middle of an unrelated skill body and corrupt the content.
    // The synthesizer and code-review coordinator include some of the same
    // section headers (e.g. "## Static analysis only") as hardcoded content,
    // so the marker must be a phrase unique to common.md.
    const REVIEW_SPECIALISTS = new Set([
      "thatch-review-pedantic",
      "thatch-review-acceptance",
      "thatch-review-state-flow",
      "thatch-review-no-slop",
      "thatch-review-breadcrumbs",
      "thatch-review-mark-and-sweep",
    ]);
    const REVIEW_COMMON_BODY =
      "For every potential finding, you MUST describe a concrete scenario";
    for (const skill of [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]) {
      const isReviewSpecialist = REVIEW_SPECIALISTS.has(skill.name);
      const hasInterpolatedBody = skill.content.includes(REVIEW_COMMON_BODY);
      expect(hasInterpolatedBody).toBe(isReviewSpecialist);
    }
  });

  test("every skill frontmatter parses as strict YAML with name and description", () => {
    // opencode discovers skills by parsing the YAML frontmatter of each
    // SKILL.md. If the parse fails (or yields a mapping without `name`
    // or `description`), opencode filters the skill out of available_skills
    // entirely, so it is invisible to the LLM and can never be loaded.
    //
    // The most common way to break parsing is a `: ` (colon-space) appearing
    // mid-description in an unquoted scalar: bun's strict YAML parser
    // interprets it as a nested mapping key separator and throws
    // "Nested mappings are not allowed in compact mappings". Fix by wrapping
    // the description in single quotes (single-quoted YAML strings tolerate
    // colons, backticks, and double-quotes inline; only apostrophes need
    // doubling, and our descriptions don't have any).
    //
    // Using the yaml package directly (matching bun's strict parser opencode
    // is presumed to use) catches this class of bug at `mise run check` time.
    for (const skill of [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]) {
      const fmMatch = skill.content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).not.toBeNull();
      const parsed = yaml.parse(fmMatch![1]) as Record<string, unknown>;
      expect(typeof parsed.name).toBe("string");
      expect(parsed.name).toBe(skill.name);
      expect(typeof parsed.description).toBe("string");
      expect((parsed.description as string).length).toBeGreaterThan(0);
    }
  });
});
