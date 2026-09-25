import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVersionOutput, tagBinaries } from "./qa/binaries";

// The QA matrix's binary discovery: version parsing from `--version`
// output, major tagging, and real-path/version dedup over candidate bin
// dirs. The impure discovery entry points (brew/which) are not tested
// here - they shell out to the machine's package manager.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thatch-qa-binaries-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a fake `opencode` into a bin dir that prints the given version. */
function fakeBinary(binDir: string, versionLine: string, exitCode = 0): void {
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "opencode");
  writeFileSync(bin, `#!/bin/sh\necho "${versionLine}"\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
}

describe("parseVersionOutput", () => {
  test("parses the real v1 and v2 --version shapes", () => {
    expect(parseVersionOutput("opencode v1.18.32\n")).toEqual({ major: 1, version: "1.18.32" });
    expect(parseVersionOutput("opencode v2.0.15\n")).toEqual({ major: 2, version: "2.0.15" });
    expect(parseVersionOutput("1.18.32")).toEqual({ major: 1, version: "1.18.32" });
  });

  test("rejects garbage and partial versions", () => {
    expect(parseVersionOutput("opencode")).toBeNull();
    expect(parseVersionOutput("")).toBeNull();
    expect(parseVersionOutput("version 2")).toBeNull();
  });
});

describe("tagBinaries", () => {
  test("tags by major and dedups candidates resolving to the same binary", () => {
    // The brew opt-prefix candidate and the PATH candidate here are the
    // SAME binary (a symlink and its target), as on a real brew machine.
    const realBin = join(dir, "cellar", "opencode-v2", "2.0.15", "bin");
    fakeBinary(realBin, "opencode v2.0.15");
    const optBin = join(dir, "opt", "opencode-v2", "bin");
    mkdirSync(optBin, { recursive: true });
    symlinkSync(join(realBin, "opencode"), join(optBin, "opencode"));

    const hosts = tagBinaries([
      { binDir: realBin, origin: "brew:opencode-v2" },
      { binDir: optBin, origin: "PATH" },
    ]);
    expect(hosts).toEqual([
      { tag: "v2", version: "2.0.15", binDir: realBin, origin: "brew:opencode-v2" },
    ]);
  });

  test("distinct installs become distinct legs tagged by their own version", () => {
    const v1Bin = join(dir, "v1", "bin");
    const v2Bin = join(dir, "v2", "bin");
    fakeBinary(v1Bin, "opencode v1.18.32");
    fakeBinary(v2Bin, "opencode v2.0.16");
    const hosts = tagBinaries([
      { binDir: v1Bin, origin: "brew:opencode" },
      { binDir: v2Bin, origin: "brew:opencode-v2" },
    ]);
    expect(hosts.map((h) => [h.tag, h.version])).toEqual([["v1", "1.18.32"], ["v2", "2.0.16"]]);
  });

  test("two installs sharing a major collapse to one leg - the newest version wins", () => {
    // Brew 2.0.15 keg plus a newer PATH copy: one major, one leg - two
    // legs would both label [v2] and collide on the fixture directory.
    const oldBin = join(dir, "old", "bin");
    const newBin = join(dir, "new", "bin");
    fakeBinary(oldBin, "opencode v2.0.15");
    fakeBinary(newBin, "opencode v2.1.0");
    const hosts = tagBinaries([
      { binDir: oldBin, origin: "brew:opencode-v2" },
      { binDir: newBin, origin: "PATH" },
    ]);
    expect(hosts).toEqual([
      { tag: "v2", version: "2.1.0", binDir: newBin, origin: "PATH" },
    ]);
  });

  test("a binary that exits nonzero or prints garbage is dropped, not guessed", () => {
    const badExit = join(dir, "bad-exit", "bin");
    fakeBinary(badExit, "opencode v2.0.0", 1);
    const garbage = join(dir, "garbage", "bin");
    fakeBinary(garbage, "sure looks like opencode");
    const hosts = tagBinaries([
      { binDir: badExit, origin: "brew:opencode" },
      { binDir: garbage, origin: "brew:opencode-v2" },
    ]);
    expect(hosts).toEqual([]);
  });

  test("a nonexistent candidate dir is skipped without throwing", () => {
    const hosts = tagBinaries([{ binDir: join(dir, "missing", "bin"), origin: "brew:opencode" }]);
    expect(hosts).toEqual([]);
  });
});
