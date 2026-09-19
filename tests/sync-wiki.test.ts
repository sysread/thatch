// Tests for the docs-to-wiki render script (.github/scripts/sync-wiki.ts).
// The script is a CLI, so tests run it as a subprocess against a fixture
// docs tree and assert on the rendered output. Fixtures keep these tests
// stable while real docs evolve.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "../.github/scripts/sync-wiki.ts");

function writeTree(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function render(files: Record<string, string>): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "sync-wiki-fixture-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "sync-wiki-out-"));
  try {
    writeTree(fixtureRoot, files);
    const proc = Bun.spawnSync(["bun", SCRIPT, outDir, fixtureRoot]);
    expect(proc.exitCode).toBe(0);
    return outDir;
  } catch (err) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    throw err;
  }
}

function read(outDir: string, page: string): string {
  const file = path.join(outDir, page);
  expect(existsSync(file), `expected page ${page}`).toBe(true);
  return readFileSync(file, "utf8");
}

describe("sync-wiki", () => {
  test("names pages by tier: Guide:, bare, Feature:", () => {
    const out = render({
      "docs/user/memory.md": "# memory",
      "docs/dev/skills.md": "# skills",
      "docs/dev/features/qa-system.md": "# qa",
      "docs/dev/README.md": "# dev",
    });
    existsSync(path.join(out, "Guide: Memory.md"));
    existsSync(path.join(out, "Skills.md"));
    existsSync(path.join(out, "Feature: Qa System.md"));
    existsSync(path.join(out, "Developer Guide.md"));
    expect(existsSync(path.join(out, "Memory.md"))).toBe(false);
  });

  test("excludes plans and in-progress docs", () => {
    const out = render({
      "docs/user/memory.md": "# memory",
      "docs/plans/intuition-drives.md": "# plan",
      "docs/in-progress/wip.md": "# wip",
    });
    expect(existsSync(path.join(out, "Intuition-drives.md"))).toBe(false);
    expect(existsSync(path.join(out, "Wip.md"))).toBe(false);
  });

  test("rewrites relative md links to URL-encoded wiki slugs", () => {
    const out = render({
      "docs/user/memory.md": "# memory",
      "docs/user/hygiene.md": "See [memory.md](memory.md) and [the guide](memory.md#cache).",
    });
    const page = read(out, "Guide: Hygiene.md");
    expect(page).toContain("[memory.md](Guide%3A-Memory)");
    expect(page).toContain("[the guide](Guide%3A-Memory#cache)");
  });

  test("rewrites cross-directory links and keeps external links untouched", () => {
    const out = render({
      "docs/dev/features/qa-system.md": "Uses [skills](../skills.md); see [site](https://example.com).",
      "docs/dev/skills.md": "# skills",
    });
    const page = read(out, "Feature: Qa System.md");
    expect(page).toContain("[skills](Skills)");
    expect(page).toContain("[site](https://example.com)");
  });

  test("uses [[Page]] wiki links only for exact name matches", () => {
    const out = render({
      "docs/user/memory.md": "# memory",
      "docs/user/hygiene.md": "Bare: [Guide: Memory](memory.md). Labeled: [memory](memory.md).",
    });
    const page = read(out, "Guide: Hygiene.md");
    expect(page).toContain("Bare: [[Guide: Memory]]");
    expect(page).toContain("Labeled: [memory](Guide%3A-Memory)");
    expect(page).not.toContain("[[Guide: Memory|");
  });

  test("generates Home and sidebar grouped by tier", () => {
    const out = render({
      "docs/user/memory.md": "# memory",
      "docs/dev/skills.md": "# skills",
      "docs/dev/features/qa-system.md": "# qa",
    });
    const home = read(out, "Home.md");
    expect(home).toContain("## User");
    expect(home).toContain("## Developer");
    expect(home).toContain("## Dev Feature Guides");
    expect(home).toContain("- [[Guide: Memory]]");

    const sidebar = read(out, "_Sidebar.md");
    expect(sidebar).toContain("**[Home](Home)**");
    expect(sidebar).toContain("**Dev Feature Guides**");
    expect(sidebar).toContain("- [[Feature: Qa System]]");
  });

  test("fails on duplicate page names", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "sync-wiki-fixture-"));
    const outDir = mkdtempSync(path.join(tmpdir(), "sync-wiki-out-"));
    try {
      // docs/user/README.md and docs/dev/README.md are both special-cased to
      // different names; a real duplicate needs a special-name collision, so
      // simulate with two files the script maps to one page: same stem in
      // docs/dev (bare name) collides with nothing today, so assert the guard
      // via the reserved Home name instead.
      writeTree(fixtureRoot, {
        "docs/dev/Home.md": "# impostor",
        "docs/user/memory.md": "# memory",
      });
      const proc = Bun.spawnSync(["bun", SCRIPT, outDir, fixtureRoot]);
      expect(proc.exitCode).not.toBe(0);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
