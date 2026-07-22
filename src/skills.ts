import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillFile {
  name: string;
  path: string;
  content: string;
}

export interface SkillDef {
  name: string;
  content: string;
}

function loadSkillFile(name: string): string {
  const artifactsDir = join(__dirname, "..", "artifacts", "skills");
  const filePath = join(artifactsDir, name + ".md");
  const raw = readFileSync(filePath, "utf8");
  // Interpolate REVIEW_COMMON only when it appears on its own line (the
  // directive form used by review specialist skills). Inline mentions in
  // other skills (e.g. as examples in prose) are content, not directives,
  // and must not be interpolated.
  if (/^[ \t]*\$\{REVIEW_COMMON\}[ \t]*$/m.test(raw)) {
    const commonPath = join(artifactsDir, "common.md");
    const commonContent = readFileSync(commonPath, "utf8");
    return raw.replace(/^[ \t]*\$\{REVIEW_COMMON\}[ \t]*$/gm, commonContent);
  }
  return raw;
}

function loadSharedSkills(): SkillDef[] {
  const names = [
    "thatch-fact-extractor",
    "thatch-dedup-classifier",
    "thatch-project-primer",
    "thatch-review-pedantic",
    "thatch-review-acceptance",
    "thatch-review-state-flow",
    "thatch-review-no-slop",
    "thatch-review-breadcrumbs",
    "thatch-review-mark-and-sweep",
    "thatch-review-synthesizer",
    "thatch-review-context",
    "thatch-workflow-research",
    "thatch-change-walkthrough",
    "thatch-code-walkthrough",
    "thatch-session-reflection",
    "pr-description",
    "ticket-description",
    "split-overlarge-pr",
  ];
  return names.map((name) => ({ name, content: loadSkillFile(name) }));
}

function loadOpencodeOnlySkills(): SkillDef[] {
  return [
    { name: "thatch-code-review", content: loadSkillFile("thatch-code-review") },
  ];
}

export const SHARED_SKILLS: SkillDef[] = loadSharedSkills();
export const OPENCODE_ONLY_SKILLS: SkillDef[] = loadOpencodeOnlySkills();

export function installSkills(
  skillsDir: string,
  skills: SkillDef[] = SHARED_SKILLS,
): SkillFile[] {
  mkdirSync(skillsDir, { recursive: true });
  const written: SkillFile[] = [];

  for (const skill of skills) {
    const dir = join(skillsDir, skill.name);
    const file = join(dir, "SKILL.md");

    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // missing file — first install
    }

    if (current !== skill.content) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, skill.content);
      written.push({ name: skill.name, path: file, content: skill.content });
    }
  }

  return written;
}
