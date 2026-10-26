import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import yaml from "yaml";
import { setupClaudeCode, setupCursor, setupSkillsOnly, thatchMcpServerEntry } from "../src/setup";
import { REVIEW_SPECIALISTS } from "../src/prompts";
import { SHARED_SKILLS, OPENCODE_ONLY_SKILLS, installSkills } from "../src/skills";
import { installSetupHarness, projectDir, fakeHome } from "./mocks/setup-harness";

installSetupHarness();

// ---------------------------------------------------------------------------
// installSkills report
// ---------------------------------------------------------------------------

describe("installSkills report", () => {
  test("fresh directory reports every skill as added", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-skills-report-"));
    try {
      const report = installSkills(dir);
      expect(report.dir).toBe(dir);
      expect(report.added.length).toBe(SHARED_SKILLS.length);
      expect(report.updated).toEqual([]);
      expect(report.unchanged).toEqual([]);
      expect(report.removed).toEqual([]);
      expect(report.added.map((s) => s.name)).toContain("thatch-fact-extractor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-run reports every skill as unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-skills-report-"));
    try {
      installSkills(dir);
      const report = installSkills(dir);
      expect(report.added).toEqual([]);
      expect(report.updated).toEqual([]);
      expect(report.removed).toEqual([]);
      expect(report.unchanged.length).toBe(SHARED_SKILLS.length);
      expect(report.unchanged).toContain("thatch-fact-extractor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drifted content is reported as updated and repaired", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-skills-report-"));
    try {
      installSkills(dir);
      const file = join(dir, "thatch-fact-extractor", "SKILL.md");
      writeFileSync(file, "drifted content");
      const report = installSkills(dir);
      expect(report.added).toEqual([]);
      expect(report.updated.map((s) => s.name)).toEqual(["thatch-fact-extractor"]);
      expect(report.unchanged.length).toBe(SHARED_SKILLS.length - 1);
      // The drift is repaired from the artifact source.
      expect(readFileSync(file, "utf8")).toBe(
        SHARED_SKILLS.find((s) => s.name === "thatch-fact-extractor")!.content,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale thatch-* skill directories are removed and reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-skills-report-"));
    try {
      mkdirSync(join(dir, "thatch-retired-skill"), { recursive: true });
      writeFileSync(join(dir, "thatch-retired-skill", "SKILL.md"), "old");
      const report = installSkills(dir);
      expect(report.removed).toEqual(["thatch-retired-skill"]);
      expect(existsSync(join(dir, "thatch-retired-skill"))).toBe(false);
      expect(report.added.length).toBe(SHARED_SKILLS.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-thatch skill directories are neither removed nor reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-skills-report-"));
    try {
      mkdirSync(join(dir, "someone-elses-skill"), { recursive: true });
      writeFileSync(join(dir, "someone-elses-skill", "SKILL.md"), "keep me");
      const report = installSkills(dir);
      expect(report.removed).toEqual([]);
      expect(existsSync(join(dir, "someone-elses-skill", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Other-scope skills note
// ---------------------------------------------------------------------------

describe("other-scope skills note", () => {
  test("claude local: user-scope thatch skills are surfaced, not touched", () => {
    const userSkills = join(fakeHome, ".claude", "skills");
    mkdirSync(join(userSkills, "thatch-legacy"), { recursive: true });
    writeFileSync(join(userSkills, "thatch-legacy", "SKILL.md"), "old copy");

    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.otherScopeSkills).toEqual({ dir: userSkills, count: 1 });
    // The user-scope copy is left exactly as it was.
    expect(readFileSync(join(userSkills, "thatch-legacy", "SKILL.md"), "utf8")).toBe("old copy");
  });

  test("claude local: clean user scope yields no note", () => {
    const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);
    expect(result.otherScopeSkills).toBeNull();
  });

  test("claude local: honors CLAUDE_CONFIG_DIR when probing the user scope", () => {
    const customDir = mkdtempSync(join(tmpdir(), "thatch-custom-config-"));
    process.env.CLAUDE_CONFIG_DIR = customDir;
    try {
      const userSkills = join(customDir, "skills");
      mkdirSync(join(userSkills, "thatch-legacy"), { recursive: true });
      writeFileSync(join(userSkills, "thatch-legacy", "SKILL.md"), "old copy");

      const result = setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

      expect(result.otherScopeSkills).toEqual({ dir: userSkills, count: 1 });
      expect(existsSync(join(fakeHome, ".claude", "skills"))).toBe(false);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  test("claude global: project-scope thatch skills are surfaced", () => {
    const projectSkills = join(projectDir, ".claude", "skills");
    mkdirSync(join(projectSkills, "thatch-local"), { recursive: true });
    writeFileSync(join(projectSkills, "thatch-local", "SKILL.md"), "project copy");

    const result = setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);

    expect(result.otherScopeSkills).toEqual({ dir: projectSkills, count: 1 });
    // The project copy is left exactly as it was.
    expect(readFileSync(join(projectSkills, "thatch-local", "SKILL.md"), "utf8")).toBe("project copy");
  });

  test("cursor local: user-scope thatch skills are surfaced", () => {
    const userSkills = join(fakeHome, ".cursor", "skills");
    mkdirSync(join(userSkills, "thatch-legacy"), { recursive: true });
    writeFileSync(join(userSkills, "thatch-legacy", "SKILL.md"), "old copy");

    const result = setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    expect(result.otherScopeSkills).toEqual({ dir: userSkills, count: 1 });
  });

  test("cursor global: project-scope thatch skills are surfaced", () => {
    const projectSkills = join(projectDir, ".cursor", "skills");
    mkdirSync(join(projectSkills, "thatch-local"), { recursive: true });
    writeFileSync(join(projectSkills, "thatch-local", "SKILL.md"), "project copy");

    const result = setupCursor("/usr/local/bin/thatch", true, projectDir, fakeHome);

    expect(result.otherScopeSkills).toEqual({ dir: projectSkills, count: 1 });
    expect(readFileSync(join(projectSkills, "thatch-local", "SKILL.md"), "utf8")).toBe("project copy");
  });
});

// ---------------------------------------------------------------------------
// Skills-only setup
// ---------------------------------------------------------------------------

describe("setupSkillsOnly", () => {
  test("claude local: installs skills and nothing else", () => {
    const result = setupSkillsOnly("claude", false, projectDir, fakeHome);

    expect(result.global).toBe(false);
    expect(result.skills.dir).toBe(join(projectDir, ".claude", "skills"));
    expect(result.skills.added.map((s) => s.name).sort()).toEqual(
      SHARED_SKILLS.map((s) => s.name).sort(),
    );
    expect(existsSync(join(projectDir, ".claude", "skills", SHARED_SKILLS[0].name, "SKILL.md"))).toBe(true);

    // Everything else full setup would write is skipped.
    expect(existsSync(join(projectDir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(projectDir, ".claude", "commands"))).toBe(false);
  });

  test("claude global: writes to the config dir and skips instructions/hooks", () => {
    const result = setupSkillsOnly("claude", true, projectDir, fakeHome);

    expect(result.global).toBe(true);
    expect(result.skills.dir).toBe(join(fakeHome, ".claude", "skills"));
    expect(existsSync(join(fakeHome, ".claude", "skills", SHARED_SKILLS[0].name, "SKILL.md"))).toBe(true);
    expect(existsSync(join(fakeHome, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(fakeHome, ".claude", "settings.json"))).toBe(false);
  });

  test("cursor local: installs skills and nothing else", () => {
    const result = setupSkillsOnly("cursor", false, projectDir, fakeHome);

    expect(result.skills.dir).toBe(join(projectDir, ".cursor", "skills"));
    expect(result.skills.added.length).toBe(SHARED_SKILLS.length);
    expect(existsSync(join(projectDir, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".cursor", "hooks.json"))).toBe(false);
  });

  test("cursor global: writes to ~/.cursor/skills", () => {
    const result = setupSkillsOnly("cursor", true, projectDir, fakeHome);

    expect(result.skills.dir).toBe(join(fakeHome, ".cursor", "skills"));
    expect(existsSync(join(fakeHome, ".cursor", "skills", SHARED_SKILLS[0].name, "SKILL.md"))).toBe(true);
    expect(existsSync(join(fakeHome, ".cursor", "AGENTS.md"))).toBe(false);
  });

  test("still surfaces the other scope without touching it", () => {
    const userSkills = join(fakeHome, ".claude", "skills");
    mkdirSync(join(userSkills, "thatch-legacy"), { recursive: true });
    writeFileSync(join(userSkills, "thatch-legacy", "SKILL.md"), "old copy");

    const result = setupSkillsOnly("claude", false, projectDir, fakeHome);

    expect(result.otherScopeSkills).toEqual({ dir: userSkills, count: 1 });
    // The user-scope copy is left exactly as it was.
    expect(readFileSync(join(userSkills, "thatch-legacy", "SKILL.md"), "utf8")).toBe("old copy");
  });

  test("honors CLAUDE_CONFIG_DIR in global scope", () => {
    const customDir = mkdtempSync(join(tmpdir(), "thatch-custom-config-"));
    process.env.CLAUDE_CONFIG_DIR = customDir;
    try {
      const result = setupSkillsOnly("claude", true, projectDir, fakeHome);
      expect(result.skills.dir).toBe(join(customDir, "skills"));
      expect(existsSync(join(customDir, "skills", SHARED_SKILLS[0].name, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });
});

describe("thatchMcpServerEntry", () => {
  test("the mcpServers shape other clients use: stdio + the mcp subcommand", () => {
    expect(thatchMcpServerEntry("/usr/local/bin/thatch")).toEqual({
      type: "stdio",
      command: "/usr/local/bin/thatch",
      args: ["mcp"],
    });
  });

  test("project dir pins THATCH_PROJECT_DIR for project-local configs", () => {
    const entry = thatchMcpServerEntry("/usr/local/bin/thatch", "/repo");
    expect(entry.env).toEqual({ THATCH_PROJECT_DIR: "/repo" });
  });

  test("no project dir means no env pin (global semantics)", () => {
    expect(thatchMcpServerEntry("/usr/local/bin/thatch").env).toBeUndefined();
  });
});

describe("skill artifact registry parity", () => {
  const artifactsDir = join(dirname(new URL(import.meta.url).pathname), "..", "artifacts", "skills");

  test("every .md file in artifacts/skills/ is registered (except common.md)", () => {
    const files = readdirSync(artifactsDir)
      .filter((f) => f.endsWith(".md") && f !== "common.md")
      .map((f) => f.replace(/\.md$/, ""));
    const registered = [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS].map((s) => s.name);
    for (const file of files) {
      expect(registered).toContain(file);
    }
  });

  test("every registered skill has a .md file in artifacts/skills/", () => {
    const files = readdirSync(artifactsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    for (const skill of [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]) {
      expect(files).toContain(skill.name);
    }
  });

  test("loaded skill content has no backslash-backtick escape artifacts", () => {
    for (const skill of [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]) {
      expect(skill.content).not.toContain("\\`");
    }
  });

  test("the coordinator and followup skills' specialist counts match REVIEW_SPECIALISTS", () => {
    // REVIEW_SPECIALISTS (src/prompts.ts) is the single source for the
    // roster; every code surface derives from it. The prose copies in the
    // skill artifacts cannot interpolate, so this test is the alarm that
    // fires when a specialist is added or removed: both skills' count
    // phrases must carry the roster's current size. The precise Step 6
    // heading check pins the coordinator's dispatch list; the loose
    // per-file checks trip on any count-phrase drift. Prose copies this
    // cannot reach (the synthesizer's specialist name list, the user-doc
    // tables and count phrases) still need a grep when the roster changes.
    // (The skills spell counts as words, hence the word map up to twelve;
    // a roster beyond twelve specialists is not a real scenario.)
    const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    const countPhrase = `${COUNT_WORDS[REVIEW_SPECIALISTS.length]} specialist`;
    const coordinator = OPENCODE_ONLY_SKILLS.find((s) => s.name === "thatch-code-review")!;
    expect(coordinator.content).toContain(`The ${countPhrase}s are:`);
    expect(coordinator.content).toContain(countPhrase);
    const followup = SHARED_SKILLS.find((s) => s.name === "thatch-review-followup")!;
    expect(followup.content).toContain(`all ${countPhrase}s on`);
  });

  test("REVIEW_COMMON is interpolated only into review specialist skills", () => {
    // The loader interpolates `${REVIEW_COMMON}` when it appears on its own
    // line (the directive form used by the eight problem-finding review specialists). Inline
    // mentions of the token in other skills (e.g. as prose examples) must
    // NOT trigger interpolation — that would splice the review framework
    // into the middle of an unrelated skill body and corrupt the content.
    // The synthesizer and code-review coordinator include some of the same
    // section headers (e.g. "## Static analysis only") as hardcoded content,
    // so the marker must be a phrase unique to common.md.
    // (Named REVIEW_COMMON_SPECIALISTS, not REVIEW_SPECIALISTS, to avoid
    // confusion with the roster const in src/prompts.ts: this set is the
    // ${REVIEW_COMMON} interpolators only, an eight-name subset.)
    const REVIEW_COMMON_SPECIALISTS = new Set([
      "thatch-review-pedantic",
      "thatch-review-acceptance",
      "thatch-review-state-flow",
      "thatch-review-economy",
      "thatch-review-no-slop",
      "thatch-review-clarity",
      "thatch-review-breadcrumbs",
      "thatch-review-mark-and-sweep",
    ]);
    const REVIEW_COMMON_BODY =
      "For every potential finding, you MUST describe a concrete scenario";
    for (const skill of [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]) {
      const isReviewSpecialist = REVIEW_COMMON_SPECIALISTS.has(skill.name);
      const hasInterpolatedBody = skill.content.includes(REVIEW_COMMON_BODY);
      expect(hasInterpolatedBody).toBe(isReviewSpecialist);
    }
  });

  test("the clarity lens carries the clear-writing skill's pinned rule phrasings", () => {
    // thatch-review-clarity condenses thatch-clear-writing's rules into a
    // review checklist. Both files are hand-maintained prose, so the
    // condensed rules can drift from the canonical ones. This test pins the
    // phrasings the lens shares with the skill: an edit to one that misses
    // the other fails here. The pins are exact rule statements, not the
    // full rule list.
    const lens = SHARED_SKILLS.find((s) => s.name === "thatch-review-clarity")!;
    const rules = SHARED_SKILLS.find((s) => s.name === "thatch-clear-writing")!;
    const PINNED_PHRASES = [
      "Every term must exist somewhere",
      "Brevity means fewer claims, not denser claims",
      "Lead with the answer",
      "A README is not",
      "inverted pyramid",
      "Basics before advanced",
      "still gets the story",
      "Presentation, not specificity",
      "subject and verb included",
      "Cover the rest of the document",
      "name the columns and what happened to them",
    ];
    for (const phrase of PINNED_PHRASES) {
      expect(lens.content).toContain(phrase);
      expect(rules.content).toContain(phrase);
    }
  });

  test("the followup and review-response skills gate prose the fixes introduce", () => {
    // The followup and review-response skills gate prose the fixes
    // introduce (comments, docstrings, error strings, docs), which no
    // review lens ever sees: the review range's prose predates the fix.
    // These pins are exact statements, not the full rule; an edit that
    // drops or renames the gate would silence it without any other test
    // noticing. The provenance pin keeps fix-introduced prose from being
    // mislabeled with the review range's branch-introduced term.
    const followup = SHARED_SKILLS.find((s) => s.name === "thatch-review-followup")!;
    const FOLLOWUP_PINS = [
      "### Prose check on the fix delta",
      "The check is mandatory whenever the delta touches prose",
      "#### New prose findings",
      "fix-introduced",
    ];
    for (const phrase of FOLLOWUP_PINS) {
      expect(followup.content).toContain(phrase);
    }
    const response = SHARED_SKILLS.find((s) => s.name === "thatch-review-response")!;
    const RESPONSE_PINS = [
      "### Prose check on the fix",
      "Prose check:",
    ];
    for (const phrase of RESPONSE_PINS) {
      expect(response.content).toContain(phrase);
    }
  });

  // Phrases every introspection-audit surface carries: the verdict tokens,
  // the current-plan guarantee, and the reroot rule's heading. Shared
  // protocol wording is enforced byte-identical across all three files by
  // looping this array over each skill's content.
  const SHARED_AUDIT_PINS = [
    "AUDIT PASS",
    "AUDIT FAIL",
    "on the plan as revised through the previous round",
    "On AUDIT FAIL: reroot, do not patch",
  ];

  test("the plan-refinement skill carries the introspection audit contract", () => {
    // Every round reviewer in thatch-plan-refinement's loop runs two audits
    // (evidence, consistency) whose verdicts gate consensus. The audit
    // METHODS live in the standalone thatch-plan-evidence and
    // thatch-plan-consistency skills; plan-refinement keeps the loop-side
    // machinery: the audit names, the current-plan guarantee, the consensus
    // gate, the reroot RULE (the skills own the protocol), the
    // host-conditional fan-out statement, and cross-references to both
    // skills. Pins are exact statements, not the full checklists; an edit
    // that drops or renames one would silence the gate without any other
    // test noticing.
    const skill = SHARED_SKILLS.find((s) => s.name === "thatch-plan-refinement")!;
    for (const phrase of SHARED_AUDIT_PINS) {
      expect(skill.content).toContain(phrase);
    }
    const PLAN_REFINEMENT_PINS = [
      "Evidence audit",
      "Consistency audit",
      "evidence audit PASS and consistency audit PASS",
      "thatch-plan-evidence",
      "thatch-plan-consistency",
      "The lens fan-out is opencode-only",
    ];
    for (const phrase of PLAN_REFINEMENT_PINS) {
      expect(skill.content).toContain(phrase);
    }
  });

  test("the thatch-plan-evidence skill carries the evidence audit contract", () => {
    // thatch-plan-evidence owns the Evidence audit method: finding classes,
    // verdicts, and the reroot protocol, self-contained so the file lifts
    // cleanly. The shared pins keep the protocol wording byte-identical
    // with its sibling and with plan-refinement's loop-side rule.
    const skill = SHARED_SKILLS.find((s) => s.name === "thatch-plan-evidence")!;
    for (const phrase of SHARED_AUDIT_PINS) {
      expect(skill.content).toContain(phrase);
    }
    const EVIDENCE_PINS = [
      "BROKEN - the citation target does not exist",
      "MISQUOTE - the target exists but does not say what the plan claims",
      "UNVERIFIED-CLAIM - the plan asserts the citation as verified but the auditor cannot check it",
      "thatch-plan-refinement",
      "thatch-plan-consistency",
    ];
    for (const phrase of EVIDENCE_PINS) {
      expect(skill.content).toContain(phrase);
    }
  });

  test("the thatch-plan-consistency skill carries the consistency audit contract", () => {
    // thatch-plan-consistency owns the Consistency audit method, same shape
    // as its sibling: shared protocol pins plus this audit's own vocabulary
    // and cross-references.
    const skill = SHARED_SKILLS.find((s) => s.name === "thatch-plan-consistency")!;
    for (const phrase of SHARED_AUDIT_PINS) {
      expect(skill.content).toContain(phrase);
    }
    const CONSISTENCY_PINS = [
      "CONTRADICTION - sections conflict",
      "TERM-DRIFT - the same concept under different names, or one name carrying two meanings",
      "thatch-plan-refinement",
      "thatch-plan-evidence",
    ];
    for (const phrase of CONSISTENCY_PINS) {
      expect(skill.content).toContain(phrase);
    }
  });

  test("the two standalone audit skills share the current-plan-guarantee wording", () => {
    // The guarantee's closing sentence is a contract both standalone skills
    // restate; the shared array pins it byte-identical in both, so an edit
    // to one cannot quietly fork the guarantee.
    const SENTENCE =
      "If you cannot tell which revision you are reading, the dispatch failed - say so and stop rather than audit a guess.";
    for (const name of ["thatch-plan-evidence", "thatch-plan-consistency"]) {
      const skill = SHARED_SKILLS.find((s) => s.name === name)!;
      expect(skill.content).toContain(SENTENCE);
    }
  });

  test("every skill frontmatter parses as strict YAML with name and description", () => {
    // opencode discovers skills by parsing the YAML frontmatter of each
    // SKILL.md. If the parse fails (or yields a mapping without `name`
    // or `description`), opencode filters the skill out of available_skills
    // entirely, so it is invisible to the LLM and can never be loaded.
    //
    // The most common way to break parsing is a `: ` (colon-space) appearing
    // mid-description in an unquoted scalar: bun's strict YAML parser
    // interprets it as a nested mapping key separator and throws
    // "Nested mappings are not allowed in compact mappings". Fix by wrapping
    // the description in single quotes (single-quoted YAML strings tolerate
    // colons, backticks, and double-quotes inline; only apostrophes need
    // doubling, and our descriptions don't have any).
    //
    // Using the yaml package directly (matching bun's strict parser opencode
    // is presumed to use) catches this class of bug at `mise run check` time.
    for (const skill of [...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]) {
      const fmMatch = skill.content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).not.toBeNull();
      const parsed = yaml.parse(fmMatch![1]) as Record<string, unknown>;
      expect(typeof parsed.name).toBe("string");
      expect(parsed.name).toBe(skill.name);
      expect(typeof parsed.description).toBe("string");
      expect((parsed.description as string).length).toBeGreaterThan(0);
    }
  });
});

describe("stale skill cleanup on install", () => {
  test("leaves old non-prefixed skill dirs alone - the rename window closed at v0.1.35", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-cleanup-"));
    // The v0.1.27 rename (pr-description -> thatch-pr-description and
    // siblings) cleaned these up only through a version window that closed
    // with v0.1.35. Non-prefixed names now belong to third parties, so
    // cleanup must never remove them.
    for (const name of ["pr-description", "ticket-description", "split-overlarge-pr"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "SKILL.md"), "someone else's skill now");
    }

    installSkills(dir, SHARED_SKILLS);

    expect(existsSync(join(dir, "pr-description"))).toBe(true);
    expect(existsSync(join(dir, "ticket-description"))).toBe(true);
    expect(existsSync(join(dir, "split-overlarge-pr"))).toBe(true);
  });

  test("removes stale thatch-* dirs not in the current skill set", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-cleanup-"));
    // A hypothetical old skill name that was renamed or removed.
    mkdirSync(join(dir, "thatch-old-removed-skill"), { recursive: true });
    writeFileSync(join(dir, "thatch-old-removed-skill", "SKILL.md"), "stale");

    installSkills(dir, SHARED_SKILLS);

    expect(existsSync(join(dir, "thatch-old-removed-skill"))).toBe(false);
  });

  test("leaves non-thatch, non-renamed skill dirs alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-cleanup-"));
    mkdirSync(join(dir, "someone-elses-skill"), { recursive: true });
    writeFileSync(join(dir, "someone-elses-skill", "SKILL.md"), "not ours");

    installSkills(dir, SHARED_SKILLS);

    expect(existsSync(join(dir, "someone-elses-skill", "SKILL.md"))).toBe(true);
  });

  test("does not delete current thatch-* skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-cleanup-"));

    installSkills(dir, SHARED_SKILLS);

    // A few representative current skills should exist.
    expect(existsSync(join(dir, "thatch-fact-extractor", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "thatch-pr-description", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "thatch-code-walkthrough", "SKILL.md"))).toBe(true);
  });

  test("removes symlinked stale skill dirs without following the link", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-cleanup-"));
    // Create a real directory outside the skills dir to serve as the
    // symlink target — this represents a shared skill dir the user still
    // wants. The cleanup must remove the symlink, not the target.
    const targetDir = mkdtempSync(join(tmpdir(), "thatch-symlink-target-"));
    writeFileSync(join(targetDir, "SKILL.md"), "shared content");
    symlinkSync(targetDir, join(dir, "thatch-old-removed-skill"));

    installSkills(dir, SHARED_SKILLS);

    // The symlink is gone.
    expect(existsSync(join(dir, "thatch-old-removed-skill"))).toBe(false);
    // The target directory the symlink pointed to is still intact.
    expect(existsSync(join(targetDir, "SKILL.md"))).toBe(true);
  });
});
