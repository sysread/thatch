import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-061: Setup idempotent rerun.
 *
 * Automatable: yes — file system assertions with controlled drift.
 * Re-running setup after content drift updates the thatch block, hooks,
 * and skill files without clobbering unrelated config. Non-thatch hooks
 * survive the re-run.
 */

const useCase: UseCase = {
  name: "UC-061-setup-idempotent-rerun",
  preconditions: [
    "- `thatch setup --claude` has run at least once",
    "- `bun` on PATH",
    "- Target config dirs writable",
  ].join("\n"),
  steps: [
    "1. Run `thatch setup --claude`. Record contents of CLAUDE.md, .claude/settings.json, and one skill file.",
    "2. Introduce drift: edit the thatch block in CLAUDE.md, change a hook command, and modify a SKILL.md.",
    "3. Add a non-thatch hook to .claude/settings.json.",
    "4. Re-run `thatch setup --claude`.",
  ].join("\n"),
  expected: [
    "- The thatch block in CLAUDE.md is replaced with canonical content. Text outside markers is untouched.",
    "- Thatch hooks in .claude/settings.json are replaced. The non-thatch hook is preserved.",
    "- The drifted SKILL.md is overwritten with canonical content. Unchanged skill files are not rewritten.",
    "- The re-run produces the same file contents as a fresh install — no duplication.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const dir = ctx.dir;
    const run = (args: string[]) => $`${bin} ${args}`.env(env).cwd(dir).quiet().nothrow();

    // Step 1: initial setup.
    const r1 = await run(["setup", "--claude"]);
    if (r1.exitCode !== 0) {
      console.log("  FAIL: initial setup exited non-zero");
      return "FAIL";
    }

    const claudeMdPath = join(dir, "CLAUDE.md");
    const settingsPath = join(dir, ".claude", "settings.json");
    const claudeMdBefore = readFileSync(claudeMdPath, "utf8");
    const settingsBefore = readFileSync(settingsPath, "utf8");

    // Record a skill file's canonical content.
    const skillsDir = join(env.CLAUDE_CONFIG_DIR, "skills");
    const skillPath = join(skillsDir, "thatch-fact-extractor", "SKILL.md");
    const skillCanonical = readFileSync(skillPath, "utf8");

    // Step 2: introduce drift inside the thatch block (between markers).
    // Do NOT modify the start/end markers themselves — appendBlock uses
    // them to find and replace the block. Drift the content between them.
    const driftedClaudeMd = claudeMdBefore.replace(
      "Tools: `memory_remember`",
      "DRIFTED CONTENT HERE",
    );
    writeFileSync(claudeMdPath, driftedClaudeMd);

    const settingsParsed = JSON.parse(settingsBefore);
    settingsParsed.hooks.SessionStart[0].hooks[0].command = "drifted-command-here";
    writeFileSync(settingsPath, JSON.stringify(settingsParsed, null, 2) + "\n");

    const driftedSkill = "# DRIFTED SKILL CONTENT\n\nThis was edited.\n";
    writeFileSync(skillPath, driftedSkill);

    // Step 3: add a non-thatch hook (must not contain "thatch" substring).
    const settingsWithExternal = JSON.parse(readFileSync(settingsPath, "utf8"));
    settingsWithExternal.hooks.SessionStart.push({
      hooks: [{ type: "command", command: "echo external-hook" }],
    });
    writeFileSync(settingsPath, JSON.stringify(settingsWithExternal, null, 2) + "\n");

    // Step 4: re-run setup.
    await run(["setup", "--claude"]);

    // CLAUDE.md should be restored to canonical content.
    if (readFileSync(claudeMdPath, "utf8") !== claudeMdBefore) {
      console.log("  FAIL: CLAUDE.md not restored to canonical content after re-run");
      return "FAIL";
    }

    // Settings: thatch hooks replaced, non-thatch hook preserved.
    const settingsAfter = JSON.parse(readFileSync(settingsPath, "utf8"));
    const hasThatchHook = settingsAfter.hooks.SessionStart?.some(
      (g: any) => g.hooks?.some((h: any) => h.command?.includes("thatch reminder")),
    );
    if (!hasThatchHook) {
      console.log("  FAIL: thatch hook missing after re-run");
      return "FAIL";
    }
    const hasExternalHook = settingsAfter.hooks.SessionStart?.some(
      (g: any) => g.hooks?.some((h: any) => h.command?.includes("external-hook")),
    );
    if (!hasExternalHook) {
      console.log("  FAIL: non-thatch hook not preserved after re-run");
      return "FAIL";
    }

    // Skill file should be overwritten with canonical content.
    if (readFileSync(skillPath, "utf8") !== skillCanonical) {
      console.log("  FAIL: drifted SKILL.md not overwritten with canonical content");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
