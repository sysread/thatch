import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BUN_RUNTIME_VERSION,
  parseBunLockfile,
  shippedDependencyView,
  slimPackageJson,
  type BunLockfile,
} from "../src/packaging";

/**
 * The published package's dependency view (src/packaging.ts). The tarball
 * ships a slimmed package.json and an npm-shrinkwrap.json generated from
 * it at prepack (Claude Code's installer picks the npm shrinkwrap over
 * bun.lock and installs with npm ci --ignore-scripts, so a user needs no
 * bun on PATH). These tests pin the view's rules: dependencies resolved
 * to the exact versions the repo's bun.lock carries, the bun runtime
 * injected as an optional dependency, the package.json slimming, and the
 * tolerance bun.lock's trailing commas need.
 */
const fixture: BunLockfile = {
  lockfileVersion: 1,
  configVersion: 1,
  workspaces: {
    "": {
      name: "testpkg",
      dependencies: { runtime: "^1.0.0", other: "^2.0.0" },
      devDependencies: { "dev-tool": "^1.0.0" },
      peerDependencies: { "host-peer": "^1.0.0" },
      optionalPeers: ["host-peer"],
    },
  },
  packages: {
    runtime: ["runtime@1.0.0", "", { dependencies: { shared: "^1.0.0" } }, "sha512-a"],
    other: ["other@2.0.0", "", {}, "sha512-b"],
    "dev-tool": ["dev-tool@1.0.0", "", {}, "sha512-g"],
    "host-peer": ["host-peer@1.0.0", "", {}, "sha512-i"],
  },
};

describe("shippedDependencyView", () => {
  test("pins the root's dependencies to the lockfile's resolved versions", () => {
    const view = shippedDependencyView(fixture);
    expect(view.dependencies).toEqual({ runtime: "1.0.0", other: "2.0.0" });
  });

  test("injects the bun runtime as the one optional dependency, pinned exact", () => {
    const view = shippedDependencyView(fixture);
    expect(Object.keys(view.optionalDependencies)).toEqual(["bun"]);
    expect(view.optionalDependencies.bun).toBe(BUN_RUNTIME_VERSION);
    expect(view.optionalDependencies.bun).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("resolves versioned packages-map keys (name@version)", () => {
    const { runtime: _bare, ...rest } = fixture.packages;
    const lock: BunLockfile = {
      ...fixture,
      packages: { ...rest, "runtime@1.2.3": ["runtime@1.2.3", "", {}, "sha512-a"] },
    };
    expect(shippedDependencyView(lock).dependencies.runtime).toBe("1.2.3");
  });

  test("throws on a dependency the lockfile does not resolve", () => {
    const lock: BunLockfile = {
      ...fixture,
      packages: { ...fixture.packages, runtime: ["runtime@1.0.0", "", {}, "sha512-a"] },
      workspaces: {
        "": { ...fixture.workspaces[""]!, dependencies: { runtime: "^1.0.0", ghost: "^1.0.0" } },
      },
    };
    expect(() => shippedDependencyView(lock)).toThrow(/no entry for ghost/);
  });

  test("throws on an ambiguous resolution (bare and versioned keys)", () => {
    const lock: BunLockfile = {
      ...fixture,
      packages: { ...fixture.packages, "runtime@9.9.9": ["runtime@9.9.9", "", {}, "sha512-k"] },
    };
    expect(() => shippedDependencyView(lock)).toThrow(/ambiguously/);
  });

  test("the repo's real bun.lock resolves every runtime dependency", () => {
    const lock = parseBunLockfile(readFileSync(join(import.meta.dir, "..", "bun.lock"), "utf8"));
    const view = shippedDependencyView(lock);
    for (const name of ["@huggingface/transformers", "onnxruntime-web", "zod"]) {
      expect(view.dependencies[name]).toMatch(/^\d/);
    }
    for (const dev of ["@opencode/client", "@opencode/plugin", "typescript", "markdownlint-cli2"]) {
      expect(view.dependencies[dev]).toBeUndefined();
    }
  });
});

describe("slimPackageJson", () => {
  test("strips devDependencies and scripts, keeps the runtime and peer shape", () => {
    const slim = slimPackageJson({
      name: "x",
      version: "1.0.0",
      dependencies: { runtime: "^1.0.0" },
      devDependencies: { "dev-tool": "^1.0.0" },
      peerDependencies: { "host-peer": "^1.0.0" },
      peerDependenciesMeta: { "host-peer": { optional: true } },
      scripts: { test: "bun test", prepack: "bun scripts/prepack.ts" },
      bin: { x: "./bin/x" },
    });
    expect(slim.devDependencies).toBeUndefined();
    expect(slim.scripts).toBeUndefined();
    expect(slim.dependencies).toEqual({ runtime: "^1.0.0" });
    expect(slim.peerDependencies).toEqual({ "host-peer": "^1.0.0" });
    expect(slim.peerDependenciesMeta).toEqual({ "host-peer": { optional: true } });
    expect(slim.bin).toEqual({ x: "./bin/x" });
  });
});

describe("parseBunLockfile", () => {
  test("tolerates bun.lock's trailing commas", () => {
    const lock = parseBunLockfile(`{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "dependencies": {
        "a": "^1.0.0",
      },
    },
  },
  "packages": {
    "a": ["a@1.0.0", "", {}, "sha512-a"],
  },
}`);
    expect(shippedDependencyView(lock).dependencies.a).toBe("1.0.0");
  });
});

describe("the launcher script (bin/mcp)", () => {
  const launcher = join(import.meta.dir, "..", "bin", "mcp");

  test("ships executable with a POSIX sh shebang", () => {
    const mode = statSync(launcher).mode;
    expect(mode & 0o111).toBe(0o111);
    expect(readFileSync(launcher, "utf8").startsWith("#!/bin/sh")).toBe(true);
  });
});
