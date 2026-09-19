// Tests for the docs-to-wiki render script (.github/scripts/sync-wiki.ts).
// The script is a CLI, so tests run it as a subprocess against a fixture
// docs tree and assert on the rendered output. Fixtures keep these tests
// stable while real docs evolve.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "../.github/scripts/sync-wiki.ts");

// Dirs created per test, removed after each test so successful runs do not
// leak temp trees.
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function render(files: Record<string, string>): string {
  const fixtureRoot = tempDir("sync-wiki-fixture-");
  const outDir = tempDir("sync-wiki-out-");
  writeTree(fixtureRoot, files);
  const proc = Bun.spawnSync(["bun", SCRIPT, outDir, fixtureRoot]);
  expect(proc.exitCode).toBe(0);
  return outDir;
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
    expect(existsSync(path.join(out, "Guide: Memory.md"))).toBe(true);
    expect(existsSync(path.join(out, "Skills.md"))).toBe(true);
    expect(existsSync(path.join(out, "Feature: Qa System.md"))).toBe(true);
    expect(existsSync(path.join(out, "Developer Guide.md"))).toBe(true);
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

  // The duplicate branch of the guard is structurally unreachable under the
  // tier prefix scheme (every tier is prefixed except docs/dev, which is one
  // directory, so same-stem collisions cannot occur); the reachable case is a
  // doc named like a reserved generated page.
  test("fails on reserved page names", () => {
    const fixtureRoot = tempDir("sync-wiki-fixture-");
    const outDir = tempDir("sync-wiki-out-");
    writeTree(fixtureRoot, {
      "docs/dev/Home.md": "# impostor",
      "docs/user/memory.md": "# memory",
    });
    const proc = Bun.spawnSync(["bun", SCRIPT, outDir, fixtureRoot]);
    expect(proc.exitCode).not.toBe(0);
  });

  // README hardcodes wiki URLs whose page names are owned by the script's
  // naming tables; this is the drift check that fails the build when the two
  // diverge. Renders the REAL docs so a rename surfaces here.
  test("README wiki links resolve to rendered pages", () => {
    const repoRoot = path.resolve(import.meta.dir, "..");
    const out = tempDir("sync-wiki-out-");
    const proc = Bun.spawnSync(["bun", SCRIPT, out, repoRoot]);
    expect(proc.exitCode).toBe(0);

    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const linkedPages = [
      ...readme.matchAll(/github\.com\/sysread\/thatch\/wiki\/([A-Za-z0-9%.-]+)/g),
    ].map((m) => decodeURIComponent(m[1]).replaceAll("-", " "));
    expect(linkedPages.length).toBeGreaterThan(0);
    for (const page of new Set(linkedPages)) {
      expect(existsSync(path.join(out, `${page}.md`)), `README wiki link target missing: ${page}`).toBe(true);
    }
  });
});
