import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupCursor } from "../src/setup";
import { cursorInstructions } from "../src/prompts";
import { installSetupHarness, projectDir, fakeHome } from "./mocks/setup-harness";

installSetupHarness();

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

  test("installs skills to the repo's .cursor/skills/ (project-local)", () => {
    const result = setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.skills.dir).toBe(join(projectDir, ".cursor", "skills"));
    expect(result.skills.added.length).toBe(36);
    expect(result.skills.updated).toEqual([]);
    expect(result.skills.unchanged).toEqual([]);
    expect(result.skills.removed).toEqual([]);

    const skillNames = result.skills.added.map((s) => s.name);
    expect(skillNames).toContain("thatch-fact-extractor");
    expect(skillNames).toContain("thatch-dedup-classifier");
    expect(skillNames).toContain("thatch-project-primer");
    expect(skillNames).toContain("thatch-review-mark-and-sweep");
    expect(skillNames).toContain("thatch-review-highlights");
    expect(skillNames).toContain("thatch-review-technique");
    expect(skillNames).toContain("thatch-review-economy");
    expect(skillNames).toContain("thatch-review-followup");
    expect(skillNames).toContain("thatch-change-walkthrough");
    expect(skillNames).toContain("thatch-code-walkthrough");
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
      expect(skill.path).toContain(".cursor/skills");
      const content = readFileSync(skill.path, "utf8");
      expect(content).toContain("name: ");
    }

    // A project-local run must not create user-scoped skills.
    expect(existsSync(join(fakeHome, ".cursor", "skills"))).toBe(false);
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

  test("skills installed to ~/.cursor/skills/ (global)", () => {
    const result = setupCursor("/usr/local/bin/thatch", true, projectDir, fakeHome);

    expect(result.skills.dir).toBe(join(fakeHome, ".cursor", "skills"));
    expect(result.skills.added.length).toBe(36);
    for (const skill of result.skills.added) {
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
    expect(text).toContain("mcp__thatch__get_extraction_payload");
    expect(text).toContain("mcp__thatch__behavior_codify");
    expect(text).toContain("mcp__thatch__behavior_feedback");
    expect(text).toContain("mcp__thatch__behavior_list");
    expect(text).toContain("mcp__thatch__behavior_delete");
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

  test("includes review-discussion prediction guidance", () => {
    const text = cursorInstructions();
    expect(text).toContain("Code review discussions are high-signal prediction material");
    expect(text).toContain("review threshold, severity, tone, evidence, scope, false positives");
  });

  test("includes class-lesson guidance for predictions and behaviors", () => {
    const text = cursorInstructions();
    // The class-lesson paragraphs are shared constants - all prompt
    // variants must carry them verbatim (assertions stay within single
    // source lines - the paragraphs are hard-wrapped).
    expect(text).toContain("reveals a CLASS of mistake");
    expect(text).toContain("The same class discipline applies to judgment errors");
    expect(text).toContain("names this incident never fires");
  });
});
