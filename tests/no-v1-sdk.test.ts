// The v1-SDK drift gate (the drop-opencode-v1 plan's replacement for the
// old subprocess isolation probe): no module in the repo may reference the
// v1 SDK. The drop deleted the v1 adapter and the v1-SDK dev/peer
// dependencies; a stray import or doc mention would either crash the build
// (unresolvable package) or misdocument the plugin as dual-SDK. Reads the
// REAL files and fails the suite on divergence - the same drift-test
// pattern as tests/sync-wiki.test.ts's README-link check.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Built in code, never a literal: this test file is itself inside the
// scanned tree, and a literal marker would match its own source. The two
// halves join to the v1 SDK's package-scope prefix (the "ai" org scope
// under the @opencode namespace).
const V1_SDK_MARKER = ["@opencode", "-ai", "/"].join("");

const REPO_ROOT = join(import.meta.dir, "..");

/** Source-ish files under dir (skipping installs and vendored trees). */
function* scanFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a named root that does not exist in this checkout
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* scanFiles(path);
    } else if (/\.(ts|tsx|js|mjs|json|toml|sh)$/.test(entry)) {
      yield path;
    } else if (dir === join(REPO_ROOT, "bin") && stat.isFile() && stat.mode & 0o111) {
      // bin/'s extensionless executables (bin/thatch) are source too - the
      // extension filter alone would skip them.
      yield path;
    }
  }
}

describe("v1 SDK drift gate", () => {
  test("no source, test, QA, bin, or package file references the v1 SDK", () => {
    const offenders: string[] = [];
    // The plan's gate scope: src/, tests/, qa/, bin/, and package.json.
    // tests/ covers tests/qa/; markdown under docs/ is policed by the
    // docs gate (lint + review), not here.
    for (const root of ["src", "tests", "qa", "bin"]) {
      for (const file of scanFiles(join(REPO_ROOT, root))) {
        if (readFileSync(file, "utf8").includes(V1_SDK_MARKER)) offenders.push(file);
      }
    }
    const pkg = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
    if (pkg.includes(V1_SDK_MARKER)) offenders.push("package.json");
    expect(offenders, `files still referencing the v1 SDK: ${offenders.join(", ")}`).toEqual([]);
  });

  test("the scanner catches a marker-bearing string and passes clean text (self-check)", () => {
    // Proves the matcher works without placing a matchable literal in
    // this scanned file: the offender composes from the same halves, and
    // clean text passes.
    const offender = ["@opencode", "-ai", "/plugin"].join("");
    expect(offender.includes(V1_SDK_MARKER)).toBe(true);
    expect("clean file text, no SDK scope here".includes(V1_SDK_MARKER)).toBe(false);
  });
});

// The bun:sqlite drift gate (the node-sqlite plan, D16): after the
// node:sqlite re-point, no src/ or bin/ file may import bun:sqlite again -
// a stray import would crash at runtime on node (and on bun < 1.4.2, which
// has no node:sqlite to fall back to through the other side). The marker
// matches the IMPORT shape, not the bare substring: the literal
// "bun:sqlite" legitimately appears in src/ comments that document the
// migration. tests/ and qa/ keep raw bun:sqlite on purpose - fixture
// seeding uses raw handles - so the scan roots are src/ and bin/ only.
const BUN_SQLITE_IMPORT = /from ["']bun:sqlite["']/;

describe("bun:sqlite drift gate", () => {
  test("no src or bin file imports bun:sqlite", () => {
    const offenders: string[] = [];
    for (const root of ["src", "bin"]) {
      for (const file of scanFiles(join(REPO_ROOT, root))) {
        if (BUN_SQLITE_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    }
    expect(offenders, `files still importing bun:sqlite: ${offenders.join(", ")}`).toEqual([]);
  });

  test("the import-shape matcher flags an import and passes a comment mention (self-check)", () => {
    expect(BUN_SQLITE_IMPORT.test('import { Database } from "bun:sqlite";')).toBe(true);
    expect(BUN_SQLITE_IMPORT.test("// bun:sqlite's .get() returns null for a missing row")).toBe(false);
  });
});
