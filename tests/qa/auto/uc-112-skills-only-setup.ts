import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-112: Skills-only setup (`thatch setup --skills-only`).
 *
 * Automatable: yes — CLI assertions that the flag installs only the skill
 * files (same scope rules as full setup) and leaves MCP config,
 * instructions, hooks, and commands untouched.
 * `setup.test.ts` covers the unit contract; this is the end-to-end
 * runbook version.
 */

const useCase: UseCase = {
  name: "UC-112-skills-only-setup",
  preconditions: [
    "- Thatch installed and `bun` on PATH",
    "- Target config dirs writable (`$CLAUDE_CONFIG_DIR`, `~/.cursor`)",
  ].join("\n"),
  steps: [
    "1. Seed a thatch skill in the user config dir, then from a project root:",
    "   `thatch setup --claude --skills-only`",
    "2. From the same project root: `thatch setup --cursor --skills-only`",
    "3. Run `thatch setup --claude --skills-only` with no host flag variants:",
    "   `thatch setup --skills-only` (no --claude/--cursor) must be rejected",
    "4. `thatch setup --cursor --global --skills-only` and",
    "   `thatch setup --claude --global --skills-only`",
    "5. Full setup afterwards: `thatch setup --claude`",
  ].join("\n"),
  expected: [
    "- `--skills-only` installs **only** the skill files: the repo's `.claude/skills/`",
    "  (Claude) or `.cursor/skills/` (Cursor) gets the 35 shared skills, reported via",
    "  the skills dir plus `35 added` on a fresh install and `35 unchanged` on re-run.",
    "- No MCP config (`.mcp.json` / `.cursor/mcp.json`), no instructions",
    "  (`CLAUDE.md` / `AGENTS.md`), no hooks (`.claude/settings.json` /",
    "  `.cursor/hooks.json`), and no `/thatch/*` commands are written.",
    "- The other-scope note still prints: a user-scope thatch skill is surfaced",
    "  (named with its directory) and left exactly as it was.",
    "- Omitting the host flag exits 1 with the usual 'Specify at least one host' error.",
    "- `--global --skills-only` writes skills to the host config dir only:",
    "  `$CLAUDE_CONFIG_DIR/skills/` (Claude) or `~/.cursor/skills/` (Cursor), with no",
    "  instructions or hooks files created there.",
    "- A full `thatch setup --claude` afterwards still writes everything it always",
    "  did (instructions, hooks, MCP config, commands) and reports skills unchanged.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const dir = ctx.dir;
    const run = (args: string[]) => $`${bin} ${args}`.env(env).cwd(dir).quiet().nothrow();
    const countThatchSkills = (skillsDir: string): number =>
      readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && d.name.startsWith("thatch-"))
        .length;

    // --- Step 1: thatch setup --claude --skills-only (project-local) ---

    // Seed a user-scope thatch skill so the other-scope note has something
    // to surface. Skills-only must report it and leave it alone.
    const userSkills = join(env.CLAUDE_CONFIG_DIR, "skills");
    mkdirSync(join(userSkills, "thatch-legacy"), { recursive: true });
    writeFileSync(join(userSkills, "thatch-legacy", "SKILL.md"), "old copy");

    const r1 = await run(["setup", "--claude", "--skills-only"]);
    if (r1.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --claude --skills-only` exited non-zero");
      console.log(`  stderr: ${r1.stderr.toString()}`);
      return "FAIL";
    }

    // Skills installed to the repo, exactly 35, none else.
    const claudeSkillsDir = join(dir, ".claude", "skills");
    if (!existsSync(claudeSkillsDir)) {
      console.log("  FAIL: --skills-only did not create the repo .claude/skills dir");
      return "FAIL";
    }
    const claudeSkillCount = countThatchSkills(claudeSkillsDir);
    if (claudeSkillCount !== 35) {
      console.log(`  FAIL: --skills-only Claude skills count is ${claudeSkillCount}, expected 35`);
      return "FAIL";
    }
    if (!existsSync(join(claudeSkillsDir, "thatch-review-pedantic", "SKILL.md"))) {
      console.log("  FAIL: --skills-only did not install a known shared skill");
      return "FAIL";
    }

    // Everything else full setup writes must be absent.
    for (const [label, path] of [
      [".mcp.json", join(dir, ".mcp.json")],
      ["CLAUDE.md", join(dir, "CLAUDE.md")],
      [".claude/settings.json", join(dir, ".claude", "settings.json")],
      [".claude/commands", join(dir, ".claude", "commands")],
    ] as const) {
      if (existsSync(path)) {
        console.log(`  FAIL: --skills-only wrote ${label} (expected skills only)`);
        return "FAIL";
      }
    }

    // Reporting: skills dir named, fresh-install counts, other-scope note.
    const out1 = r1.stdout.toString();
    if (!out1.includes(claudeSkillsDir) || !out1.includes("35 added")) {
      console.log("  FAIL: --skills-only stdout does not report the skills dir + '35 added'");
      return "FAIL";
    }
    if (!out1.includes(userSkills)) {
      console.log("  FAIL: --skills-only stdout does not surface the other-scope skills dir");
      return "FAIL";
    }
    if (readFileSync(join(userSkills, "thatch-legacy", "SKILL.md"), "utf8") !== "old copy") {
      console.log("  FAIL: --skills-only modified the other-scope skill copy");
      return "FAIL";
    }

    // --- Step 2: thatch setup --cursor --skills-only (project-local) ---

    const r2 = await run(["setup", "--cursor", "--skills-only"]);
    if (r2.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --cursor --skills-only` exited non-zero");
      console.log(`  stderr: ${r2.stderr.toString()}`);
      return "FAIL";
    }
    const cursorSkillsDir = join(dir, ".cursor", "skills");
    if (countThatchSkills(cursorSkillsDir) !== 35) {
      console.log("  FAIL: --skills-only Cursor skills count is not 35");
      return "FAIL";
    }
    for (const [label, path] of [
      [".cursor/mcp.json", join(dir, ".cursor", "mcp.json")],
      ["AGENTS.md", join(dir, "AGENTS.md")],
      [".cursor/hooks.json", join(dir, ".cursor", "hooks.json")],
    ] as const) {
      if (existsSync(path)) {
        console.log(`  FAIL: --skills-only wrote ${label} (expected skills only)`);
        return "FAIL";
      }
    }

    // Idempotence: a re-run reports unchanged, not re-added.
    const r2b = await run(["setup", "--cursor", "--skills-only"]);
    if (!r2b.stdout.toString().includes("35 unchanged")) {
      console.log("  FAIL: --skills-only re-run does not report '35 unchanged'");
      return "FAIL";
    }

    // --- Step 3: the host flag is still required ---

    const r3 = await run(["setup", "--skills-only"]);
    if (r3.exitCode === 0) {
      console.log("  FAIL: `thatch setup --skills-only` without a host flag should exit 1");
      return "FAIL";
    }
    if (!r3.stderr.toString().includes("Specify at least one host")) {
      console.log("  FAIL: host-flag rejection does not print the 'Specify at least one host' error");
      return "FAIL";
    }

    // --- Step 4: --global --skills-only writes config-dir skills only ---

    const r4x = await run(["setup", "--cursor", "--global", "--skills-only"]);
    if (r4x.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --cursor --global --skills-only` exited non-zero");
      return "FAIL";
    }
    const cursorGlobalSkills = join(env.HOME, ".cursor", "skills");
    if (countThatchSkills(cursorGlobalSkills) !== 35) {
      console.log("  FAIL: global --skills-only did not install 35 skills to ~/.cursor/skills");
      return "FAIL";
    }
    for (const [label, path] of [
      ["~/.cursor/mcp.json", join(env.HOME, ".cursor", "mcp.json")],
      ["~/.cursor/AGENTS.md", join(env.HOME, ".cursor", "AGENTS.md")],
      ["~/.cursor/hooks.json", join(env.HOME, ".cursor", "hooks.json")],
    ] as const) {
      if (existsSync(path)) {
        console.log(`  FAIL: global --skills-only wrote ${label}`);
        return "FAIL";
      }
    }

    const r4c = await run(["setup", "--claude", "--global", "--skills-only"]);
    if (r4c.exitCode !== 0) {
      console.log("  FAIL: `thatch setup --claude --global --skills-only` exited non-zero");
      return "FAIL";
    }
    const claudeGlobalSkills = join(env.CLAUDE_CONFIG_DIR, "skills");
    if (countThatchSkills(claudeGlobalSkills) !== 35) {
      console.log("  FAIL: global --skills-only did not install 35 skills to $CLAUDE_CONFIG_DIR/skills");
      return "FAIL";
    }
    for (const [label, path] of [
      ["config-dir CLAUDE.md", join(env.CLAUDE_CONFIG_DIR, "CLAUDE.md")],
      ["config-dir settings.json", join(env.CLAUDE_CONFIG_DIR, "settings.json")],
    ] as const) {
      if (existsSync(path)) {
        console.log(`  FAIL: global --skills-only wrote ${label}`);
        return "FAIL";
      }
    }

    // --- Step 5: full setup afterwards still writes everything ---

    const r5 = await run(["setup", "--claude"]);
    if (r5.exitCode !== 0) {
      console.log("  FAIL: full `thatch setup --claude` after --skills-only exited non-zero");
      return "FAIL";
    }
    for (const [label, path] of [
      [".mcp.json", join(dir, ".mcp.json")],
      ["CLAUDE.md", join(dir, "CLAUDE.md")],
      [".claude/settings.json", join(dir, ".claude", "settings.json")],
    ] as const) {
      if (!existsSync(path)) {
        console.log(`  FAIL: full setup after --skills-only did not write ${label}`);
        return "FAIL";
      }
    }
    if (!r5.stdout.toString().includes("35 unchanged")) {
      console.log("  FAIL: full setup does not report skills '35 unchanged' after --skills-only");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
