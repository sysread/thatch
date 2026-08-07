import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

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
    "thatch-review-highlights",
    "thatch-review-synthesizer",
    "thatch-review-context",
    "thatch-workflow-research",
    "thatch-review-followup",
    "thatch-change-walkthrough",
    "thatch-code-walkthrough",
    "thatch-session-reflection",
    "thatch-pr-description",
    "thatch-ticket-description",
    "thatch-split-overlarge-pr",
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
// Stale skill cleanup — runs before install on every skillsDir
// ---------------------------------------------------------------------------

// Skills renamed from non-prefixed to thatch-prefixed in v0.1.27. The old
// names are cleaned up during install for a limited version window because
// non-prefixed names could be adopted by third parties after we abandon them.
// After RENAME_MIGRATION_MAX_VERSION, the cleanup stops and leftover stale
// files are the user's responsibility.
const RENAMED_SKILLS = new Set([
  "pr-description",
  "ticket-description",
  "split-overlarge-pr",
]);

// Last version that ships the non-prefixed-to-prefixed migration cleanup.
// Users who upgrade to this version or earlier get automatic cleanup of the
// old skill directories. Users who skip past this version must manually
// delete the stale directories.
const RENAME_MIGRATION_MAX_VERSION = "0.1.35";

function compareVersions(a: string, b: string): number {
  const [aMaj, aMin, aPatch] = a.split(".").map(Number);
  const [bMaj, bMin, bPatch] = b.split(".").map(Number);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPatch - bPatch;
}

/**
 * Remove stale skill directories before installing the current set.
 *
 * Two cleanup rules:
 *
 * 1. Always: delete any `thatch-*` skill directory that is not in the current
 *    install set. The `thatch-` prefix is our namespace — no third party should
 *    use it, so unconditional removal is safe. This catches skills we've
 *    renamed or removed in any release.
 *
 * 2. Version-gated: delete directories matching old non-prefixed skill names
 *    (pr-description, ticket-description, split-overlarge-pr) through
 *    RENAME_MIGRATION_MAX_VERSION. These names lack the thatch- prefix and
 *    could be adopted by third parties after we abandon them, so the cleanup
 *    is time-boxed. Users who upgrade past the window must manually clean up.
 */
function cleanupStaleSkills(skillsDir: string, currentNames: string[]): void {
  const currentSet = new Set(currentNames);
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist or isn't readable — nothing to clean
  }

  const withinMigrationWindow =
    compareVersions(pkg.version, RENAME_MIGRATION_MAX_VERSION) <= 0;

  for (const entry of entries) {
    // isDirectory() returns false for symlinks (even symlinked dirs), so
    // check isSymbolicLink() too — a symlinked skill dir is just as stale
    // as a regular one.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    const fullPath = join(skillsDir, name);

    // Remove a stale entry. For symlinks, unlink the symlink itself — never
    // follow the link, which could delete the target (e.g. a shared skill
    // directory the user still wants). For regular dirs, recursive rm.
    const remove = () => {
      try {
        if (entry.isSymbolicLink()) {
          unlinkSync(fullPath);
        } else {
          rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {
        // best-effort — don't block install on cleanup failure
      }
    };

    // Rule 1: stale thatch-* dirs (our namespace, always safe to remove).
    if (name.startsWith("thatch-") && !currentSet.has(name)) {
      remove();
      continue;
    }

    // Rule 2: renamed non-prefixed dirs (version-gated, third-party risk).
    if (RENAMED_SKILLS.has(name) && withinMigrationWindow) {
      remove();
    }
  }
}

export function installSkills(
  skillsDir: string,
  skills: SkillDef[] = SHARED_SKILLS,
): SkillFile[] {
  mkdirSync(skillsDir, { recursive: true });
  cleanupStaleSkills(skillsDir, skills.map((s) => s.name));

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
