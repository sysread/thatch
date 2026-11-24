import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The runtime launchers (bin/mcp -> bin/thatch) pick the runtime by
 * PROBED capability, not by PATH name (docs/plans/node-sqlite-driver.md,
 * D12). The stub set pins the whole decision matrix:
 *
 * - a capable node (its `node -e 'require("node:sqlite")'` probe exits 0)
 *   plus the prepack-bundled dist -> node runs dist/thatch.js;
 * - a flagged-band node (22.5-22.12: the probe exits 1) -> treated as
 *   absent, the next row runs;
 * - a capable node WITHOUT dist (the Nix fileset ships none) -> the bun
 *   row, so the dist-existence test keeps the nix install alive;
 * - a bun on PATH -> runs the TypeScript source (bin/thatch.ts);
 * - nothing -> a loud failure naming the missing prerequisites.
 *
 * Claude Code spawns the launcher directly with a sanitized env, so the
 * pick must survive a minimal PATH.
 */
const repoBin = join(import.meta.dir, "..", "bin");

function makeTree(opts: { withDist?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "thatch-mcp-launcher-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(join(repoBin, "mcp"), join(root, "bin", "mcp"));
  copyFileSync(join(repoBin, "thatch"), join(root, "bin", "thatch"));
  chmodSync(join(root, "bin", "mcp"), 0o755);
  chmodSync(join(root, "bin", "thatch"), 0o755);
  // The TS source the shim's bun row executes (the real one would
  // open a real db; the stub proves only WHICH runtime got picked).
  writeFileSync(join(root, "bin", "thatch.ts"), "#!/bin/sh\necho \"ts $@\"\n");
  chmodSync(join(root, "bin", "thatch.ts"), 0o755);
  if (opts.withDist) {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "thatch.js"), "console.log(\"node-dist\");\n");
  }
  return root;
}

/** A node stub: the -e capability probe exits $NODE_PROBE_EXIT; any real
 * invocation echoes its args (so the test sees dist/thatch.js). */
function makeNodeStub(dir: string, probeExit: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "node"),
    `#!/bin/sh\nif [ "\${1:-}" = "-e" ]; then exit ${probeExit}; fi\necho "node $@"\n`,
  );
  chmodSync(join(dir, "node"), 0o755);
}

function makeBunStub(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bun"), "#!/bin/sh\necho \"path-bun $@\"\n");
  chmodSync(join(dir, "bun"), 0o755);
}

const trees: string[] = [];
afterAll(() => {
  for (const tree of trees) rmSync(tree, { recursive: true, force: true });
});

function run(root: string, path: string, env: Record<string, string> = {}) {
  return Bun.spawnSync([join(root, "bin", "mcp"), "mcp", "--bundled"], {
    env: { PATH: path, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("bin/mcp picks the runtime by capability", () => {
  test("a capable node with dist runs the bundled dist", () => {
    const tree = makeTree({ withDist: true });
    trees.push(tree);
    const stubDir = join(tree, "path-node");
    makeNodeStub(stubDir, 0);
    const result = run(tree, `${stubDir}:/bin:/usr/bin`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toMatch(/node \S+dist\/thatch\.js/);
    expect(result.stdout.toString()).toContain("mcp --bundled");
  });

  test("a flagged-band node (the probe fails) is treated as absent", () => {
    const tree = makeTree({ withDist: true });
    trees.push(tree);
    const stubDir = join(tree, "path-node");
    makeNodeStub(stubDir, 1);
    const bunDir = join(tree, "path-bun");
    makeBunStub(bunDir);
    const result = run(tree, `${stubDir}:${bunDir}:/bin:/usr/bin`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("path-bun");
    expect(result.stdout.toString()).toContain("bin/thatch.ts");
  });

  test("a capable node without dist falls through (the dist test is load-bearing)", () => {
    const tree = makeTree({});
    trees.push(tree);
    const nodeDir = join(tree, "path-node");
    makeNodeStub(nodeDir, 0);
    const bunDir = join(tree, "path-bun");
    makeBunStub(bunDir);
    const result = run(tree, `${nodeDir}:${bunDir}:/bin:/usr/bin`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("path-bun");
  });

  test("fails loudly when no runtime exists (the command must not resolve to silence)", () => {
    const tree = makeTree({});
    trees.push(tree);
    const result = run(tree, "/bin:/usr/bin");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("no usable JavaScript runtime");
    // The failure names the prerequisites, so a user with neither
    // runtime gets an actionable message, not a cryptic one.
    expect(result.stderr.toString()).toContain("node >= 22.13");
    expect(result.stderr.toString()).toContain("bun >= 1.4.2");
    expect(result.stderr.toString()).not.toContain("@oven");
  });

  test("the bin/thatch shim answers the same matrix directly", () => {
    const tree = makeTree({ withDist: true });
    trees.push(tree);
    const stubDir = join(tree, "path-node");
    makeNodeStub(stubDir, 0);
    const result = Bun.spawnSync([join(tree, "bin", "thatch"), "--version"], {
      env: { PATH: `${stubDir}:/bin:/usr/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toMatch(/node \S+dist\/thatch\.js --version/);
  });

  test("a symlinked shim (the npm global bin-link shape) still finds the package root", () => {
    // npm i -g bin-links <prefix>/bin/thatch -> the installed bin/thatch.
    // The shim must resolve ITS OWN symlink before computing root, or
    // root becomes <prefix> and every row misses.
    const tree = makeTree({ withDist: true });
    trees.push(tree);
    const stubDir = join(tree, "path-node");
    makeNodeStub(stubDir, 0);
    const prefix = join(tree, "npm-global");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync(join(tree, "bin", "thatch"), join(prefix, "bin", "thatch"));
    const result = Bun.spawnSync([join(prefix, "bin", "thatch"), "--version"], {
      env: { PATH: `${stubDir}:/bin:/usr/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toMatch(/node \S+dist\/thatch\.js --version/);
  });
});
