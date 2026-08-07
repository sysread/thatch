import { $ } from "bun";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * QA runner library. Each use case file imports from here to define its
 * scenario and register its test.
 *
 * Use cases that need a live agent session use the default `runViaOpencode`
 * helper. Automatable use cases override `run` with direct CLI/bun
 * assertions. Manual-only use cases set `manualOnly: true` and are skipped.
 */

const QA_ROOT = "/tmp/thatch-qa";
const REPO_ROOT = join(import.meta.dir, "..", "..");
const MODEL = process.env.QA_MODEL ?? "venice/mistral-small-2603";
const DRY_RUN = process.env.QA_DRY_RUN === "1";

// --- Types ------------------------------------------------------------------

export type UseCaseResult = "PASS" | "FAIL" | "PARTIAL" | "MANUAL-ONLY";

export interface QaContext {
  /** Path to the isolated repo copy for this use case. */
  dir: string;
  /** Env vars to pass to subprocesses (thatch DB, config dirs, etc.). */
  env: Record<string, string>;
  /** The repo root (real repo, read-only). */
  repoRoot: string;
}

export interface UseCase {
  name: string;
  preconditions: string;
  steps: string;
  expected: string;
  /**
   * Custom run function. If omitted, defaults to runViaOpencode.
   * Automatable use cases override this with direct CLI assertions.
   */
  run?: (ctx: QaContext) => Promise<UseCaseResult>;
  /**
   * If true, the test is skipped (compaction, visual TUI, etc.).
   */
  manualOnly?: boolean;
}

// --- Master copy management -------------------------------------------------

let masterReady = false;
// Mutex: the first caller starts setup; concurrent callers await the same
// promise instead of racing into rmSync(QA_ROOT) and clobbering each other.
let masterPromise: Promise<void> | null = null;

export function ensureMaster(): Promise<void> {
  if (masterReady && existsSync(join(QA_ROOT, "master", "src", "index.ts"))) {
    return Promise.resolve();
  }
  if (masterPromise) {
    return masterPromise;
  }
  masterPromise = doEnsureMaster();
  return masterPromise;
}

async function doEnsureMaster(): Promise<void> {

  const masterDir = join(QA_ROOT, "master");

  // Helper: print a step message, run an async fn, then print a checkmark
  // or x on the same line when it completes.
  async function step<T>(msg: string, fn: () => Promise<T>): Promise<T> {
    process.stdout.write(`  [setup] ${msg}...`);
    try {
      const result = await fn();
      console.log(" \u2713");
      return result;
    } catch (err) {
      console.log(" \u2717");
      throw err;
    }
  }

  await step("Cleaning previous QA artifacts", () => {
    rmSync(QA_ROOT, { recursive: true, force: true });
    mkdirSync(masterDir, { recursive: true });
    return Promise.resolve();
  });

  // git archive: tracked files only, no .git, no node_modules.
  await step("Creating master copy via git archive", async () => {
    const archivePath = join(QA_ROOT, "master.tar");
    await $`git archive HEAD -o ${archivePath}`.cwd(REPO_ROOT).quiet();
    await $`tar -xf ${archivePath} -C ${masterDir}`;
    rmSync(archivePath, { force: true });
  });

  // Symlink node_modules from the real repo.
  await step("Symlinking node_modules", async () => {
    const realNodeModules = join(REPO_ROOT, "node_modules");
    if (existsSync(realNodeModules)) {
      await $`ln -s ${realNodeModules} ${join(masterDir, "node_modules")}`;
    }
  });

  // .opencode/skills/ is git-tracked, so git archive already includes it.
  // We only need to create the plugins directory (the skills are already
  // in the archive). The old "copy .opencode" step created a nested
  // .opencode/.opencode/ when the destination already existed from the
  // archive.

  // Write the opencode config with {env:VENICE_API_KEY} (key never on disk).
  await step("Writing opencode config", () => {
    mkdirSync(join(masterDir, ".opencode", "plugins"), { recursive: true });
    writeFileSync(
      join(masterDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        autoupdate: false,
        snapshot: false,
        model: MODEL,
        provider: {
          venice: {
            options: { apiKey: "{env:VENICE_API_KEY}" },
          },
        },
        permission: {
          external_directory: { "/tmp/**": "allow" },
        },
      }, null, 2) + "\n",
    );
    writeFileSync(
      join(masterDir, ".opencode", "plugins", "thatch.ts"),
      'export { server } from "./src/index";\n',
    );
    return Promise.resolve();
  });

  // Pre-initialize opencode config by copying skills and symlinking
  // node_modules from the real opencode config dir. This avoids a slow
  // opencode warm-up run (~30-60s for npm install + LLM call). The thatch
  // plugin's installSkills drift detection will see the skills already
  // present and skip the install. opencode's startup will see node_modules
  // already present and skip npm install.
  //
  // node_modules is symlinked (not copied) to keep the master small —
  // a real copy would make each createFixture cp -r slow and produce
  // macOS xattr errors on thousands of files.
  await step("Initializing opencode config (node_modules, skills from real config)", async () => {
    const masterConfig = join(masterDir, "config");
    const masterOpencodeConfig = join(masterConfig, "opencode");
    mkdirSync(masterOpencodeConfig, { recursive: true });

    const realOpencodeConfig = join(process.env.HOME ?? "", ".config", "opencode");

    // Symlink node_modules and copy package.json from the real opencode config.
    if (existsSync(join(realOpencodeConfig, "node_modules"))) {
      await $`ln -s ${join(realOpencodeConfig, "node_modules")} ${join(masterOpencodeConfig, "node_modules")}`;
      await $`cp ${join(realOpencodeConfig, "package.json")} ${join(masterOpencodeConfig, "package.json")}`;
    }

    // Copy skills from the real opencode config. The thatch plugin already
    // installed these there (21 shared + 1 opencode-only = 22 skills).
    // The plugin's drift detection compares on-disk content to the artifact
    // definitions; if they match, the install is a no-op.
    if (existsSync(join(realOpencodeConfig, "skills"))) {
      await $`cp -r ${join(realOpencodeConfig, "skills")} ${join(masterOpencodeConfig, "skills")}`;
    }
  });

  masterReady = true;
  console.log(`  [setup] Master copy ready (model: ${MODEL}) \u2713`);
  console.log("");
  console.log("  Running use cases (live sessions may take several minutes each)...");
  console.log("");
}

// --- Per-use-case fixture ---------------------------------------------------

export async function createFixture(name: string): Promise<QaContext> {
  const masterDir = join(QA_ROOT, "master");
  const dir = join(QA_ROOT, name);
  // Use .nothrow() because macOS cp produces non-fatal xattr warnings that
  // still set exit code 1. Check the destination exists instead.
  await $`cp -r ${masterDir} ${dir}`.nothrow();
  if (!existsSync(join(dir, "src", "index.ts"))) {
    throw new Error(`createFixture: cp -r failed — ${dir}/src/index.ts missing`);
  }

  // The master already has config/ and home/ from the warm-up run.
  // Just ensure the remaining per-UC dirs exist.
  for (const sub of ["claude", "queue"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  return {
    dir,
    repoRoot: REPO_ROOT,
    env: {
      THATCH_DB_PATH: join(dir, "thatch.db"),
      THATCH_QUEUE_DIR: join(dir, "queue"),
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      XDG_CONFIG_HOME: join(dir, "config"),
      HOME: join(dir, "home"),
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      VENICE_API_KEY: process.env.VENICE_API_KEY ?? "",
      PATH: process.env.PATH ?? "",
    },
  };
}

// --- Default run: shell out to opencode ------------------------------------

/**
 * Default run method. Spawns `opencode run` with the use case content as
 * the prompt, then parses the result from the output.
 */
export async function runViaOpencode(uc: UseCase, ctx: QaContext): Promise<UseCaseResult> {
  const prompt = `Load the thatch-qa skill. Then execute this use case and report results:

# ${uc.name}

## Preconditions
${uc.preconditions}

## Steps
${uc.steps}

## Expected
${uc.expected}

Report your result in this format:
UC-NNN: <title>
Result: PASS | FAIL | PARTIAL | MANUAL-ONLY
Evidence:
  - What was run
  - What was observed
  - What matched or didn't match the expected outcome`;

  // Race the opencode session against a timeout. If it wins, kill the
  // spawned process so we don't leave orphaned opencode sessions after
  // bun abandons the test. The test-level timeout (600s) fires first;
  // this is a backstop that also cleans up the process.
  const timeoutMs = 590_000; // 9 min 50s — just under the 10-min test timeout

  const proc = Bun.spawn(["opencode", "run", "--dir", ctx.dir, "--model", MODEL, "--auto", prompt], {
    env: ctx.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    try { proc.kill("SIGTERM"); } catch { /* already dead */ }
  }, timeoutMs);

  try {
    const [, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const output = stdout + stderr;
    const match = output.match(/^Result:\s*(PASS|FAIL|PARTIAL|MANUAL-ONLY)/m);
    const status = match ? match[1] as UseCaseResult : "FAIL";

    if (status === "FAIL") {
      console.log(`  ${uc.name}: FAIL\n  Output: ${output.slice(0, 500)}`);
    }

    return status;
  } catch (err) {
    console.log(`  ${uc.name}: FAIL (opencode session error: ${err})`);
    return "FAIL";
  } finally {
    clearTimeout(timer);
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

// --- Test registration ------------------------------------------------------

import { test } from "bun:test";

/**
 * Register a use case as a concurrent bun test. Handles dry-run skipping,
 * manual-only marking, fixture setup, and result assertion.
 */
export function registerUseCase(uc: UseCase): void {
  test.concurrent(uc.name, async () => {
    if (DRY_RUN) {
      console.log(`  [DRY RUN] ${uc.name} — skipped`);
      return;
    }

    if (uc.manualOnly) {
      console.log(`  [MANUAL] ${uc.name} — skipped`);
      return;
    }

    await ensureMaster();
    const ctx = await createFixture(uc.name);
    const runFn = uc.run ?? ((c: QaContext) => runViaOpencode(uc, c));
    const result = await runFn(ctx);

    console.log(`  ${uc.name}: ${result}`);

    if (result === "FAIL" || result === "PARTIAL") {
      throw new Error(`${uc.name}: ${result}`);
    }
  }, { timeout: 600_000 }); // 10 min per use case
}

// --- Pre-flight check ------------------------------------------------------

/**
 * Call in beforeAll to verify the environment. Only warns — automatable
 * use cases with custom run functions don't need VENICE_API_KEY, so we
 * don't hard-fail. Tests that call runViaOpencode will fail on their own
 * if the key is missing.
 */
export function checkEnv(): void {
  if (!DRY_RUN && !process.env.VENICE_API_KEY) {
    console.warn("warning: VENICE_API_KEY is not set — opencode-based use cases will fail");
  }
}

// --- Cleanup info ----------------------------------------------------------

export function printCleanupNotice(): void {
  if (!DRY_RUN) {
    console.log(`\nQA artifacts left in ${QA_ROOT}`);
    console.log(`Remove with: rm -rf ${QA_ROOT}`);
  }
}
