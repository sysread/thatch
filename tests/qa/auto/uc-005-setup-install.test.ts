import { $ } from "bun";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-005: Setup install (Claude Code and Cursor).
 *
 * Automatable: yes — file presence and shape assertions on `.mcp.json`,
 * `hooks.json`, `CLAUDE.md`/`AGENTS.md` blocks, and the skills directory.
 * `setup.test.ts` already covers the unit contract; this is the end-to-end
 * runbook version.
 */

const useCase: UseCase = {
  name: "UC-005-setup-install",
  preconditions: [
    "- Thatch installed and `bun` on PATH",
    "- Target config dirs writable (`$XDG_CONFIG_HOME`, `$CLAUDE_CONFIG_DIR`, `~/.cursor`)",
  ].join("\n"),
  steps: [
    "1. From a project root: `thatch setup --claude`",
    "2. From the same project root: `thatch setup --cursor`",
    "3. Repeat both commands (re-run idempotence and drift recovery)",
    "4. Add a non-thatch hook to `.claude/settings.json` and `.cursor/hooks.json`,",
    "   then re-run setup",
    "5. From elsewhere: `thatch setup --cursor --global`, then `thatch setup --claude --global`",
  ].join("\n"),
  expected: [
    '- `--claude` project-local writes `.mcp.json` (`mcpServers.thatch`, stdio + `["mcp"]`),',
    "  appends a thatch block to `CLAUDE.md` bracketed by start/end markers (replaced, not",
    "  duplicated, on re-run), writes `.claude/settings.json` hooks (`SessionStart` -> `thatch reminder`,",
    "  `PostToolBatch` -> `thatch buffer-batch`, `UserPromptSubmit` -> `thatch flush-tools`), and installs",
    "  **21 shared skills** (no code-review coordinator) to `$CLAUDE_CONFIG_DIR/skills/` — user-scoped",
    "  even in project-local mode.",
    "- `--cursor` project-local writes `.cursor/mcp.json`, appends to `AGENTS.md`, writes",
    "  `.cursor/hooks.json` in the **flat format** (`{version:1, hooks:{...}}`): `sessionStart` ->",
    "  `thatch reminder --json`, `postToolUse` -> `thatch buffer-tool`, `beforeSubmitPrompt` ->",
    "  `thatch flush-tools --json`; and installs 21 shared skills to `~/.cursor/skills/`.",
    "- Re-run is idempotent: instructions are not duplicated, thatch hooks are replaced (not appended),",
    "  and non-thatch hooks are preserved. A legacy `thatch echo` hook is replaced with `flush-tools`.",
    "- `--global` (Claude) writes `~/.claude/CLAUDE.md` + `~/.claude/settings.json` but **no project",
    "  `.mcp.json`** — it prints a `claude mcp add --scope user` command instead. `--global` (Cursor)",
    "  writes `~/.cursor/mcp.json`, `~/.cursor/AGENTS.md`, `~/.cursor/hooks.json`, `~/.cursor/skills/`.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const dir = ctx.dir;
    const run = (args: string[]) => $`${bin} ${args}`.env(env).cwd(dir).quiet().nothrow();

    // --- Step 1: thatch setup --claude (project-local) ---

    const r1 = await run(["setup", "--claude"]);
    if (r1.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --claude` exited non-zero");
      console.log(`  stderr: ${r1.stderr.toString()}`);
      return "FAIL";
    }

    // .mcp.json — mcpServers.thatch, type stdio, args ["mcp"]
    const mcpPath = join(dir, ".mcp.json");
    if (!existsSync(mcpPath)) {
      console.log("  FAIL: .mcp.json not written");
      return "FAIL";
    }
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    if (!mcp.mcpServers?.thatch) {
      console.log("  FAIL: .mcp.json missing mcpServers.thatch");
      return "FAIL";
    }
    if (mcp.mcpServers.thatch.type !== "stdio") {
      console.log(`  FAIL: .mcp.json thatch type is "${mcp.mcpServers.thatch.type}", expected "stdio"`);
      return "FAIL";
    }
    if (!Array.isArray(mcp.mcpServers.thatch.args) || !mcp.mcpServers.thatch.args.includes("mcp")) {
      console.log('  FAIL: .mcp.json thatch args missing "mcp"');
      return "FAIL";
    }

    // CLAUDE.md — thatch instructions block
    const claudeMdPath = join(dir, "CLAUDE.md");
    if (!existsSync(claudeMdPath)) {
      console.log("  FAIL: CLAUDE.md not written");
      return "FAIL";
    }
    if (!readFileSync(claudeMdPath, "utf8").includes("# Persistence")) {
      console.log("  FAIL: CLAUDE.md missing thatch instructions block");
      return "FAIL";
    }

    // .claude/settings.json — SessionStart, PostToolBatch, UserPromptSubmit hooks
    const settingsPath = join(dir, ".claude", "settings.json");
    if (!existsSync(settingsPath)) {
      console.log("  FAIL: .claude/settings.json not written");
      return "FAIL";
    }
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const hooks = settings.hooks ?? {};
    const findHook = (event: string, frag: string): boolean =>
      hooks[event]?.some((g: any) => g.hooks?.some((h: any) => h.command?.includes(frag)));
    if (!findHook("SessionStart", "thatch reminder")) {
      console.log("  FAIL: settings.json missing SessionStart -> thatch reminder");
      return "FAIL";
    }
    if (!findHook("PostToolBatch", "thatch buffer-batch")) {
      console.log("  FAIL: settings.json missing PostToolBatch -> thatch buffer-batch");
      return "FAIL";
    }
    if (!findHook("UserPromptSubmit", "thatch flush-tools")) {
      console.log("  FAIL: settings.json missing UserPromptSubmit -> thatch flush-tools");
      return "FAIL";
    }

    // Claude skills: 21 shared, no coordinator, under $CLAUDE_CONFIG_DIR/skills/
    const claudeSkillsDir = join(env.CLAUDE_CONFIG_DIR, "skills");
    if (!existsSync(claudeSkillsDir)) {
      console.log("  FAIL: Claude skills dir not created");
      return "FAIL";
    }
    const claudeSkillNames = readdirSync(claudeSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));
    if (claudeSkillNames.length !== 21) {
      console.log(`  FAIL: Claude skills count is ${claudeSkillNames.length}, expected 21`);
      return "FAIL";
    }
    if (claudeSkillNames.includes("thatch-code-review")) {
      console.log("  FAIL: thatch-code-review coordinator should NOT be installed for Claude");
      return "FAIL";
    }

    // --- Step 2: thatch setup --cursor (project-local) ---

    const r2 = await run(["setup", "--cursor"]);
    if (r2.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --cursor` exited non-zero");
      console.log(`  stderr: ${r2.stderr.toString()}`);
      return "FAIL";
    }

    // .cursor/mcp.json
    const cursorMcpPath = join(dir, ".cursor", "mcp.json");
    if (!existsSync(cursorMcpPath)) {
      console.log("  FAIL: .cursor/mcp.json not written");
      return "FAIL";
    }
    if (!JSON.parse(readFileSync(cursorMcpPath, "utf8")).mcpServers?.thatch) {
      console.log("  FAIL: .cursor/mcp.json missing mcpServers.thatch");
      return "FAIL";
    }

    // AGENTS.md
    const agentsMdPath = join(dir, "AGENTS.md");
    if (!existsSync(agentsMdPath)) {
      console.log("  FAIL: AGENTS.md not written");
      return "FAIL";
    }
    if (!readFileSync(agentsMdPath, "utf8").includes("# Persistence")) {
      console.log("  FAIL: AGENTS.md missing thatch instructions block");
      return "FAIL";
    }

    // .cursor/hooks.json — flat format: {version:1, hooks:{...}}
    const cursorHooksPath = join(dir, ".cursor", "hooks.json");
    if (!existsSync(cursorHooksPath)) {
      console.log("  FAIL: .cursor/hooks.json not written");
      return "FAIL";
    }
    const cursorHooks = JSON.parse(readFileSync(cursorHooksPath, "utf8"));
    if (cursorHooks.version !== 1) {
      console.log(`  FAIL: hooks.json version is ${cursorHooks.version}, expected 1`);
      return "FAIL";
    }
    const findCursorHook = (event: string, frag: string): boolean =>
      cursorHooks.hooks?.[event]?.some((e: any) => e.command?.includes(frag));
    if (!findCursorHook("sessionStart", "thatch reminder --json")) {
      console.log("  FAIL: hooks.json missing sessionStart -> thatch reminder --json");
      return "FAIL";
    }
    if (!findCursorHook("postToolUse", "thatch buffer-tool")) {
      console.log("  FAIL: hooks.json missing postToolUse -> thatch buffer-tool");
      return "FAIL";
    }
    if (!findCursorHook("beforeSubmitPrompt", "thatch flush-tools --json")) {
      console.log("  FAIL: hooks.json missing beforeSubmitPrompt -> thatch flush-tools --json");
      return "FAIL";
    }

    // Cursor skills: 21 shared, no coordinator, under ~/.cursor/skills/
    const cursorSkillsDir = join(env.HOME, ".cursor", "skills");
    if (!existsSync(cursorSkillsDir)) {
      console.log("  FAIL: Cursor skills dir not created");
      return "FAIL";
    }
    const cursorSkillNames = readdirSync(cursorSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));
    if (cursorSkillNames.length !== 21) {
      console.log(`  FAIL: Cursor skills count is ${cursorSkillNames.length}, expected 21`);
      return "FAIL";
    }
    if (cursorSkillNames.includes("thatch-code-review")) {
      console.log("  FAIL: thatch-code-review coordinator should NOT be installed for Cursor");
      return "FAIL";
    }

    // --- Step 3: Idempotence — re-run should produce identical files ---

    const claudeMdBefore = readFileSync(claudeMdPath, "utf8");
    const agentsMdBefore = readFileSync(agentsMdPath, "utf8");
    const settingsBefore = readFileSync(settingsPath, "utf8");
    const cursorHooksBefore = readFileSync(cursorHooksPath, "utf8");

    await run(["setup", "--claude"]);
    await run(["setup", "--cursor"]);

    if (readFileSync(claudeMdPath, "utf8") !== claudeMdBefore) {
      console.log("  FAIL: CLAUDE.md changed on re-run (not idempotent)");
      return "FAIL";
    }
    if (readFileSync(agentsMdPath, "utf8") !== agentsMdBefore) {
      console.log("  FAIL: AGENTS.md changed on re-run (not idempotent)");
      return "FAIL";
    }
    if (readFileSync(settingsPath, "utf8") !== settingsBefore) {
      console.log("  FAIL: .claude/settings.json changed on re-run (not idempotent)");
      return "FAIL";
    }
    if (readFileSync(cursorHooksPath, "utf8") !== cursorHooksBefore) {
      console.log("  FAIL: .cursor/hooks.json changed on re-run (not idempotent)");
      return "FAIL";
    }

    // --- Step 4: Non-thatch hooks preserved on re-run ---

    // Inject a non-thatch hook into Claude settings.json.
    const settingsParsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    settingsParsed.hooks.SessionStart.push({
      hooks: [{ type: "command", command: "echo non-thatch-claude" }],
    });
    writeFileSync(settingsPath, JSON.stringify(settingsParsed, null, 2) + "\n");

    // Inject a non-thatch hook into Cursor hooks.json.
    const cursorHooksParsed = JSON.parse(readFileSync(cursorHooksPath, "utf8"));
    cursorHooksParsed.hooks.sessionStart.push({ command: "echo non-thatch-cursor" });
    writeFileSync(cursorHooksPath, JSON.stringify(cursorHooksParsed, null, 2) + "\n");

    await run(["setup", "--claude"]);
    await run(["setup", "--cursor"]);

    // Non-thatch hooks should survive.
    const settingsAfter = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!settingsAfter.hooks.SessionStart?.some(
      (g: any) => g.hooks?.some((h: any) => h.command?.includes("non-thatch-claude")),
    )) {
      console.log("  FAIL: non-thatch hook not preserved in .claude/settings.json");
      return "FAIL";
    }
    const cursorHooksAfter = JSON.parse(readFileSync(cursorHooksPath, "utf8"));
    if (!cursorHooksAfter.hooks.sessionStart?.some(
      (e: any) => e.command?.includes("non-thatch-cursor"),
    )) {
      console.log("  FAIL: non-thatch hook not preserved in .cursor/hooks.json");
      return "FAIL";
    }

    // Thatch hooks should still be present (replaced, not lost).
    if (!settingsAfter.hooks.SessionStart?.some(
      (g: any) => g.hooks?.some((h: any) => h.command?.includes("thatch reminder")),
    )) {
      console.log("  FAIL: thatch hook missing from .claude/settings.json after re-run with non-thatch hook");
      return "FAIL";
    }
    if (!cursorHooksAfter.hooks.sessionStart?.some(
      (e: any) => e.command?.includes("thatch reminder --json"),
    )) {
      console.log("  FAIL: thatch hook missing from .cursor/hooks.json after re-run with non-thatch hook");
      return "FAIL";
    }

    // --- Step 5: --global mode ---

    // Claude --global: writes to config dir, no project .mcp.json, prints mcp add command.
    const claudeGlobal = await run(["setup", "--claude", "--global"]);
    if (claudeGlobal.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --claude --global` exited non-zero");
      return "FAIL";
    }
    if (!existsSync(join(env.CLAUDE_CONFIG_DIR, "CLAUDE.md"))) {
      console.log("  FAIL: global CLAUDE.md not written to config dir");
      return "FAIL";
    }
    if (!existsSync(join(env.CLAUDE_CONFIG_DIR, "settings.json"))) {
      console.log("  FAIL: global settings.json not written to config dir");
      return "FAIL";
    }
    if (!claudeGlobal.stdout.toString().includes("claude mcp add --scope user")) {
      console.log("  FAIL: --global (Claude) should print 'claude mcp add --scope user' command");
      return "FAIL";
    }

    // Cursor --global: writes everything to ~/.cursor/.
    const cursorGlobal = await run(["setup", "--cursor", "--global"]);
    if (cursorGlobal.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --cursor --global` exited non-zero");
      return "FAIL";
    }
    for (const [label, path] of [
      ["mcp.json", join(env.HOME, ".cursor", "mcp.json")],
      ["AGENTS.md", join(env.HOME, ".cursor", "AGENTS.md")],
      ["hooks.json", join(env.HOME, ".cursor", "hooks.json")],
      ["skills/", join(env.HOME, ".cursor", "skills")],
    ] as const) {
      if (!existsSync(path)) {
        console.log(`  FAIL: global ~/.cursor/${label} not written`);
        return "FAIL";
      }
    }

    return "PASS";
  },
};

registerUseCase(useCase);
