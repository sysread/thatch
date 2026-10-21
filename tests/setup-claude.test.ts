import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupClaudeCode, registerClaudeMcpServer } from "../src/setup";
import { claudeInstructions, cursorInstructions, systemPrompt } from "../src/prompts";
import { installSetupHarness, projectDir, fakeHome } from "./mocks/setup-harness";

installSetupHarness();

describe("setupClaudeCode (project-local)", () => {
  test("writes .mcp.json with stdio server config", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.mcpConfig).toBe(join(projectDir, ".mcp.json"));
    expect(existsSync(result.mcpConfig!)).toBe(true);

    const config = JSON.parse(readFileSync(result.mcpConfig!, "utf8"));
    expect(config.mcpServers.thatch.type).toBe("stdio");
    expect(config.mcpServers.thatch.command).toBe("/usr/local/bin/thatch");
    expect(config.mcpServers.thatch.args).toEqual(["mcp"]);
    // Project-local configs pin the project directory so the MCP server's
    // identity resolution (the chat `as` binding) is cwd-independent.
    expect(config.mcpServers.thatch.env).toEqual({ THATCH_PROJECT_DIR: projectDir });
  });

  test("global setup never pins THATCH_PROJECT_DIR (one registration serves every project)", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);
    // Global Claude setup writes no config file; the printed/manual command
    // must not smuggle a project-scoped env pin either - a user-scope
    // registration serves every project, and a first-in-chain env pin
    // would clobber per-project resolution for all of them.
    expect(result.mcpConfig).toBeNull();
    if ("manualCommand" in result) {
      expect((result as any).manualCommand).not.toContain("THATCH_PROJECT_DIR");
    }
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

  test("installs skills to the repo's .claude/skills/ (project-local)", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    // Shared skills only — opencode-only skills (thatch-code-review) are not
    // installed for Claude Code because they require sub-agent support.
    expect(result.skills.dir).toBe(join(projectDir, ".claude", "skills"));
    expect(result.skills.added.length).toBe(37);
    expect(result.skills.updated).toEqual([]);
    expect(result.skills.unchanged).toEqual([]);
    expect(result.skills.removed).toEqual([]);

    const skillNames = result.skills.added.map((s) => s.name);
    expect(skillNames).toContain("thatch-fact-extractor");
    expect(skillNames).toContain("thatch-dedup-classifier");
    expect(skillNames).toContain("thatch-project-primer");
    expect(skillNames).toContain("thatch-review-pedantic");
    expect(skillNames).toContain("thatch-review-acceptance");
    expect(skillNames).toContain("thatch-review-state-flow");
    expect(skillNames).toContain("thatch-review-economy");
    expect(skillNames).toContain("thatch-review-no-slop");
    expect(skillNames).toContain("thatch-review-clarity");
    expect(skillNames).toContain("thatch-review-breadcrumbs");
    expect(skillNames).toContain("thatch-review-mark-and-sweep");
    expect(skillNames).toContain("thatch-review-highlights");
    expect(skillNames).toContain("thatch-review-technique");
    expect(skillNames).toContain("thatch-review-synthesizer");
    expect(skillNames).toContain("thatch-review-context");
    expect(skillNames).toContain("thatch-code-archaeology");
    expect(skillNames).toContain("thatch-review-followup");
    expect(skillNames).toContain("thatch-change-walkthrough");
    expect(skillNames).toContain("thatch-code-walkthrough");
    expect(skillNames).toContain("thatch-session-reflection");
    expect(skillNames).toContain("thatch-pr-description");
    expect(skillNames).toContain("thatch-ticket-description");
    expect(skillNames).toContain("thatch-split-overlarge-pr");
    expect(skillNames).toContain("thatch-review-response");
    expect(skillNames).toContain("thatch-plan-refinement");
    expect(skillNames).toContain("thatch-refine");
    expect(skillNames).toContain("thatch-refine-team-app");
    expect(skillNames).toContain("thatch-refine-personal");
    expect(skillNames).toContain("thatch-refine-shared-lib");
    expect(skillNames).toContain("thatch-refine-spike");
    expect(skillNames).toContain("thatch-refine-infra");
    expect(skillNames).toContain("thatch-refine-oss-contribution");
    expect(skillNames).not.toContain("thatch-code-review");

    for (const skill of result.skills.added) {
      expect(existsSync(skill.path)).toBe(true);
      const content = readFileSync(skill.path, "utf8");
      // Syntax check: YAML frontmatter with name/description (not content fidelity)
      expect(content.trimStart().startsWith("---")).toBe(true);
      expect(content).toContain("\nname: ");
      expect(content).toContain("description:");
      // Frontmatter closes with second ---
      const frontEnd = content.indexOf("\n---", 3);
      expect(frontEnd).toBeGreaterThan(3);
    }

    // A project-local run must not create user-scoped skills.
    expect(existsSync(join(fakeHome, ".claude", "skills"))).toBe(false);
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
    expect(text).toContain("mcp__thatch__get_extraction_payload");
    expect(text).toContain("mcp__thatch__behavior_codify");
    expect(text).toContain("mcp__thatch__behavior_feedback");
    expect(text).toContain("mcp__thatch__behavior_list");
    expect(text).toContain("mcp__thatch__behavior_delete");
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

  test("startup recall examples teach the Code Mode execute fallback", () => {
    const text = systemPrompt("test/repo");
    expect(text).toContain("through the Code Mode execute runtime");
  });

  test("MCP host instructions teach the object-argument shape", () => {
    for (const text of [claudeInstructions(), cursorInstructions()]) {
      expect(text).toContain('memory_recall` with `{"query": "user preferences and personality"}`');
      expect(text).toContain("never a bare positional string");
    }
  });

  test("includes review-discussion prediction guidance", () => {
    const text = claudeInstructions();
    expect(text).toContain("Code review discussions are high-signal prediction material");
    expect(text).toContain("review threshold, severity, tone, evidence, scope, false positives");
  });

  test("includes class-lesson guidance for predictions and behaviors", () => {
    const text = claudeInstructions();
    // The class-lesson paragraphs are shared constants - all prompt
    // variants must carry them verbatim (assertions stay within single
    // source lines - the paragraphs are hard-wrapped).
    expect(text).toContain("reveals a CLASS of mistake");
    expect(text).toContain("The same class discipline applies to judgment errors");
    expect(text).toContain("names this incident never fires");
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
      // skills are installed under the custom dir
      expect(result.skills.dir).toBe(join(customDir, "skills"));
      expect(result.skills.added.length).toBe(37);
      for (const skill of result.skills.added) {
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

  test("project-local install keeps everything in the repo (skills included)", () => {
    const customDir = mkdtempSync(join(tmpdir(), "thatch-custom-config-"));
    process.env.CLAUDE_CONFIG_DIR = customDir;
    try {
      const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

      // Project-local: CLAUDE.md, settings, AND skills stay in the repo.
      expect(result.claudeMd).toBe(join(projectDir, "CLAUDE.md"));
      expect(result.settings).toBe(join(projectDir, ".claude", "settings.json"));
      expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(projectDir, ".claude", "settings.json"))).toBe(true);

      expect(result.skills.dir).toBe(join(projectDir, ".claude", "skills"));
      expect(result.skills.added.length).toBe(37);
      for (const skill of result.skills.added) {
        expect(skill.path.startsWith(projectDir + "/")).toBe(true);
      }

      // Neither the custom config dir nor ~/.claude/skills may be created.
      expect(existsSync(join(customDir, "skills"))).toBe(false);
      expect(existsSync(join(fakeHome, ".claude", "skills"))).toBe(false);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  test("unset CLAUDE_CONFIG_DIR falls back to ~/.claude (the default)", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);

    expect(result.claudeMd).toBe(join(fakeHome, ".claude", "CLAUDE.md"));
    expect(result.settings).toBe(join(fakeHome, ".claude", "settings.json"));
    expect(result.skills.dir).toBe(join(fakeHome, ".claude", "skills"));
  });
});

describe("registerClaudeMcpServer", () => {
  test("claude missing -> manual fallback", async () => {
    const reg = await registerClaudeMcpServer("/usr/bin/thatch", { claudeBin: null });
    expect(reg.status).toBe("claude-missing");
    expect(reg.manualCommand).toContain("claude mcp add --scope user thatch");
  });

  test("existing registration is left alone", async () => {
    const calls: string[][] = [];
    const reg = await registerClaudeMcpServer("/usr/bin/thatch", {
      claudeBin: "/fake/claude",
      run: async (argv) => {
        calls.push(argv);
        return { exitCode: 0 };
      },
    });
    expect(reg.status).toBe("already-registered");
    // Only the get probe ran; no add, no remove.
    expect(calls).toHaveLength(1);
    expect(calls[0].join(" ")).toContain("mcp get thatch");
  });

  test("absent registration is added at user scope", async () => {
    const calls: string[][] = [];
    const reg = await registerClaudeMcpServer("/usr/bin/thatch", {
      claudeBin: "/fake/claude",
      run: async (argv) => {
        calls.push(argv);
        return { exitCode: argv[2] === "get" ? 1 : 0 };
      },
    });
    expect(reg.status).toBe("registered");
    expect(calls).toHaveLength(2);
    const add = calls[1];
    expect(add.join(" ")).toContain("mcp add --scope user thatch");
    expect(add.slice(-2)).toEqual(["/usr/bin/thatch", "mcp"]);
  });

  test("failing add -> failed status with manual command", async () => {
    const reg = await registerClaudeMcpServer("/usr/bin/thatch", {
      claudeBin: "/fake/claude",
      run: async (argv) => ({ exitCode: argv[2] === "get" ? 1 : 3 }),
    });
    expect(reg.status).toBe("failed");
    expect(reg.manualCommand).toContain("claude mcp add --scope user thatch");
  });

  test("spawn failure (claude crashed) -> failed, not thrown", async () => {
    const reg = await registerClaudeMcpServer("/usr/bin/thatch", {
      claudeBin: "/fake/claude",
      run: async () => {
        throw new Error("ENOENT-ish disaster");
      },
    });
    expect(reg.status).toBe("failed");
    expect(reg.detail).toContain("disaster");
  });

  test("helper matches the setup CLI export", () => {
    // The CLI's setup case calls this helper on the same result it prints;
    // the manual command must match what setup reports.
    const result = setupClaudeCode(join(projectDir, "bin", "thatch"), true, projectDir, fakeHome);
    expect(result.mcpAddCommand).toContain("claude mcp add --scope user thatch --");
  });
});
