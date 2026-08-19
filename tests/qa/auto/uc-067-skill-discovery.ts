import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-067: Skill discovery.
 *
 * Automatable: yes — file presence and structure assertions. Each host's
 * skill discovery mechanism is external to thatch (thatch only writes the
 * files). This test runs setup and verifies SKILL.md files exist in each
 * host's skills directory with valid content.
 */

const useCase: UseCase = {
  name: "UC-067-skill-discovery",
  preconditions: [
    "- Thatch installed and `bun` on PATH",
    "- `thatch setup --claude` and/or `--cursor` has been run",
  ].join("\n"),
  steps: [
    "1. Run `thatch setup --claude`. Verify SKILL.md files exist under $CLAUDE_CONFIG_DIR/skills/thatch-*/.",
    "2. Run `thatch setup --cursor`. Verify SKILL.md files exist under ~/.cursor/skills/thatch-*/.",
  ].join("\n"),
  expected: [
    "- Each host's skills directory contains thatch-*/SKILL.md files after setup.",
    "- The SKILL.md files are verbatim copies of the artifact definitions with ${REVIEW_COMMON} interpolated.",
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

    const claudeSkillDirs = readdirSync(claudeSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));

    if (claudeSkillDirs.length === 0) {
      console.log("  FAIL: no thatch-* skill directories found for Claude");
      return "FAIL";
    }

    // Each skill dir should have a SKILL.md file.
    for (const name of claudeSkillDirs) {
      const skillFile = join(claudeSkillsDir, name, "SKILL.md");
      if (!existsSync(skillFile)) {
        console.log(`  FAIL: ${name}/SKILL.md not found`);
        return "FAIL";
      }
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

    const cursorSkillDirs = readdirSync(cursorSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));

    if (cursorSkillDirs.length === 0) {
      console.log("  FAIL: no thatch-* skill directories found for Cursor");
      return "FAIL";
    }

    for (const name of cursorSkillDirs) {
      const skillFile = join(cursorSkillsDir, name, "SKILL.md");
      if (!existsSync(skillFile)) {
        console.log(`  FAIL: ${name}/SKILL.md not found for Cursor`);
        return "FAIL";
      }
    }

    return "PASS";
  },
};

registerUseCase(useCase);
