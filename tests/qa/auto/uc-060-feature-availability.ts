import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-060: Feature availability by host.
 *
 * Automatable: yes — skill dir inspection after setup. The code-review
 * coordinator skill (thatch-code-review) is only installed for opencode
 * (which has sub-agent support). MCP hosts (Claude Code, Cursor) get
 * SHARED_SKILLS only (25 skills, no coordinator).
 */

const useCase: UseCase = {
  name: "UC-060-feature-availability",
  preconditions: [
    "- Thatch installed and `bun` on PATH",
    "- `thatch setup --claude` and `thatch setup --cursor` will be run as part of the test",
  ].join("\n"),
  steps: [
    "1. Run `thatch setup --claude`. List $CLAUDE_CONFIG_DIR/skills/.",
    "2. Run `thatch setup --cursor`. List ~/.cursor/skills/.",
    "3. Check whether thatch-code-review appears in each directory.",
  ].join("\n"),
  expected: [
    "- Claude Code: 25 thatch-* skill directories present. thatch-code-review is absent.",
    "- Cursor: 25 thatch-* skill directories present. thatch-code-review is absent.",
    "- opencode: 26 thatch-* skill directories present. thatch-code-review is present (verified by uc-014).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const dir = ctx.dir;
    const run = (args: string[]) => $`${bin} ${args}`.env(env).cwd(dir).quiet().nothrow();

    // Step 1: Claude setup.
    const r1 = await run(["setup", "--claude"]);
    if (r1.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --claude` exited non-zero");
      return "FAIL";
    }

    const claudeSkillsDir = join(env.CLAUDE_CONFIG_DIR, "skills");
    if (!existsSync(claudeSkillsDir)) {
      console.log("  FAIL: Claude skills dir not created");
      return "FAIL";
    }

    const claudeSkills = readdirSync(claudeSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));

    if (claudeSkills.length !== 25) {
      console.log(`  FAIL: Claude skills count is ${claudeSkills.length}, expected 25`);
      return "FAIL";
    }
    if (claudeSkills.includes("thatch-code-review")) {
      console.log("  FAIL: thatch-code-review should NOT be installed for Claude");
      return "FAIL";
    }

    // Step 2: Cursor setup.
    const r2 = await run(["setup", "--cursor"]);
    if (r2.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --cursor` exited non-zero");
      return "FAIL";
    }

    const cursorSkillsDir = join(env.HOME, ".cursor", "skills");
    if (!existsSync(cursorSkillsDir)) {
      console.log("  FAIL: Cursor skills dir not created");
      return "FAIL";
    }

    const cursorSkills = readdirSync(cursorSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));

    if (cursorSkills.length !== 25) {
      console.log(`  FAIL: Cursor skills count is ${cursorSkills.length}, expected 25`);
      return "FAIL";
    }
    if (cursorSkills.includes("thatch-code-review")) {
      console.log("  FAIL: thatch-code-review should NOT be installed for Cursor");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
