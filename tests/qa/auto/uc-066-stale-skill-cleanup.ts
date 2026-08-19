import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { installSkills, SHARED_SKILLS } from "../../../src/skills";

/**
 * UC-066: Stale skill cleanup.
 *
 * Automatable: yes — installSkills runs cleanupStaleSkills internally.
 * This test creates stale thatch-* and non-thatch directories, then
 * calls installSkills and verifies stale thatch-* dirs are deleted
 * while non-thatch dirs are preserved.
 */

const useCase: UseCase = {
  name: "UC-066-stale-skill-cleanup",
  preconditions: [
    "- Thatch installed; the skills directory contains stale skill directories from a prior install",
    "- `bun` on PATH",
  ].join("\n"),
  steps: [
    "1. Populate the skills dir with the current install set.",
    "2. Create a stale thatch-* directory not in the current install set.",
    "3. Create a non-thatch skill directory.",
    "4. Re-run installSkills (or setup).",
  ].join("\n"),
  expected: [
    "- The stale thatch-* directory is deleted. The thatch- prefix is thatch's namespace.",
    "- The non-thatch skill directory is preserved — cleanupStaleSkills only touches thatch-* dirs.",
    "- Current skills in the install set are not deleted.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const skillsDir = join(ctx.dir, "uc066-skills");
    mkdirSync(skillsDir, { recursive: true });

    // Step 1: install current skills.
    installSkills(skillsDir, SHARED_SKILLS);

    const currentNames = SHARED_SKILLS.map((s) => s.name);

    // Step 2: create a stale thatch-* directory.
    const staleDir = join(skillsDir, "thatch-old-removed-skill");
    mkdirSync(join(staleDir), { recursive: true });
    writeFileSync(join(staleDir, "SKILL.md"), "# Stale skill\n");

    // Step 3: create a non-thatch skill directory.
    const customDir = join(skillsDir, "my-custom-skill");
    mkdirSync(join(customDir), { recursive: true });
    writeFileSync(join(customDir, "SKILL.md"), "# Custom skill\n");

    // Step 4: re-run installSkills (triggers cleanupStaleSkills).
    installSkills(skillsDir, SHARED_SKILLS);

    // Stale thatch-* dir should be deleted.
    if (existsSync(staleDir)) {
      console.log("  FAIL: stale thatch-* directory should be deleted");
      return "FAIL";
    }

    // Non-thatch dir should be preserved.
    if (!existsSync(customDir)) {
      console.log("  FAIL: non-thatch skill directory should be preserved");
      return "FAIL";
    }

    // Current skills should still be present.
    for (const name of currentNames) {
      if (!existsSync(join(skillsDir, name, "SKILL.md"))) {
        console.log(`  FAIL: current skill ${name} should still be present`);
        return "FAIL";
      }
    }

    return "PASS";
  },
};

registerUseCase(useCase);
