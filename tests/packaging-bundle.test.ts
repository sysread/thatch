import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleNodeDist } from "../src/packaging";

/**
 * The prepack bundle step (D12a, docs/plans/node-sqlite-driver.md):
 * dist/ is first-party code only - every node_modules dependency is
 * externalized - and it must boot under node. The fixture pins the two
 * properties the real bundle's smoke (the M2 gate's node boot) checks
 * once: an externalized dynamic-capable import, and the JSON import
 * attribute inlining (OQ4 - bin/thatch.ts's `import pkg ... with
 * { type: "json" }`).
 */

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "thatch-bundle-"));  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "bundle-fixture", version: "1.2.3", type: "module" }));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "cli.ts"),
    [
      "import pkg from \"../package.json\" with { type: \"json\" };",
      "import { dep } from \"fixture-dep\";",
      "console.log(`${pkg.version} ${dep()}`);",
    ].join("\n"),
  );
  const depDir = join(root, "node_modules", "fixture-dep");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, "package.json"), JSON.stringify({ name: "fixture-dep", version: "0.0.1", type: "module", main: "index.js" }));
  writeFileSync(join(depDir, "index.js"), "export function dep() { return \"dep-value\"; }");
  return root;
}

const hasNode = Bun.which("node") !== null;

describe("bundleNodeDist", () => {
  test("externalizes node_modules, inlines the JSON attribute, and boots under node", async () => {
    const root = makeFixture();
    try {
      const result = await bundleNodeDist({ root, entries: ["bin/cli.ts"] });
      const out = result.outputs.find((p) => p.endsWith("cli.js"));
      expect(out).toBeDefined();
      const bundled = readFileSync(out!, "utf8");
      // Externalized: the dep import survives as an import specifier,
      // never inlined (dist is first-party code only).
      expect(bundled).toMatch(/import\s+.*fixture-dep/);
      expect(bundled).not.toContain("dep-value");
      // OQ4: the JSON import attribute inlines the file's CONTENT.
      expect(bundled).toContain("1.2.3");
      if (!hasNode) return; // the node boot is checked in the M2 gate too
      const proc = Bun.spawnSync(["node", out!], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString().trim()).toBe("1.2.3 dep-value");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed bundle throws with the build logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "thatch-bundle-"));
    try {
      writeFileSync(join(root, "package.json"), "{}");
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(join(root, "bin", "broken.ts"), "import { nope } from \"./missing\"; nope();");
      expect(bundleNodeDist({ root, entries: ["bin/broken.ts"] })).rejects.toThrow("bundling the node dist failed");
      expect(existsSync(join(root, "dist"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
