import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ThatchDB } from "../../../../src/db";

/**
 * Shared harness for the CLAUDE leg: spawns real `claude -p` sessions with
 * the thatch plugin loaded (--plugin-dir; plugins already installed also
 * load in -p mode, but --plugin-dir needs no install step) and hands the
 * use case the assertion surfaces.
 *
 * THE LEG INVARIANT: assertions read ONLY surfaces the plugin writes -
 * the thatch db, the extraction queue dir, the debug log, and files under
 * the plugin tree - NEVER the model's prose. A session's stdout is
 * echo-only here (failure triage), never a verdict input.
 *
 * PREREQUISITE: the host's claude CLI, installed and logged in (no token
 * plumbing - this leg is host-run-only by design).
 */

export interface ClaudeLegCtx {
  dir: string;
  /** The fixture root every surface hangs off. */
  base: string;
  pluginDir: string;
  dbPath: string;
  queueDir: string;
  debugLog: string;
  env: Record<string, string>;
  db: ThatchDB;
}

export interface ClaudeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one claude -p session against the plugin. cwd is the isolated repo
 * copy (the runner's ctx.dir), so project-scope surfaces resolve there.
 */
export async function runClaude(ctx: ClaudeLegCtx, prompt: string, timeoutMs = 240000): Promise<ClaudeRunResult> {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--plugin-dir", ctx.pluginDir, "--max-turns", "8"],
    {
      cwd: ctx.dir,
      env: ctx.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);
  return { exitCode: proc.exitCode ?? 1, stdout, stderr };
}

/** Builds the isolated environment for one use case: a temp HOME,
 *  CLAUDE_CONFIG_DIR, thatch db + queue dir, and the plugin dir generated
 *  by the REAL setup command (the QA target is the generated artifact). */
export async function makeClaudeCtx(base: string): Promise<ClaudeLegCtx> {
  const dir = join(base, "repo");
  const home = join(base, "home");
  const configDir = join(home, ".claude");
  const dbPath = join(base, "thatch.db");
  const queueDir = join(base, "queue");
  const debugLog = join(base, "debug.log");
  mkdirSync(dir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(queueDir, { recursive: true });
  const bin = join(import.meta.dir, "..", "..", "..", "..", "bin", "thatch");
  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    THATCH_DB_PATH: dbPath,
    THATCH_QUEUE_DIR: queueDir,
    THATCH_DEBUG: "1",
    THATCH_MODEL: "mock",
  } as Record<string, string>;

  // Generate the plugin via the real setup (the thing under test), global
  // scope so --plugin-dir resolves inside the fixture home.
  const setup = Bun.spawnSync(["bun", bin, "setup", "--claude", "--plugin", "--global"], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (setup.exitCode !== 0) {
    throw new Error(`plugin-regime setup failed: ${setup.stderr.toString().slice(0, 400)}`);
  }
  const pluginDir = join(configDir, "thatch-plugin");
  if (!existsSync(join(pluginDir, "hooks", "mod.js"))) {
    throw new Error(`the generated plugin lacks a mod bundle at ${pluginDir}`);
  }

  const db = new ThatchDB(dbPath, { chatOpenTabs: () => new Set() });
  return { dir, base, pluginDir, dbPath, queueDir, debugLog, env, db };
}

/** The debug log's text (empty when the plugin never wrote it). */
export function readDebugLog(ctx: ClaudeLegCtx): string {
  const candidates = [join(ctx.base, "debug.log"), join(ctx.base, "thatch-debug.log")];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, "utf8");
  }
  return "";
}

export const TMP_BASE = () => join(tmpdir(), `thatch-claude-leg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
