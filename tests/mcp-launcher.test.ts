import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The shipped plugin's bundled-server launcher (bin/mcp) picks the bun
 * runtime the plugin's dependencies install (the `bun` npm package's
 * @oven platform binary at node_modules/@oven/<platform>/bin/bun) over a
 * bun on PATH, and falls back to PATH when the dependency install did
 * not run. Claude Code spawns the launcher directly with a sanitized
 * env, so the pick logic must survive a minimal PATH.
 */
const launcherSource = join(import.meta.dir, "..", "bin", "mcp");

function makeTree(withOven: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "thatch-mcp-launcher-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(launcherSource, join(root, "bin", "mcp"));
  chmodSync(join(root, "bin", "mcp"), 0o755);
  writeFileSync(join(root, "bin", "thatch"), "#!/bin/sh\necho \"thatch $@\"\n");
  chmodSync(join(root, "bin", "thatch"), 0o755);
  if (withOven) {
    const ovenBin = join(root, "node_modules", "@oven", "bun-testplatform", "bin");
    mkdirSync(ovenBin, { recursive: true });
    writeFileSync(join(ovenBin, "bun"), "#!/bin/sh\necho \"oven-bun $@\"\n");
    chmodSync(join(ovenBin, "bun"), 0o755);
  }
  return root;
}

const trees: string[] = [];
afterAll(() => {
  for (const tree of trees) rmSync(tree, { recursive: true, force: true });
});

function run(root: string, path: string) {
  return Bun.spawnSync([join(root, "bin", "mcp"), "mcp", "--bundled"], {
    env: { PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("bin/mcp picks the bun runtime", () => {
  test("prefers the plugin-installed @oven binary over a bun on PATH", () => {
    const tree = makeTree(true);
    trees.push(tree);
    const result = run(tree, "/bin:/usr/bin");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("oven-bun");
    expect(result.stdout.toString()).toContain("mcp --bundled");
  });

  test("falls back to a bun on PATH when the dependency install did not run", () => {
    const tree = makeTree(false);
    trees.push(tree);
    const stubDir = join(tree, "path-bun");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "bun"), "#!/bin/sh\necho \"path-bun $@\"\n");
    chmodSync(join(stubDir, "bun"), 0o755);
    const result = run(tree, `${stubDir}:/bin:/usr/bin`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("path-bun");
    expect(result.stdout.toString()).toContain("mcp --bundled");
  });

  test("fails when neither runtime exists (the command must not resolve to silence)", () => {
    const tree = makeTree(false);
    trees.push(tree);
    const result = run(tree, "/bin:/usr/bin");
    expect(result.exitCode).not.toBe(0);
  });
});
