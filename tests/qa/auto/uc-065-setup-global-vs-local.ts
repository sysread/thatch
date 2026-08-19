import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-065: Setup global vs local.
 *
 * Automatable: yes — file presence assertions with the --global flag.
 * Claude global writes to config dirs and prints a `claude mcp add`
 * command instead of writing .mcp.json. Cursor global writes to
 * ~/.cursor/ directly.
 */

const useCase: UseCase = {
  name: "UC-065-setup-global-vs-local",
  preconditions: [
    "- Thatch installed and `bun` on PATH",
    "- `CLAUDE_CONFIG_DIR` set (or defaulting to `~/.claude`)",
    "- `~/.cursor/` writable",
  ].join("\n"),
  steps: [
    "1. Run `thatch setup --claude --global`.",
    "2. Check that $CLAUDE_CONFIG_DIR/CLAUDE.md and settings.json were written.",
    "3. Check that no .mcp.json was written in the current project directory.",
    "4. Check that stdout includes a `claude mcp add --scope user` command.",
    "5. Run `thatch setup --cursor --global`.",
    "6. Check that ~/.cursor/mcp.json, AGENTS.md, hooks.json, and skills/ were written.",
  ].join("\n"),
  expected: [
    "- Claude global: CLAUDE.md and settings.json in config dir. No project .mcp.json. stdout includes `claude mcp add --scope user`.",
    "- Cursor global: mcp.json, AGENTS.md, hooks.json, and skills/ all in ~/.cursor/.",
    "- Skills are always user-scoped, even in project-local mode.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const dir = ctx.dir;
    const run = (args: string[]) => $`${bin} ${args}`.env(env).cwd(dir).quiet().nothrow();

    // Step 1-4: Claude --global.
    const claudeGlobal = await run(["setup", "--claude", "--global"]);
    if (claudeGlobal.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --claude --global` exited non-zero");
      return "FAIL";
    }

    // CLAUDE.md in config dir.
    if (!existsSync(join(env.CLAUDE_CONFIG_DIR, "CLAUDE.md"))) {
      console.log("  FAIL: global CLAUDE.md not written to config dir");
      return "FAIL";
    }

    // settings.json in config dir.
    if (!existsSync(join(env.CLAUDE_CONFIG_DIR, "settings.json"))) {
      console.log("  FAIL: global settings.json not written to config dir");
      return "FAIL";
    }

    // No project .mcp.json.
    if (existsSync(join(dir, ".mcp.json"))) {
      console.log("  FAIL: .mcp.json should NOT be written in global mode");
      return "FAIL";
    }

    // stdout includes claude mcp add command.
    if (!claudeGlobal.stdout.toString().includes("claude mcp add --scope user")) {
      console.log("  FAIL: --global should print 'claude mcp add --scope user' command");
      return "FAIL";
    }

    // Step 5-6: Cursor --global.
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
