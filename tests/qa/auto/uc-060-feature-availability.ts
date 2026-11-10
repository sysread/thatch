import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-060: Feature availability by host.
 *
 * Automatable: yes — skill dir inspection after setup. The code-review
 * coordinator skill (thatch-code-review) is SHARED (flat sub-agent
 * dispatch works on every host); thatch-coordination is the one
 * opencode-only skill (it drives the v2 session-tab bridge). MCP hosts
 * (Claude Code, Cursor) get SHARED_SKILLS only.
 */

const useCase: UseCase = {
  name: "UC-060-feature-availability",
  preconditions: [
    "- Thatch installed and `bun` on PATH",
    "- `thatch setup --claude` and `thatch setup --cursor` will be run as part of the test",
  ].join("\n"),
  steps: [
    "1. Run `thatch setup --claude`. List the repo's `.claude/skills/`.",
    "2. Run `thatch setup --cursor`. List the repo's `.cursor/skills/`.",
    "3. Check whether thatch-code-review appears in each directory.",
  ].join("\n"),
  expected: [
    "- Claude Code: 42 thatch-* skill directories present (the repo's tracked thatch-plugin-qa rides along). thatch-code-review is present (it is shared).",
    "- Cursor: 41 thatch-* skill directories present. thatch-code-review is present (it is shared).",
    "- opencode: 42 thatch-* skill directories present. thatch-code-review and thatch-coordination are present (fixture fidelity is what uc-014 checks).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const dir = ctx.dir;
    const run = (args: string[]) => $`${bin} ${args}`.env(env).cwd(dir).quiet().nothrow();

    // Step 1: Claude setup.
    const r1 = await run(["setup", "--claude", "--hooks"]);
    if (r1.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --claude` exited non-zero");
      return "FAIL";
    }

    const claudeSkillsDir = join(dir, ".claude", "skills");
    if (!existsSync(claudeSkillsDir)) {
      console.log("  FAIL: Claude skills dir not created in the repo");
      return "FAIL";
    }

    const claudeSkills = readdirSync(claudeSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));

    if (claudeSkills.length !== 42) {
      console.log(`  FAIL: Claude skills count is ${claudeSkills.length}, expected 42`);
      return "FAIL";
    }
    if (!claudeSkills.includes("thatch-code-review")) {
      console.log("  FAIL: thatch-code-review coordinator should be installed for Claude (it is SHARED - flat dispatch works)");
      return "FAIL";
    }

    // Step 2: Cursor setup.
    const r2 = await run(["setup", "--cursor"]);
    if (r2.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --cursor` exited non-zero");
      return "FAIL";
    }

    const cursorSkillsDir = join(dir, ".cursor", "skills");
    if (!existsSync(cursorSkillsDir)) {
      console.log("  FAIL: Cursor skills dir not created in the repo");
      return "FAIL";
    }

    const cursorSkills = readdirSync(cursorSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));

    if (cursorSkills.length !== 41) {
      console.log(`  FAIL: Cursor skills count is ${cursorSkills.length}, expected 41`);
      return "FAIL";
    }
    if (!cursorSkills.includes("thatch-code-review")) {
      console.log("  FAIL: thatch-code-review coordinator should be installed for Cursor (it is SHARED - flat dispatch works)");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
