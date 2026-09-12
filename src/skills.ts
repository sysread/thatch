import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillDef {
  name: string;
  content: string;
}

/** A skill file that exists on disk after an install pass. */
export interface InstalledSkill {
  name: string;
  path: string;
}

/**
 * Outcome of one installSkills pass over a directory. Every skill in the
 * install set lands in exactly one of added/updated/unchanged; removed lists
 * stale thatch-* directories pruned before the write pass. The CLI reports
 * these counts so a re-run tells the user what actually happened instead of
 * printing nothing when everything was already current.
 */
export interface InstallReport {
  /** Directory the skills were installed to. */
  dir: string;
  /** Skills written for the first time. */
  added: InstalledSkill[];
  /** Skills whose on-disk content differed and were overwritten. */
  updated: InstalledSkill[];
  /** Skills already current; nothing was written. */
  unchanged: string[];
  /** Stale thatch-* skill directories deleted (renamed or retired skills). */
  removed: string[];
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
    "thatch-review-economy",
    "thatch-review-no-slop",
    "thatch-review-breadcrumbs",
    "thatch-review-mark-and-sweep",
    "thatch-review-highlights",
    "thatch-review-mentorship",
    "thatch-review-synthesizer",
    "thatch-review-context",
    "thatch-code-archaeology",
    "thatch-review-followup",
    "thatch-change-walkthrough",
    "thatch-code-walkthrough",
    "thatch-session-reflection",
    "thatch-coding-workflow",
    "thatch-pr-description",
    "thatch-ticket-description",
    "thatch-split-overlarge-pr",
    "thatch-review-response",
    "thatch-memory-verify",
    "thatch-knowledge-export",
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

// ---------------------------------------------------------------------------
// Stale skill cleanup - runs before install on every skillsDir
// ---------------------------------------------------------------------------

// Skills renamed from non-prefixed to thatch-prefixed in v0.1.27
// (pr-description, ticket-description, split-overlarge-pr) were cleaned up
// during install through a version-gated window that closed with v0.1.35.
// The gate is gone because it can never reopen: package versions only grow,
// so this code only ever runs at a version past the window. The standing
// contract it protected remains: non-prefixed skill names belong to third
// parties and are NEVER removed - cleanup only touches thatch-* dirs, where
// the prefix is our namespace. Users upgrading from before v0.1.27 delete
// the old directories manually.

/**
 * Remove stale skill directories before installing the current set.
 *
 * One rule: delete any `thatch-*` skill directory that is not in the current
 * install set. The `thatch-` prefix is our namespace - no third party should
 * use it, so unconditional removal is safe. This catches skills we've
 * renamed or removed in any release.
 *
 * Non-prefixed directories are never touched. The v0.1.27 rename migration
 * (pr-description -> thatch-pr-description and siblings) removed old
 * non-prefixed dirs through a version window that closed with v0.1.35; see
 * the block comment above.
 *
 * Returns the names of the directories it removed so the install report can
 * surface them.
 */
function cleanupStaleSkills(skillsDir: string, currentNames: string[]): string[] {
  const currentSet = new Set(currentNames);
  const removed: string[] = [];
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return []; // dir doesn't exist or isn't readable - nothing to clean
  }

  for (const entry of entries) {
    // isDirectory() returns false for symlinks (even symlinked dirs), so
    // check isSymbolicLink() too - a symlinked skill dir is just as stale
    // as a regular one.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    const fullPath = join(skillsDir, name);

    // Remove a stale entry. For symlinks, unlink the symlink itself - never
    // follow the link, which could delete the target (e.g. a shared skill
    // directory the user still wants). For regular dirs, recursive rm.
    const remove = () => {
      try {
        if (entry.isSymbolicLink()) {
          unlinkSync(fullPath);
        } else {
          rmSync(fullPath, { recursive: true, force: true });
        }
        removed.push(name);
      } catch {
        // best-effort - don't block install on cleanup failure
      }
    };

    // Stale thatch-* dirs: our namespace, always safe to remove.
    if (name.startsWith("thatch-") && !currentSet.has(name)) {
      remove();
    }
  }

  return removed;
}

export function installSkills(
  skillsDir: string,
  skills: SkillDef[] = SHARED_SKILLS,
): InstallReport {
  mkdirSync(skillsDir, { recursive: true });
  const removed = cleanupStaleSkills(skillsDir, skills.map((s) => s.name));

  const added: InstalledSkill[] = [];
  const updated: InstalledSkill[] = [];
  const unchanged: string[] = [];

  for (const skill of skills) {
    const dir = join(skillsDir, skill.name);
    const file = join(dir, "SKILL.md");

    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // missing file - first install
    }

    if (current === null) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, skill.content);
      added.push({ name: skill.name, path: file });
    } else if (current !== skill.content) {
      writeFileSync(file, skill.content);
      updated.push({ name: skill.name, path: file });
    } else {
      unchanged.push(skill.name);
    }
  }

  return { dir: skillsDir, added, updated, unchanged, removed };
}
