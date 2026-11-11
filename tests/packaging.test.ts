import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseBunLockfile,
  runtimeClosure,
  slimLockfile,
  slimPackageJson,
  type BunLockfile,
} from "../src/packaging";

/**
 * The published package's dependency view (src/packaging.ts). Claude Code
 * installs every package a shipped lockfile lists, so the tarball must
 * carry the runtime closure only - these tests pin the closure rules
 * (optional edges in, dev trees and the host-provided peer out), the
 * package.json slimming, and the tolerance bun.lock's trailing commas
 * need.
 */
const fixture: BunLockfile = {
  lockfileVersion: 1,
  configVersion: 1,
  workspaces: {
    "": {
      name: "testpkg",
      dependencies: { runtime: "^1.0.0", other: "^2.0.0", dup: "^1.0.0" },
      devDependencies: { "dev-tool": "^1.0.0" },
      peerDependencies: { "host-peer": "^1.0.0" },
      optionalPeers: ["host-peer"],
    },
  },
  packages: {
    runtime: ["runtime@1.0.0", "", { dependencies: { shared: "^1.0.0", opt: "^1.0.0" } }, "sha512-a"],
    other: ["other@2.0.0", "", {}, "sha512-b"],
    dup: ["dup@1.0.0", "", {}, "sha512-c"],
    shared: ["shared@1.0.0", "", {}, "sha512-d"],
    opt: ["opt@1.0.0", "", { optionalDependencies: { "opt-bin": "1.0.0" } }, "sha512-e"],
    "opt-bin": ["opt-bin@1.0.0", "", {}, "sha512-f"],
    "dev-tool": ["dev-tool@1.0.0", "", { dependencies: { "dev-only-transitive": "^1.0.0" } }, "sha512-g"],
    "dev-only-transitive": ["dev-only-transitive@1.0.0", "", {}, "sha512-h"],
    "host-peer": ["host-peer@1.0.0", "", {}, "sha512-i"],
    isolated: ["isolated@3.0.0", "", {}, "sha512-j"],
  },
};

describe("runtimeClosure", () => {
  test("walks dependencies and optional edges from the root's dependencies only", () => {
    const closure = runtimeClosure(fixture);
    for (const name of ["runtime", "other", "dup", "shared", "opt", "opt-bin"]) {
      expect(closure.has(name)).toBe(true);
    }
    for (const name of ["dev-tool", "dev-only-transitive", "host-peer", "isolated"]) {
      expect(closure.has(name)).toBe(false);
    }
  });

  test("resolves versioned packages-map keys (name@version)", () => {
    const lock: BunLockfile = {
      ...fixture,
      packages: {
        "runtime@1.2.3": ["runtime@1.2.3", "", {}, "sha512-a"],
        other: ["other@2.0.0", "", {}, "sha512-b"],
        dup: ["dup@1.0.0", "", {}, "sha512-c"],
      },
    };
    expect(runtimeClosure(lock).has("runtime")).toBe(true);
  });

  test("throws on a dependency the lockfile does not resolve", () => {
    const lock: BunLockfile = {
      ...fixture,
      packages: { ...fixture.packages, runtime: ["runtime@1.0.0", "", { dependencies: { ghost: "^1.0.0" } }, "sha512-a"] },
    };
    expect(() => runtimeClosure(lock)).toThrow(/no entry for ghost/);
  });

  test("throws on an ambiguous resolution (bare and versioned keys)", () => {
    const lock: BunLockfile = {
      ...fixture,
      packages: { ...fixture.packages, "dup@9.9.9": ["dup@9.9.9", "", {}, "sha512-k"] },
    };
    expect(() => runtimeClosure(lock)).toThrow(/ambiguously/);
  });
});

describe("slimLockfile", () => {
  test("keeps the runtime closure and the root's dependency/peer declarations", () => {
    const slim = slimLockfile(fixture);
    expect(slim.lockfileVersion).toBe(1);
    expect(slim.configVersion).toBe(1);
    const root = slim.workspaces[""]!;
    expect(root.dependencies).toEqual({ runtime: "^1.0.0", other: "^2.0.0", dup: "^1.0.0" });
    expect(root.devDependencies).toBeUndefined();
    expect(root.peerDependencies).toEqual({ "host-peer": "^1.0.0" });
    expect(root.optionalPeers).toEqual(["host-peer"]);
    expect(Object.keys(slim.packages).sort()).toEqual(["dup", "opt", "opt-bin", "other", "runtime", "shared"]);
    // Entry contents untouched - the integrity hashes must survive.
    expect(slim.packages.runtime![3]).toBe("sha512-a");
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
    expect(runtimeClosure(lock).has("a")).toBe(true);
  });

  test("the repo's real bun.lock parses and its closure excludes the dev trees", () => {
    const lock = parseBunLockfile(readFileSync(join(import.meta.dir, "..", "bun.lock"), "utf8"));
    const closure = runtimeClosure(lock);
    expect(closure.size).toBeGreaterThan(0);
    for (const dev of ["@opencode/client", "@opencode/plugin", "typescript", "markdownlint-cli2", "yaml", "@types/bun"]) {
      expect(closure.has(dev)).toBe(false);
    }
    for (const runtime of ["@huggingface/transformers", "onnxruntime-web", "zod", "onnxruntime-node", "sharp"]) {
      expect(closure.has(runtime)).toBe(true);
    }
  });
});
