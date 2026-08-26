import { $ } from "bun";
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * QA runner library. Each use case file imports from here to define its
 * scenario and register its test.
 *
 * Use cases that need a live agent session use the default `runViaOpencode`
 * helper. Automatable use cases override `run` with direct CLI/bun
 * assertions. Manual-only use cases set `manualOnly: true` and are skipped.
 */

// Master copy lives outside /tmp/ so opencode sessions (which have
// external_directory "/tmp/**": "allow" in the master config) cannot
// delete or corrupt it. Fixtures live under /tmp/thatch-qa/ for
// compatibility with bun test --concurrent (os.tmpdir() paths caused
// unexplained hangs).
const MASTER_ROOT = join(tmpdir(), "thatch-qa-master");
const QA_ROOT = "/tmp/thatch-qa";
const REPO_ROOT = join(import.meta.dir, "..", "..");
const MODEL = process.env.QA_MODEL ?? "venice/zai-org-glm-5-2";
const DRY_RUN = process.env.QA_DRY_RUN === "1";

// --- Types ------------------------------------------------------------------

export type UseCaseResult = "PASS" | "FAIL" | "PARTIAL" | "MANUAL-ONLY" | "DOCS_MISMATCH";

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
   * Path to a user doc (relative to repo root) that describes the
   * feature being tested. When set, runViaOpencode includes the
   * doc content in the prompt so the agent can compare observed
   * behavior against the documented spec.
   */
  userDoc?: string;
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
  if (masterReady && existsSync(join(MASTER_ROOT, "src", "index.ts"))) {
    return Promise.resolve();
  }
  if (masterPromise) {
    return masterPromise;
  }
  masterPromise = doEnsureMaster();
  return masterPromise;
}

async function doEnsureMaster(): Promise<void> {

  const masterDir = MASTER_ROOT;

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
    rmSync(MASTER_ROOT, { recursive: true, force: true });
    mkdirSync(masterDir, { recursive: true });
    mkdirSync(QA_ROOT, { recursive: true });
    return Promise.resolve();
  });

  // git archive: tracked files only, no .git, no node_modules.
  await step("Creating master copy via git archive", async () => {
    const archivePath = join(MASTER_ROOT, "master.tar");
    await $`git archive HEAD -o ${archivePath}`.cwd(REPO_ROOT).quiet();
    await $`tar -xf ${archivePath} -C ${masterDir}`;
    rmSync(archivePath, { force: true });
  });

  // Symlink node_modules from the real repo.
  await step("Symlinking node_modules", () => {
    const realNodeModules = join(REPO_ROOT, "node_modules");
    if (existsSync(realNodeModules)) {
      symlinkSync(realNodeModules, join(masterDir, "node_modules"));
    }
    return Promise.resolve();
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
      symlinkSync(join(realOpencodeConfig, "node_modules"), join(masterOpencodeConfig, "node_modules"));
      copyFileSync(join(realOpencodeConfig, "package.json"), join(masterOpencodeConfig, "package.json"));
    }

    // Copy skills from the real opencode config. The thatch plugin already
    // installed these there (25 shared + 1 opencode-only = 26 skills).
    // The plugin's drift detection compares on-disk content to the artifact
    // definitions; if they match, the install is a no-op.
    if (existsSync(join(realOpencodeConfig, "skills"))) {
      cpSync(join(realOpencodeConfig, "skills"), join(masterOpencodeConfig, "skills"), { recursive: true });
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
  const masterDir = MASTER_ROOT;
  const dir = join(QA_ROOT, name);
  // fs.cpSync with recursive:true copies directories, preserving symlinks
  // by default (dereference: false). The master's node_modules symlink
  // stays a symlink instead of copying thousands of real files.
  // OS-agnostic, no BSD/GNU cp flag differences.
  cpSync(masterDir, dir, { recursive: true });
  if (!existsSync(join(dir, "src", "index.ts"))) {
    throw new Error(`createFixture: cpSync failed — ${dir}/src/index.ts missing`);
  }

  // Write a per-fixture opencode.json that scopes external_directory
  // permission to ONLY this fixture's directory. The master's opencode.json
  // has "/tmp/**": "allow" which lets a confused model in one session
  // delete files from other fixtures or the master. Narrowing to the
  // fixture's own path prevents cross-fixture damage.
  //
  // Deny rules take precedence over allow rules and over --auto. By
  // denying "/tmp/**" but allowing the fixture's own dir, a confused
  // model cannot rm -rf sibling fixtures or the master copy.
  writeFileSync(
    join(dir, "opencode.json"),
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
        external_directory: {
          [`${dir}/**`]: "allow",
        },
      },
    }, null, 2) + "\n",
  );

  // Ensure the per-UC dirs exist. These provide isolated XDG paths for
  // opencode: data (session DB), state (lock files), cache, and config.
  // Without these, opencode may fall back to shared global paths, causing
  // "Session not found" errors when multiple sessions run concurrently.
  for (const sub of [
    "claude", "queue",
    "home", "home/.local", "home/.local/share", "home/.local/state", "home/.cache",
  ]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  // Initialize a git repo in the fixture so live use cases that need
  // git context (branch, diff, commit, PR) have one. git archive HEAD
  // produces a snapshot with no .git directory; git init restores it.
  await $`git init`.cwd(dir).quiet().nothrow();
  await $`git add -A`.cwd(dir).quiet().nothrow();
  await $`git commit -m "QA fixture for ${name}"`.cwd(dir).quiet().nothrow();

  return {
    dir,
    repoRoot: REPO_ROOT,
    env: {
      THATCH_DB_PATH: join(dir, "thatch.db"),
      THATCH_QUEUE_DIR: join(dir, "queue"),
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "home", ".local", "share"),
      XDG_STATE_HOME: join(dir, "home", ".local", "state"),
      XDG_CACHE_HOME: join(dir, "home", ".cache"),
      HOME: join(dir, "home"),
      OPENCODE_TEST_HOME: join(dir, "home"),
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
  // Read the user doc (if set) and include it in the prompt so the
  // agent can compare observed behavior against the documented spec.
  let userDocSection = "";
  if (uc.userDoc) {
    const docPath = join(REPO_ROOT, uc.userDoc);
    if (existsSync(docPath)) {
      userDocSection = `\n## User doc (${uc.userDoc})\n\n${await Bun.file(docPath).text()}\n\nCompare your observations against this doc. If the behavior you observe contradicts what the doc says, report Result: DOCS_MISMATCH with evidence.\n`;
    }
  }

  const prompt = `Load the thatch-qa skill. Then execute this use case and report results:

# ${uc.name}

## Preconditions
${uc.preconditions}

## Steps
${uc.steps}

## Expected
${uc.expected}${userDocSection}
Report your result in this format:
UC-NNN: <title>
Result: PASS | FAIL | PARTIAL | MANUAL-ONLY | DOCS_MISMATCH
Evidence:
  - What was run
  - What was observed
  - What matched or didn't match the expected outcome`;

  // Race the opencode session against a timeout. If it wins, kill the
  // spawned process so we don't leave orphaned opencode sessions after
  // bun abandons the test. The test-level timeout (1200s) fires first;
  // this is a backstop that also cleans up the process.
  const timeoutMs = 1_190_000; // 19 min 50s — just under the 20-min test timeout

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
    const match = output.match(/^Result:\s*(PASS|FAIL|PARTIAL|MANUAL-ONLY|DOCS_MISMATCH)/m);
    const status = match ? match[1] as UseCaseResult : "FAIL";

    if (status !== "PASS") {
      console.log(`  ${uc.name}: ${status}\n  Output: ${output.slice(0, 2000)}`);
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

    // Live use cases (no custom run) need the opencode binary on PATH.
    // Skip if it's not available instead of hard-failing with ENOENT.
    if (!uc.run && !DRY_RUN) {
      const check = await $`command -v opencode`.quiet().nothrow();
      if (check.exitCode !== 0) {
        console.log(`  [MANUAL] ${uc.name} — skipped (opencode not on PATH)`);
        return;
      }
    }

    await ensureMaster();
    const ctx = await createFixture(uc.name);
    const runFn = uc.run ?? ((c: QaContext) => runViaOpencode(uc, c));
    const result = await runFn(ctx);

    console.log(`  ${uc.name}: ${result}`);

    if (result === "FAIL" || result === "PARTIAL") {
      throw new Error(`${uc.name}: ${result}`);
    }
  }, { timeout: 1_200_000 }); // 20 min per use case (live sessions need model + tool latency)
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
    console.log(`\nQA artifacts left in ${QA_ROOT} and ${MASTER_ROOT}`);
    console.log(`Remove with: rm -rf ${QA_ROOT}`);
  }
}
