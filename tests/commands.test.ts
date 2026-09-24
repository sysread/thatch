import { describe, test, expect } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installOpencodeCommands, opencodeActionCommandDefs, removeWrapUpCommandFiles } from "../src/commands";

// The v1 -> v2 upgrade path: v1 installs wrap-up command FILES; v2
// registers the wrap-ups in code and installs only the action files. The
// stale files must be removed (a file and a registered command with the
// same name collide), and the removal must tolerate a missing dir.

function fakeConfigHome(): string {
  const home = mkdtempSync(join(tmpdir(), "thatch-cmds-"));
  return home;
}

describe("removeWrapUpCommandFiles", () => {
  test("removes wrap-up files written by a v1-style install, keeps action files", () => {
    const configHome = fakeConfigHome();
    installOpencodeCommands(configHome); // full set: actions + wrap-ups
    const dir = join(configHome, "opencode", "command", "thatch");
    expect(existsSync(join(dir, "compact.md"))).toBe(true);
    expect(existsSync(join(dir, "exit.md"))).toBe(true);

    removeWrapUpCommandFiles(configHome);
    expect(existsSync(join(dir, "compact.md"))).toBe(false);
    expect(existsSync(join(dir, "exit.md"))).toBe(false);
    // Action files (installed when a defs set is passed) survive.
    installOpencodeCommands(configHome, opencodeActionCommandDefs());
    removeWrapUpCommandFiles(configHome);
    const remaining = opencodeActionCommandDefs().map((d) => existsSync(join(dir, `${d.name}.md`)));
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.every(Boolean)).toBe(true);
  });

  test("is idempotent and tolerates a missing directory", () => {
    const configHome = fakeConfigHome();
    removeWrapUpCommandFiles(configHome);
    removeWrapUpCommandFiles(configHome);
    // A malformed entry (a directory where a file should be) must not throw.
    const dir = join(configHome, "opencode", "command", "thatch");
    mkdirSync(join(dir, "compact.md"), { recursive: true });
    expect(() => removeWrapUpCommandFiles(configHome)).not.toThrow();
  });

  test("the v2 action set itself never contains the wrap-up names", () => {
    // Guard the invariant the removal exists to protect: registering
    // thatch/compact in code while compact.md is on disk is the collision.
    const names = opencodeActionCommandDefs().map((d) => d.name);
    expect(names).not.toContain("compact");
    expect(names).not.toContain("exit");
  });
});
