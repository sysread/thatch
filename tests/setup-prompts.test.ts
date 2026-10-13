import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkSetup, setupClaudeCode, setupCursor } from "../src/setup";
import { claudeInstructions, cursorInstructions, memoryPointersSection, opencodeToolName, systemPrompt } from "../src/prompts";
import { installSetupHarness, projectDir, fakeHome } from "./mocks/setup-harness";

installSetupHarness();

describe("systemPrompt content", () => {
  test("startup recall examples use object-argument shape", () => {
    const text = systemPrompt("test/repo");
    // The startup examples must use the object-argument form: the
    // positional style is the most common first-call validation failure
    // (opencode DB analysis, Sept 2026).
    expect(text).toContain('thatch_memory_recall({ query: "user preferences and personality" })');
    expect(text).not.toContain('thatch_memory_recall "');
  });

  test("includes review-discussion prediction guidance", () => {
    const text = systemPrompt("test/repo");
    expect(text).toContain("Code review discussions are high-signal prediction material");
    expect(text).toContain("review threshold, severity, tone, evidence, scope, false positives");
  });

  test("includes class-lesson guidance for predictions and behaviors", () => {
    const text = systemPrompt("test/repo");
    // The class-lesson paragraphs are shared constants - all prompt
    // variants must carry them verbatim (assertions stay within single
    // source lines - the paragraphs are hard-wrapped).
    expect(text).toContain("reveals a CLASS of mistake");
    expect(text).toContain("The same class discipline applies to judgment errors");
    expect(text).toContain("names this incident never fires");
  });

  test("includes situational behaviors section", () => {
    const text = systemPrompt("test/repo");
    expect(text).toContain("Situational Behaviors");
    expect(text).toContain("behavior_codify");
    expect(text).toContain("behavior_feedback");
  });

  test("extraction completions are never re-dispatch signals", () => {
    // The completion frame rides with the fact-extractor's own return
    // value; the system prompt carries the matching instruction so the
    // completion turn cannot be misread as new nudge traffic. The skill
    // half is pinned separately below - the frame is load-bearing at BOTH
    // surfaces, and reverting either alone reintroduces the September
    // 2026 re-dispatch loop.
    const text = systemPrompt("test/repo");
    expect(text).toContain("not an extraction nudge");
    expect(text).toContain("Never re-dispatch an extractor");
  });

  test("the fact-extractor's final-message contract carries the frame", () => {
    // Pins the skill artifact itself: the parent model sees the skill's
    // mandated string inside the <task_result> block, so the frame must
    // live there, not only in the system prompt.
    const skill = readFileSync(join(__dirname, "../artifacts/skills/thatch-fact-extractor.md"), "utf8");
    expect(skill).toContain("not an extraction nudge; the buffer is drained");
    expect(skill).toContain("Never re-dispatch an extractor because a completion arrived");
  });

  test("claudeInstructions includes situational behaviors section", () => {
    const text = claudeInstructions();
    expect(text).toContain("Situational Behaviors");
    expect(text).toContain("behavior_codify");
  });

  test("cursorInstructions includes situational behaviors section", () => {
    const text = cursorInstructions();
    expect(text).toContain("Situational Behaviors");
    expect(text).toContain("behavior_codify");
  });

  test("includes chat coordination encouragement", () => {
    const text = systemPrompt("test/repo");
    expect(text).toContain("## Cross-Session Chat");
    expect(text).toContain("Coordination is wanted");
    expect(text).toContain("scope split");
  });

  test("omits the entire chat section when chat is disabled", () => {
    const text = systemPrompt("test/repo", false);
    expect(text).not.toContain("## Cross-Session Chat");
    expect(text).not.toContain("Coordination is wanted");
  });

  test("does not use deprecated instructional-design wording for writing skills", () => {
    const text = systemPrompt("test/repo") + claudeInstructions() + cursorInstructions();
    expect(text).not.toContain("instructional-design scaffolding");
  });

  test("includes clear-writing guidance in every host prompt", () => {
    for (const text of [systemPrompt("test/repo"), claudeInstructions(), cursorInstructions()]) {
      expect(text).toContain("thatch-clear-writing");
      expect(text).toContain("clarity-over-compression prose rules");
      // Core rules are inlined so they hold even when the skill is not loaded.
      expect(text).toContain("No made-up phrases");
      expect(text).toContain("Terse means fewer claims, never denser ones");
      expect(text).toContain("No sycophancy. Don't open by validating the question");
      expect(text).toContain("When you don't know, say so");
      expect(text).toContain("No process narration. State the thing.");
      // The comment floor rides the same section (assertions stay within
      // single source lines - the prose is hard-wrapped).
      expect(text).toContain("never a metaphor standing in for");
      expect(text).toContain("Full sentences with the cause named");
    }
  });

  test("clear-writing floor stays under a byte budget", () => {
    // The floor ships inline in every host prompt on every turn, so it must
    // stay small. Budget covers the current line wrapping of the section;
    // re-wrap the prose rather than raising it silently.
    for (const text of [systemPrompt("test/repo"), claudeInstructions(), cursorInstructions()]) {
      const floor = text.slice(text.indexOf("## Clear writing"), text.indexOf("## When to Write"));
      expect(Buffer.byteLength(floor, "utf8")).toBeLessThan(1300);
    }
  });

  test("clear-writing skill carries the floor rules for hosts without the inline prompt", () => {
    // The floor points at the skill for the full rules. Pin the anchors so
    // the skill and the floor cannot drift apart silently.
    const skill = readFileSync(join(__dirname, "../artifacts/skills/thatch-clear-writing.md"), "utf8");
    expect(skill).toContain("No sycophancy");
    expect(skill).toContain("When you don't know, say so");
    expect(skill).toContain("Session replies");
    expect(skill).toContain("## Code comments");
  });
});

describe("memories-are-pointers guidance", () => {
  test("section body renders from the shared source", () => {
    // The body is one template string shared by all three variants, so the
    // body anchors are asserted against the shared function directly
    // (assertions stay within single source lines - the prose is
    // hard-wrapped). The per-variant test below only checks that each
    // variant actually interpolates the section.
    const body = memoryPointersSection(opencodeToolName);
    expect(body).toContain("## Memories Are Pointers, Not Truth");
    expect(body).toContain("speed up research");
    expect(body).toContain("they are not a source of truth");
    expect(body).toContain("**Policy memories**");
    expect(body).toContain("**Artifact memories**");
    expect(body).toContain("Before asserting an artifact claim from memory");
    expect(body).toContain("The source wins");
  });

  test("present in every host prompt", () => {
    for (const text of [systemPrompt("test/repo"), claudeInstructions(), cursorInstructions()]) {
      expect(text).toContain("## Memories Are Pointers, Not Truth");
      // The How-to-Write pointer bullet is interpolated from a shared const
      // into each rendered variant; its assertions stay per-variant.
      expect(text).toContain("should carry their pointers");
      expect(text).toContain("Verification is cheap later only if the memory says where");
      expect(text).toContain('a bare "where X lives" is exactly what the durability test');
    }
  });

  test("uses host-correct tool spellings and replaces the old section", () => {
    const sys = systemPrompt("test/repo");
    expect(sys).toContain(
      "thatch_memory_remember (overwrite: true) or thatch_memory_forget",
    );
    expect(sys).not.toContain("## Memory Verification");
    for (const text of [claudeInstructions(), cursorInstructions()]) {
      expect(text).toContain("memory_remember (overwrite: true) or memory_forget");
      expect(text).not.toContain("## Memory Verification");
    }
  });
});

describe("checkSetup", () => {
  test("returns null when neither CURSOR_PROJECT_DIR nor CLAUDE_PROJECT_DIR is set", () => {
    const result = checkSetup(projectDir, fakeHome);
    expect(result).toBe(null);
  });

  test("detects local Claude Code install", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("installed");
    expect(result?.scope).toBe("local");
    expect(result?.host).toBe("claude");
  });

  test("detects global Claude Code install", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("installed");
    expect(result?.scope).toBe("global");
    expect(result?.host).toBe("claude");
  });

  test("detects not-installed for Claude Code", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("not-installed");
    expect(result?.host).toBe("claude");
    expect(result?.message).toContain("thatch setup --claude");
  });

  test("detects markers-broken for Claude Code (local)", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    const broken = "# Persistence\n\nThatch provides persistent memory across Claude Code sessions.\n\nSome user content without the end marker.\n";
    writeFileSync(join(projectDir, "CLAUDE.md"), broken);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("markers-broken");
    expect(result?.host).toBe("claude");
    expect(result?.message).toContain("thatch setup --claude");
  });

  test("local takes priority over global for Claude Code", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    setupClaudeCode("/usr/local/bin/thatch", true, projectDir, fakeHome);
    setupClaudeCode("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("installed");
    expect(result?.scope).toBe("local");
  });

  test("detects local Cursor install", () => {
    process.env.CURSOR_PROJECT_DIR = projectDir;
    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("installed");
    expect(result?.scope).toBe("local");
    expect(result?.host).toBe("cursor");
  });

  test("detects not-installed for Cursor", () => {
    process.env.CURSOR_PROJECT_DIR = projectDir;

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("not-installed");
    expect(result?.host).toBe("cursor");
    expect(result?.message).toContain("thatch setup --cursor");
  });

  test("detects markers-broken for Cursor (global)", () => {
    process.env.CURSOR_PROJECT_DIR = projectDir;
    const configDir = join(fakeHome, ".cursor");
    mkdirSync(configDir, { recursive: true });
    const broken = "# Persistence\n\nThatch provides persistent memory across Cursor sessions.\n\nTruncated without end marker.\n";
    writeFileSync(join(configDir, "AGENTS.md"), broken);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.status).toBe("markers-broken");
    expect(result?.host).toBe("cursor");
    expect(result?.message).toContain("thatch setup --cursor --global");
  });

  test("Cursor takes priority over Claude Code when both env vars are set", () => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    process.env.CURSOR_PROJECT_DIR = projectDir;
    setupCursor("/usr/local/bin/thatch", false, projectDir, fakeHome);

    const result: any = checkSetup(projectDir, fakeHome);
    expect(result?.host).toBe("cursor");
  });
});

describe("instruction block sentinels", () => {
  const BEGIN = "<!-- thatch:begin -->";
  const END = "<!-- thatch:end -->";
  const LEGACY_END = '"Forget X" - `memory_recall` to find it, then `memory_forget`.';

  test("fresh install wraps instructions in sentinels", () => {
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    const md = readFileSync(join(projectDir, "CLAUDE.md"), "utf8");
    expect(md).toContain(BEGIN);
    expect(md).toContain(END);
    expect(md.indexOf(BEGIN)).toBeLessThan(md.indexOf(END));
    expect(md.match(/# Persistence/g)?.length).toBe(1);
  });

  test("re-run replaces the sentinel block instead of duplicating", () => {
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    const md = readFileSync(join(projectDir, "CLAUDE.md"), "utf8");
    expect(md.match(/# Persistence/g)?.length).toBe(1);
    expect(md.match(/<!-- thatch:begin -->/g)?.length).toBe(1);
  });

  test("content after the sentinel block survives a re-run", () => {
    const path = join(projectDir, "CLAUDE.md");
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    writeFileSync(path, readFileSync(path, "utf8") + "\n## My own notes\n\nKeep me.\n");
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    const md = readFileSync(path, "utf8");
    expect(md).toContain("## My own notes");
    expect(md.indexOf("## My own notes")).toBeGreaterThan(md.indexOf(END));
  });

  test("intact legacy prose block migrates to sentinels", () => {
    const path = join(projectDir, "CLAUDE.md");
    writeFileSync(
      path,
      "# My project\n\nUser content up top.\n\n" +
        "# Persistence\n\nThatch provides persistent memory across Claude Code sessions.\n\n" +
        "...(instructions)...\n\n" +
        LEGACY_END +
        "\n\n## Appended later\n\nTail content.\n",
    );
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    const md = readFileSync(path, "utf8");
    expect(md).toContain("# My project");
    expect(md).toContain("## Appended later");
    expect(md).toContain(BEGIN);
    expect(md).toContain(END);
    expect(md.match(/# Persistence/g)?.length).toBe(1);
    expect(md).not.toContain("...(instructions)...");
  });

  test("broken legacy block with instructions tail heals to sentinels", () => {
    // The observed corruption: an agent edit normalized the prose - the
    // end sentence's hyphen became an em dash - so the legacy end marker
    // no longer matches. The instructions run to EOF, so the heal replaces
    // from the legacy start marker to the end of the file.
    const path = join(projectDir, "CLAUDE.md");
    writeFileSync(
      path,
      "# My project\n\nUser content up top.\n\n" +
        "# Persistence\n\nThatch provides persistent memory across Claude Code sessions.\n\n" +
        "...(stale instructions)...\n\n" +
        '"Forget X" \u2014 `memory_recall` to find it, then `memory_forget`.\n',
    );
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    const md = readFileSync(path, "utf8");
    expect(md).toContain("# My project");
    expect(md).toContain(BEGIN);
    expect(md).toContain(END);
    expect(md).not.toContain("...(stale instructions)...");
    expect(md).not.toContain("\u2014 `memory_recall`");
  });

  test("broken legacy block with foreign tail is left alone", () => {
    const path = join(projectDir, "CLAUDE.md");
    const before =
      "# Persistence\n\nThatch provides persistent memory across Claude Code sessions.\n\nUnrelated user content that happens to follow.\n";
    writeFileSync(path, before);
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    // The heal guard did not pass, so nothing was written...
    expect(readFileSync(path, "utf8")).toBe(before);
    // ...but the append path still ran (no legacy end, no sentinel start
    // matched), wait - no: the legacy start IS present, so the append path
    // is unreachable. The file must be untouched.
    expect(readFileSync(path, "utf8")).not.toContain(BEGIN);
  });

  test("sentinel begin without end heals on re-run", () => {
    const path = join(projectDir, "CLAUDE.md");
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    const truncated = readFileSync(path, "utf8").slice(0, readFileSync(path, "utf8").indexOf(END));
    writeFileSync(path, truncated);
    setupClaudeCode("/usr/bin/thatch", false, projectDir, fakeHome);
    const md = readFileSync(path, "utf8");
    expect(md).toContain(BEGIN);
    expect(md).toContain(END);
    expect(md.match(/<!-- thatch:begin -->/g)?.length).toBe(1);
  });
});
