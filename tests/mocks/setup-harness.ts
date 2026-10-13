/**
 * Shared fixture harness for the four setup test parts (setup-claude,
 * setup-cursor, setup-skills, setup-prompts). Every part calls
 * installSetupHarness() at file top level so all of its tests run under the
 * same per-test fixture lifecycle: a fresh project tmp dir and a fake HOME,
 * plus save/restore of every env var the setup code reads or writes.
 *
 * projectDir and fakeHome are live ESM bindings: installSetupHarness()'s
 * beforeEach reassigns them per test, and importing test files always read
 * the current test's value. Never capture them at import time.
 */

import { beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export let projectDir: string;
export let fakeHome: string;

let originalHome: string | undefined;
let originalConfigDir: string | undefined;
let originalCursorConfigDir: string | undefined;
let originalClaudeProjectDir: string | undefined;
let originalCursorProjectDir: string | undefined;

export function installSetupHarness(): void {
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "thatch-setup-project-"));
    fakeHome = mkdtempSync(join(tmpdir(), "thatch-setup-home-"));
    originalHome = process.env.HOME;
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    originalCursorConfigDir = process.env.CURSOR_CONFIG_DIR;
    originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    originalCursorProjectDir = process.env.CURSOR_PROJECT_DIR;
    process.env.HOME = fakeHome;
    // Clear XDG and config dir overrides so each test starts at defaults.
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CURSOR_CONFIG_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CURSOR_PROJECT_DIR;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    if (originalCursorConfigDir === undefined) {
      delete process.env.CURSOR_CONFIG_DIR;
    } else {
      process.env.CURSOR_CONFIG_DIR = originalCursorConfigDir;
    }
    if (originalClaudeProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir;
    }
    if (originalCursorProjectDir === undefined) {
      delete process.env.CURSOR_PROJECT_DIR;
    } else {
      process.env.CURSOR_PROJECT_DIR = originalCursorProjectDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });
}
