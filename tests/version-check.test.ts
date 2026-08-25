import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  versionFilePath,
  npmCachePath,
  writeVersionFile,
  readVersionFile,
  removeVersionFile,
  detectSkew,
  readNpmCacheForUpdate,
  readOnDiskVersion,
  startVersionChecker,
  stopVersionChecker,
  getVersionChecker,
  compareSemver,
  _resetForTesting,
} from "../src/version-check";
import pkg from "../package.json";

let dir: string;
let originalDbPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thatch-ver-"));
  originalDbPath = process.env.THATCH_DB_PATH;
  process.env.THATCH_DB_PATH = join(dir, "test.db");
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
  if (originalDbPath === undefined) {
    delete process.env.THATCH_DB_PATH;
  } else {
    process.env.THATCH_DB_PATH = originalDbPath;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("version file (Check B - skew detection)", () => {
  test("writeVersionFile creates a file with the running version", () => {
    const dbPath = join(dir, "test.db");
    writeVersionFile(dbPath);
    const path = versionFilePath(dbPath);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8").trim()).toBe(pkg.version);
  });

  test("readVersionFile returns the version string", () => {
    const dbPath = join(dir, "test.db");
    writeVersionFile(dbPath);
    expect(readVersionFile(dbPath)).toBe(pkg.version);
  });

  test("readVersionFile returns null when file does not exist", () => {
    const dbPath = join(dir, "nonexistent.db");
    expect(readVersionFile(dbPath)).toBeNull();
  });

  test("removeVersionFile deletes the file", () => {
    const dbPath = join(dir, "test.db");
    writeVersionFile(dbPath);
    removeVersionFile(dbPath);
    expect(existsSync(versionFilePath(dbPath))).toBe(false);
  });

  test("removeVersionFile is safe when file does not exist", () => {
    const dbPath = join(dir, "nonexistent.db");
    expect(() => removeVersionFile(dbPath)).not.toThrow();
  });
});

describe("detectSkew", () => {
  test("returns null when no version file exists", () => {
    const dbPath = join(dir, "test.db");
    expect(detectSkew(dbPath)).toBeNull();
  });

  test("returns null when versions match", () => {
    const dbPath = join(dir, "test.db");
    writeVersionFile(dbPath);
    expect(detectSkew(dbPath)).toBeNull();
  });

  test("returns warning when server version differs from package version", () => {
    const dbPath = join(dir, "test.db");
    // Simulate an old server that stamped version 0.0.1.
    const path = versionFilePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "0.0.1", "utf-8");

    const warning = detectSkew(dbPath);
    expect(warning).not.toBeNull();
    expect(warning).toContain("0.0.1");
    expect(warning).toContain(pkg.version);
    expect(warning).toContain("Restart");
  });
});

describe("npm cache (Check A - update available)", () => {
  test("readNpmCacheForUpdate returns null when no cache file exists", () => {
    const dbPath = join(dir, "test.db");
    expect(readNpmCacheForUpdate(dbPath)).toBeNull();
  });

  test("readNpmCacheForUpdate returns null when cached version matches running", () => {
    const dbPath = join(dir, "test.db");
    const path = npmCachePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: pkg.version, checkedAt: Date.now() }), "utf-8");
    expect(readNpmCacheForUpdate(dbPath)).toBeNull();
  });

  test("readNpmCacheForUpdate returns warning when cached version is newer", () => {
    const dbPath = join(dir, "test.db");
    const path = npmCachePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: "99.99.99", checkedAt: Date.now() }), "utf-8");
    const warning = readNpmCacheForUpdate(dbPath);
    expect(warning).not.toBeNull();
    expect(warning).toContain("99.99.99");
    expect(warning).toContain("npm update");
    expect(warning).toContain("restart");
  });

  test("readNpmCacheForUpdate returns null on corrupt cache file", () => {
    const dbPath = join(dir, "test.db");
    const path = npmCachePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json", "utf-8");
    expect(readNpmCacheForUpdate(dbPath)).toBeNull();
  });
});

describe("readOnDiskVersion", () => {
  test("returns the version from package.json on disk", () => {
    const version = readOnDiskVersion();
    expect(version).not.toBeNull();
    expect(version).toBe(pkg.version);
  });
});

describe("NpmVersionChecker lifecycle", () => {
  test("startVersionChecker creates and starts a checker", () => {
    const dbPath = join(dir, "test.db");
    const checker = startVersionChecker(dbPath);
    expect(checker).toBeDefined();
    expect(getVersionChecker()).toBe(checker);
  });

  test("startVersionChecker is idempotent (returns same checker)", () => {
    const dbPath = join(dir, "test.db");
    const first = startVersionChecker(dbPath);
    const second = startVersionChecker(dbPath);
    expect(first).toBe(second);
  });

  test("stopVersionChecker clears the module-level reference", () => {
    const dbPath = join(dir, "test.db");
    startVersionChecker(dbPath);
    stopVersionChecker();
    expect(getVersionChecker()).toBeNull();
  });

  test("checker loads cached npm version from file on construction", () => {
    const dbPath = join(dir, "test.db");
    // Write a cache file before starting the checker.
    const path = npmCachePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: "99.99.99", checkedAt: Date.now() }), "utf-8");

    const checker = startVersionChecker(dbPath);
    expect(checker.getLatestVersion()).toBe("99.99.99");
    expect(checker.isOutdated()).toBe(true);
    expect(checker.getUpdateWarning()).not.toBeNull();
    expect(checker.getUpdateWarning()).toContain("99.99.99");
  });

  test("checker reports not outdated when no cache exists", () => {
    const dbPath = join(dir, "test.db");
    const checker = startVersionChecker(dbPath);
    expect(checker.getLatestVersion()).toBeNull();
    expect(checker.isOutdated()).toBe(false);
    expect(checker.getUpdateWarning()).toBeNull();
  });

  test("checker reports not outdated when cache matches running version", () => {
    const dbPath = join(dir, "test.db");
    const path = npmCachePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: pkg.version, checkedAt: Date.now() }), "utf-8");

    const checker = startVersionChecker(dbPath);
    expect(checker.isOutdated()).toBe(false);
    expect(checker.getUpdateWarning()).toBeNull();
  });
});

describe("version file and npm cache paths are deterministic from dbPath", () => {
  test("same dbPath produces same version file path", () => {
    const dbPath = join(dir, "test.db");
    expect(versionFilePath(dbPath)).toBe(versionFilePath(dbPath));
  });

  test("different dbPaths produce different version file paths", () => {
    const a = join(dir, "a.db");
    const b = join(dir, "b.db");
    expect(versionFilePath(a)).not.toBe(versionFilePath(b));
  });

  test("version file and npm cache share the same directory", () => {
    const dbPath = join(dir, "test.db");
    const vf = versionFilePath(dbPath);
    const nc = npmCachePath(dbPath);
    expect(dirname(vf)).toBe(dirname(nc));
  });
});

describe("compareSemver", () => {
  test("equal versions return 0", () => {
    expect(compareSemver("0.1.30", "0.1.30")).toBe(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  test("older version is negative", () => {
    expect(compareSemver("0.1.30", "0.1.31")).toBeLessThan(0);
    expect(compareSemver("0.0.9", "0.1.0")).toBeLessThan(0);
    expect(compareSemver("0.9.9", "1.0.0")).toBeLessThan(0);
  });

  test("newer version is positive", () => {
    expect(compareSemver("0.1.31", "0.1.30")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  test("handles different segment counts", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0.1", "1.0.0")).toBeGreaterThan(0);
  });
});

describe("npm cache with stale (older) cached version", () => {
  test("readNpmCacheForUpdate returns null when cached version is older than running", () => {
    const dbPath = join(dir, "test.db");
    const path = npmCachePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    // Simulate a stale cache from before the current version was published.
    const older = pkg.version.split(".").map(Number);
    older[2] = (older[2] ?? 0) - 1;
    const olderStr = older.join(".");
    writeFileSync(path, JSON.stringify({ version: olderStr, checkedAt: Date.now() }), "utf-8");
    expect(readNpmCacheForUpdate(dbPath)).toBeNull();
  });

  test("checker reports not outdated when cached version is older than running", () => {
    const dbPath = join(dir, "test.db");
    const path = npmCachePath(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    const older = pkg.version.split(".").map(Number);
    older[2] = (older[2] ?? 0) - 1;
    const olderStr = older.join(".");
    writeFileSync(path, JSON.stringify({ version: olderStr, checkedAt: Date.now() }), "utf-8");

    const checker = startVersionChecker(dbPath);
    expect(checker.getLatestVersion()).toBe(olderStr);
    expect(checker.isOutdated()).toBe(false);
    expect(checker.getUpdateWarning()).toBeNull();
  });
});
