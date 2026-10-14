// Preload script: strip OPENCODE_* env vars so tests run against a clean
// baseline. opencode injects these into the parent process, so without this
// tests that branch on env vars (e.g. OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS)
// pass locally but fail in CI where the vars are absent.
//
// Individual tests that need a specific value set it explicitly and clean up
// in their body. This preload only handles the default: nothing set.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("OPENCODE_")) delete process.env[key];
}

// Defensive path isolation, observed-live-fire 2026-10-14: a hand-rolled test
// harness booted the plugin server without THATCH_DB_PATH/XDG_CONFIG_HOME, the
// server opened the developer's REAL ~/.config/thatch/thatch.db, and its boot
// sweeps deleted real runtime_state rows. Tests that boot the server or open
// ThatchDB without setting these vars must land in a sandbox, not on live
// state - so default them into a throwaway per-process dir. A test that needs
// shared fixtures creates its own and sets the vars explicitly (save and
// RESTORE the prior value, never just delete: bun shares one process across
// all test files).
const sandbox = mkdtempSync(join(tmpdir(), "thatch-test-env-"));
const defaults: Record<string, string> = {
  THATCH_DB_PATH: join(sandbox, "thatch.db"),
  XDG_CONFIG_HOME: join(sandbox, "config"),
  XDG_DATA_HOME: join(sandbox, "data"),
};
// Pre-create only the DIRECTORY vars. THATCH_DB_PATH must NOT be mkdir'd:
// the value is a file path, and a directory of that name turns the first
// db open into SQLITE_CANTOPEN.
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
  if (!process.env[key]) mkdirSync(defaults[key], { recursive: true });
}
for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
