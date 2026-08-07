import { $ } from "bun";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-014: Skill install and drift recovery.
 *
 * Automatable: yes — file presence, count (21 vs 22), content-diff-overwrite,
 * and coordinator host-gating are all file assertions (`setup.test.ts` already
 * covers the unit contract). The opencode skill count (22) is verified against
 * the pre-populated config dir from ensureMaster.
 */

const useCase: UseCase = {
  name: "UC-014-skill-install-drift",
  preconditions: [
    "- Thatch installed; the host's skills directory empty",
    "- `bun` on PATH",
  ].join("\n"),
  steps: [
    "1. `thatch setup --claude` (and/or start an opencode session, and/or",
    "   `thatch setup --cursor`).",
    "2. List the skills directory.",
    "3. Edit one `SKILL.md` file locally to introduce drift.",
    "4. Re-run `setup` (or restart opencode).",
    "5. Check whether the `thatch-code-review` coordinator skill is present.",
  ].join("\n"),
  expected: [
    "- Claude Code and Cursor install exactly **21 shared skills** to the skills",
    "  dir — the coordinator (`thatch-code-review`) is **absent** (it needs",
    "  sub-agents, which those hosts lack).",
    "- opencode installs **22** — the 21 shared plus the coordinator.",
    "- The locally edited `SKILL.md` is **overwritten** with the canonical content",
    "  on the next `setup`/init (drift detection: a file is only rewritten when its",
    "  content differs from the definition). Unrelated skill files are untouched.",
    "- Skills never land in the worktree — always under the user-scoped config dir",
    "  (`~/.claude/skills`, `~/.cursor/skills`, `$XDG_CONFIG_HOME/opencode/skills`).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const dir = ctx.dir;
    const run = (args: string[]) => $`${bin} ${args}`.env(env).cwd(dir).quiet().nothrow();

    // --- Step 1: Setup for Claude and Cursor ---

    const r1 = await run(["setup", "--claude"]);
    if (r1.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --claude` exited non-zero");
      return "FAIL";
    }
    const r2 = await run(["setup", "--cursor"]);
    if (r2.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --cursor` exited non-zero");
      return "FAIL";
    }

    // --- Step 2: Skill counts (21 for Claude/Cursor, 22 for opencode) ---

    // Claude: 21 shared, no coordinator
    const claudeSkillsDir = join(env.CLAUDE_CONFIG_DIR, "skills");
    if (!existsSync(claudeSkillsDir)) {
      console.log("  FAIL: Claude skills dir not created");
      return "FAIL";
    }
    const claudeSkills = readdirSync(claudeSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));
    if (claudeSkills.length !== 21) {
      console.log(`  FAIL: Claude skills count is ${claudeSkills.length}, expected 21`);
      return "FAIL";
    }
    if (claudeSkills.includes("thatch-code-review")) {
      console.log("  FAIL: thatch-code-review coordinator should NOT be installed for Claude");
      return "FAIL";
    }

    // Cursor: 21 shared, no coordinator
    const cursorSkillsDir = join(env.HOME, ".cursor", "skills");
    if (!existsSync(cursorSkillsDir)) {
      console.log("  FAIL: Cursor skills dir not created");
      return "FAIL";
    }
    const cursorSkills = readdirSync(cursorSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));
    if (cursorSkills.length !== 21) {
      console.log(`  FAIL: Cursor skills count is ${cursorSkills.length}, expected 21`);
      return "FAIL";
    }
    if (cursorSkills.includes("thatch-code-review")) {
      console.log("  FAIL: thatch-code-review coordinator should NOT be installed for Cursor");
      return "FAIL";
    }

    // opencode: 22 (21 shared + 1 coordinator), pre-populated by ensureMaster
    const opencodeSkillsDir = join(dir, "config", "opencode", "skills");
    if (!existsSync(opencodeSkillsDir)) {
      console.log("  PARTIAL: opencode skills dir not found (ensureMaster may not have pre-populated it)");
      return "PARTIAL";
    }
    const opencodeSkills = readdirSync(opencodeSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => n.startsWith("thatch-"));
    if (opencodeSkills.length !== 22) {
      console.log(`  FAIL: opencode skills count is ${opencodeSkills.length}, expected 22`);
      return "FAIL";
    }
    if (!opencodeSkills.includes("thatch-code-review")) {
      console.log("  FAIL: thatch-code-review coordinator should be present for opencode");
      return "FAIL";
    }

    // --- Step 3: Introduce drift ---

    const driftSkillName = "thatch-fact-extractor";
    const driftSkillPath = join(claudeSkillsDir, driftSkillName, "SKILL.md");
    if (!existsSync(driftSkillPath)) {
      console.log(`  FAIL: ${driftSkillName}/SKILL.md not found`);
      return "FAIL";
    }
    const canonicalContent = readFileSync(driftSkillPath, "utf8");

    // Save an unrelated skill's content to verify it's untouched after re-run.
    const otherSkillPath = join(claudeSkillsDir, "thatch-dedup-classifier", "SKILL.md");
    const otherBefore = readFileSync(otherSkillPath, "utf8");

    const driftedContent = "# DRIFTED CONTENT\n\nThis file was edited to introduce drift.\n";
    writeFileSync(driftSkillPath, driftedContent);
    if (readFileSync(driftSkillPath, "utf8") !== driftedContent) {
      console.log("  FAIL: could not write drift to SKILL.md");
      return "FAIL";
    }

    // --- Step 4: Re-run setup (drift recovery) ---

    await run(["setup", "--claude"]);

    // Drifted skill should be overwritten with canonical content.
    if (readFileSync(driftSkillPath, "utf8") !== canonicalContent) {
      console.log("  FAIL: drifted SKILL.md was not overwritten with canonical content");
      return "FAIL";
    }

    // Unrelated skill file should be untouched.
    if (readFileSync(otherSkillPath, "utf8") !== otherBefore) {
      console.log("  FAIL: unrelated skill file was modified by re-run");
      return "FAIL";
    }

    // --- Step 5: Skills never land in the worktree ---

    if (existsSync(join(dir, "skills"))) {
      console.log("  FAIL: skills/ dir found in worktree (should be user-scoped only)");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
