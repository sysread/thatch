import { $ } from "bun";
import { appendFileSync, cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

// Run-scoped roots. The run id keeps concurrent qa-auto PROCESSES (two
// worktrees gating at once, CI plus a local run) from destroying each
// other: the old shared /tmp/thatch-qa + thatch-qa-master roots meant the
// second process's master setup (rmSync of both roots) deleted the first
// process's LIVE fixtures mid-test. Reproduced 2026-11-05 by overlapping
// two qa-run invocations: UC-131's CLI died with "SQLiteError: disk I/O
// error" (the db file unlinked under it) - the same signature seen in
// that week's UC-100 flakes, and the empty-CLI-output shape that hit
// UC-132/130. Fixtures stay under /tmp/thatch-qa/ for compatibility with
// bun test --concurrent (os.tmpdir() paths caused unexplained hangs);
// the master copy stays outside /tmp/ so opencode sessions (which have
// external_directory "/tmp/**": "allow" in the master config) cannot
// delete or corrupt it.
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`;
const MASTER_ROOT = join(tmpdir(), `thatch-qa-master-${RUN_ID}`);
export const QA_ROOT = join("/tmp", "thatch-qa", RUN_ID);
const QA_ROOT_PARENT = "/tmp/thatch-qa";
// Per-UC result journal: one JSONL line per use-case completion (name, leg,
// verdict, timestamp, plus the failure output head on non-PASS). Written
// because a mid-stream failure is otherwise unidentifiable: results live
// only in stdout, and a truncated capture (the 2026-11-05 flake chase)
// loses the failing UC's name while fixture dirs carry no failure markers.
// Lives in the run-scoped root, so it dies with the run's cleanup and
// never accumulates across runs.
export const RESULT_JOURNAL = join(QA_ROOT, "results.jsonl");

export function journalResult(line: {
  uc: string;
  leg?: string | null;
  result: string;
  output?: string;
}): void {
  try {
    mkdirSync(QA_ROOT, { recursive: true });
    appendFileSync(
      RESULT_JOURNAL,
      JSON.stringify({ at: new Date().toISOString(), ...line, ...(line.output ? { output: line.output.slice(0, 2000) } : {}) }) + "\n",
    );
  } catch {
    // The journal is evidence, not a gate: a write failure must never fail
    // a use case.
  }
}

/**
 * Runs a use-case body, journaling a THREW line (with the error head) if
 * it throws, then rethrowing. The crash path is the journal's most
 * important case: a timed-out or crashed UC leaves no completion-path
 * write, so without this guard the failing name exists only in stdout -
 * one truncated capture away from being lost.
 */
export async function journalGuarded<T>(meta: { uc: string; leg?: string | null }, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const head = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    journalResult({ ...meta, result: "THREW", output: head });
    throw err;
  }
}
const REPO_ROOT = join(import.meta.dir, "..", "..");
export const MODEL = process.env.QA_MODEL ?? "venice/z-ai-glm-5-3-flash";
const DRY_RUN = process.env.QA_DRY_RUN === "1";

// --- Types ------------------------------------------------------------------

export type UseCaseResult = "PASS" | "FAIL" | "PARTIAL" | "MANUAL-ONLY" | "DOCS_MISMATCH";

/**
 * The agent's verdict: the LAST "Result:" LINE in its output. Anchored to
 * line start (with leading markdown emphasis tolerated - models like to
 * bold the report, "**Result: PASS**") so quoted prose can never decide
 * the verdict: an Evidence line like `quoted "Result: PASS | FAIL"` sits
 * mid-line and no longer overrides a real FAIL verdict below it. Echoing
 * the format spec on a line of its own can still match - the last match
 * wins, and the report's verdict line is the last one by construction.
 * Null when the agent never produced a verdict line.
 */
export function parseQaVerdict(output: string): UseCaseResult | null {
  const verdictMatches = [...output.matchAll(/^[ \t]*\**[ \t]*Result:[ \t]*(PASS|FAIL|PARTIAL|MANUAL-ONLY|DOCS_MISMATCH)\b/gm)];
  return verdictMatches.length
    ? verdictMatches[verdictMatches.length - 1][1] as UseCaseResult
    : null;
}

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
   * True when a custom `run` function spawns the opencode binary itself
   * (a serve process, an `opencode run` invocation) - the runner then
   * resolves the opencode binary the same way it does for live use cases.
   * Use cases with no custom run always spawn opencode and need not set
   * this.
   */
  spawnsOpencode?: boolean;
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
    gcStaleRunRoots();
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
      // Absolute path: relative imports in a plugin file resolve from the
      // plugin file's own directory (.opencode/plugins/), not the project
      // root, so "./src/index" never loads - the plugin silently fails to
      // import and every in-session thatch tool/poller is missing. Same
      // pattern as the real global config's plugin file.
      //
      // FILE shape on purpose, though real installs should use the
      // directory form (see docs/user/setup.md): the QA suite is headless
      // - no TUI process ever loads the ./tui entrypoint - so the
      // directory form buys QA nothing, and the file shape keeps the
      // fixture's plugin out of v2's directory auto-discovery (a directory
      // shim plus this file would die on "duplicate instance plugin ids").
      // TUI-side loading is verified by the live smoke, not here.
      `export { default } from ${JSON.stringify(join(masterDir, "src", "index"))};\n`,
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
    // installed these there (the full set: SHARED_SKILLS + 1 opencode-only).
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

/**
 * Reclaims run roots left by DEAD qa-auto processes. Every process gets its
 * own root (the run id), so cleanup must never touch a sibling run's root -
 * that deletion was the concurrent-run fixture wipe. Age is the liveness
 * test instead of pids (a pid can be reused): no qa-auto run survives 24h,
 * since each use case is capped at 20 minutes. Best-effort: a failed GC
 * only leaves files behind.
 */
function gcStaleRunRoots(): void {
  const staleMs = 24 * 60 * 60 * 1000;
  const candidates: string[] = [];
  try {
    for (const entry of readdirSync(QA_ROOT_PARENT)) {
      candidates.push(join(QA_ROOT_PARENT, entry));
    }
    for (const entry of readdirSync(tmpdir())) {
      // "thatch-qa-master" (no suffix) is the legacy shared-root name from
      // before the run-scoped fix - reclaim it too.
      if (entry === "thatch-qa-master" || entry.startsWith("thatch-qa-master-")) candidates.push(join(tmpdir(), entry));
    }
  } catch {
    return; // a missing parent means nothing to reclaim
  }
  for (const candidate of candidates) {
    try {
      if (candidate === QA_ROOT || candidate === MASTER_ROOT) continue;
      if (Date.now() - statSync(candidate).mtimeMs > staleMs) {
        rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // Somebody else is mid-setup on their own root; leave it alone.
    }
  }
}

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

  // Remove the copied mise.toml: it serves nothing here (the runner passes
  // env explicitly; no mise task ever runs via real mise inside a fixture)
  // and modern mise fail-closes on UNTRUSTED config files - every fixture
  // lives in a fresh tmpdir, so the copied mise.toml is always untrusted,
  // and every mise-shimmed node/bun invocation inside the fixture (bin/release's
  // `node -p`, etc.) dies on the trust check before doing anything.
  rmSync(join(dir, "mise.toml"));

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
  // A fake origin remote: the plugin resolves the store as owner/repo from
  // the git remote ONCE at session startup, so use cases asserting repo-
  // scoped stores (UC-001's "not in global") need the remote to exist
  // before the session starts - an agent adding one mid-session is too
  // late, and the fallback store is the directory basename.
  await $`git remote add origin https://github.com/test-org/test-repo.git`.cwd(dir).quiet().nothrow();

  return {
    dir,
    repoRoot: REPO_ROOT,
    env: {
      THATCH_DB_PATH: join(dir, "thatch.db"),
      THATCH_QUEUE_DIR: join(dir, "queue"),
      // Machine-level dispatch suppression for the fixture's subprocesses
      // (opencode run/serve children included): a runtime path that reaches
      // the real notify dispatcher must not banner or speak on the host
      // mid-QA-run. The temp-HOME/XDG sandboxing cannot contain osascript,
      // so the dispatcher-level kill switch is the containment.
      THATCH_NO_NOTIFY: "1",
      // Full plugin debug log into the fixture (debug.log beside the db):
      // the serve process's stdout/stderr pipes are never drained, so this
      // is the only window into plugin-side failures during a run.
      THATCH_DEBUG: "1",
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "home", ".local", "share"),
      XDG_STATE_HOME: join(dir, "home", ".local", "state"),
      XDG_CACHE_HOME: join(dir, "home", ".cache"),
      HOME: join(dir, "home"),
      OPENCODE_TEST_HOME: join(dir, "home"),
      // v2 still honors this one (server-process.ts). The v1-only pair
      // _EXTERNAL_SKILLS / _DEFAULT_PLUGINS was removed: v2 dropped both
      // flags, and the isolation they provided on v1 is structural here -
      // the fixture-scoped HOME/XDG dirs above are the only skills/plugins
      // source v2 discovery sees (v2's default plugins are compiled-in
      // built-ins no env var disables; coexisting with them is the
      // realistic coverage).
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      // opencode v2's serve always runs password-protected (random when
      // unset); a fixed one lets the runner's client authenticate. v1
      // ignores both the env var and the header.
      OPENCODE_SERVER_PASSWORD: SERVE_PASSWORD,
      VENICE_API_KEY: process.env.VENICE_API_KEY ?? "",
      PATH: process.env.PATH ?? "",
    },
  };
}

// --- Default run: shell out to opencode ------------------------------------

/**
 * Builds the `opencode run` invocation for the host binary that ctx.env's
 * PATH selects. `--standalone` is required because the default run waits
 * on the shared background daemon, which an isolated fixture sandbox must
 * not boot or reuse. `--model`/`--auto` pass through.
 *
 * QA_DOCKER=1 runs the same invocation inside the qa/opencode-sandbox
 * container instead of the host binary: the fixture dir and the master copy
 * mount at their HOST paths (the fixture env's absolute XDG paths stay
 * valid in-container), and every ctx.env var is passed explicitly - a
 * container has exactly the env it is given, which is the isolation point
 * (a direnv'd host shell must not leak OPENCODE_CONFIG or keys into the
 * spawned session). The master's node_modules symlink target mounts too so
 * the shim's import chain resolves. The image builds on first use.
 */
export function opencodeRunArgs(ctx: QaContext, prompt: string): { args: string[]; cwd: string } {
  // Exact "1": QA_DOCKER=0 must disable, not enable (a bare truthy check
  // would read the string "0" as on).
  const docker = process.env.QA_DOCKER === "1";
  const args = ["opencode", "run", "--standalone", "--model", MODEL, "--auto", prompt];
  if (!docker) return { args, cwd: ctx.dir };
  ensureQaDockerImage();
  const mounts = [ctx.dir, MASTER_ROOT];
  const realNodeModules = join(process.env.HOME ?? "", ".config", "opencode", "node_modules");
  if (existsSync(realNodeModules)) mounts.push(realNodeModules);
  const dockerArgs = ["docker", "run", "--rm"];
  // The container's cwd = the fixture dir: v2 resolves the project (skills,
  // git identity) from the working directory, and the fixture carries both
  // (its own .opencode/skills from the archive + the runner's git init with
  // a fake origin).
  dockerArgs.push("-w", ctx.dir);
  // The checkout at /app/thatch: the entrypoint's fixture setup reads it
  // (package.json, the shim's import target).
  dockerArgs.push("-v", `${REPO_ROOT}:/app/thatch`);
  for (const dir of mounts) dockerArgs.push("-v", `${dir}:${dir}`);
  for (const [key, value] of Object.entries(ctx.env)) {
    // PATH stays the image's: the host PATH's directories do not exist
    // in-container, and overriding it hides the image's opencode binary.
    // HOME passes through (the fixture home is mounted at the same path,
    // and the image's binary paths are absolute).
    if (key === "PATH") continue;
    dockerArgs.push("-e", `${key}=${value}`);
  }
  // The entrypoint execs `opencode` itself - the host argv's leading binary
  // name would arrive as an unknown subcommand and print the root help.
  dockerArgs.push(QA_DOCKER_IMAGE, ...args.slice(1));
  return { args: dockerArgs, cwd: ctx.dir };
}

const QA_DOCKER_IMAGE = "thatch-qa-opencode";
let qaDockerImageEnsured = false;

/** Builds the qa/opencode-sandbox image once per process if it is absent. */
function ensureQaDockerImage(): void {
  if (qaDockerImageEnsured) return;
  const inspect = Bun.spawnSync(["docker", "image", "inspect", QA_DOCKER_IMAGE], { stdout: "ignore", stderr: "ignore" });
  if (inspect.exitCode !== 0) {
    console.log("  [qa-docker] building the sandbox image (once per tree)...");
    const build = Bun.spawnSync(["docker", "build", "-t", QA_DOCKER_IMAGE, join(REPO_ROOT, "qa", "opencode-sandbox")], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (build.exitCode !== 0) throw new Error("qa-docker: sandbox image build failed");
  }
  qaDockerImageEnsured = true;
}

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

  const prompt = `Load the qa skill. Then execute this use case and report results:

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

  const { args, cwd } = opencodeRunArgs(ctx, prompt);
  const proc = spawnWatched(args, {
    cwd,
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
    const status = parseQaVerdict(output) ?? "FAIL";

    if (status !== "PASS") {
      console.log(`  ${uc.name}: ${status}\n  Output: ${output.slice(0, 2000)}`);
      // The evidence line: registerLeg's result line names the failure,
      // this one carries the session output that explains it.
      journalResult({ uc: uc.name, result: `output:${status}`, output });
    }

    return status;
  } catch (err) {
    console.log(`  ${uc.name}: FAIL (opencode session error: ${err})`);
    journalResult({ uc: uc.name, result: "output:FAIL", output: `opencode session error: ${err}` });
    return "FAIL";
  } finally {
    clearTimeout(timer);
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

// --- Test registration ------------------------------------------------------

import { test } from "bun:test";

/**
 * One registration leg: the test to register and, when a discovered v2
 * binary exists, its binDir prepended to the fixture PATH so `opencode`
 * resolves to that install.
 */
interface MatrixLeg {
  binDir?: string;
}

/**
 * The registration leg for one use case. Opencode-driven use cases (live
 * default-run ones, and automatable ones whose run spawns the binary -
 * UC-100 spawns `opencode serve`, UC-098 spawns run) resolve the opencode
 * binary: a discovered v2 install wins (its binDir is prepended to the
 * fixture PATH); with none discovered the PATH binary is used as-is.
 * Automatable use cases that never touch opencode keep a single leg.
 */
function matrixLegs(uc: UseCase): MatrixLeg[] {
  if (process.env.QA_DOCKER === "1") {
    // The docker image pins opencode v2, so host-binary discovery does not
    // apply: the single leg runs through the container.
    return [{}];
  }
  const spawnsOpencode = !uc.run || uc.spawnsOpencode === true;
  if (!spawnsOpencode) return [{}];
  // The plugin requires opencode 2: a discovered v1 binary is an unusable
  // host, never selected - only the v2 tag is.
  const v2 = discoverHostBinaries().find((h) => h.tag === "v2");
  return [{ binDir: v2?.binDir }];
}

/**
 * Register a use case as a concurrent bun test. Handles dry-run skipping,
 * manual-only marking, fixture setup, and result assertion.
 */
export function registerUseCase(uc: UseCase): void {
  for (const leg of matrixLegs(uc)) registerLeg(uc, leg);
}

function registerLeg(uc: UseCase, leg: MatrixLeg): void {
  const testName = uc.name;
  test.concurrent(testName, async () => {
    if (DRY_RUN) {
      console.log(`  [DRY RUN] ${testName} — skipped`);
      journalResult({ uc: uc.name, result: "DRY-RUN-SKIPPED" });
      return;
    }

    if (uc.manualOnly) {
      console.log(`  [MANUAL] ${testName} — skipped`);
      journalResult({ uc: uc.name, result: "MANUAL-ONLY" });
      return;
    }

    // Live use cases (no custom run) need the opencode binary on PATH.
    // Skip if it's not available instead of hard-failing with ENOENT.
    if (!uc.run && !DRY_RUN) {
      const check = await $`command -v opencode`.quiet().nothrow();
      if (check.exitCode !== 0) {
        console.log(`  [MANUAL] ${testName} — skipped (opencode not on PATH)`);
        journalResult({ uc: uc.name, result: "MANUAL-ONLY", output: "opencode not on PATH" });
        return;
      }
    }

    await ensureMaster();
    const ctx = await createFixture(uc.name);
    if (leg.binDir) {
      ctx.env.PATH = `${leg.binDir}:${ctx.env.PATH}`;
    }
    const runFn = uc.run ?? ((c: QaContext) => runViaOpencode(uc, c));
    // The crash path journals too: a THROWN test (waitFor timeout, an
    // assertion escape) must still name itself in the journal - the crash
    // is exactly when the name matters most, and the completion-path write
    // below never runs (the 2026-11-09 UC-100 timeout was only in the
    // tee'd stdout). The deliberate FAIL/PARTIAL rethrow happens AFTER the
    // guard so it cannot double-journal.
    const result = await journalGuarded({ uc: uc.name }, async () => {
      const r = await runFn(ctx);
      console.log(`  ${testName}: ${r}`);
      journalResult({ uc: uc.name, result: r });
      return r;
    });

    if (result === "FAIL" || result === "PARTIAL") {
      throw new Error(`${testName}: ${result}`);
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

/**
 * This process's run-scoped roots, for introspection (the concurrency pin
 * test asserts two concurrent runner processes get disjoint roots, and that
 * one run's master setup cannot delete another run's fixtures).
 */
export function qaPaths(): { qaRoot: string; masterRoot: string } {
  return { qaRoot: QA_ROOT, masterRoot: MASTER_ROOT };
}

export function printCleanupNotice(): void {
  if (!DRY_RUN) {
    console.log(`\nQA artifacts left in ${QA_ROOT} and ${MASTER_ROOT} (run-scoped roots)`);
    console.log(`Remove ALL runs' artifacts with: rm -rf ${QA_ROOT_PARENT} ${tmpdir()}/thatch-qa-master-*`);
  }
}

// --- Serve-mode plumbing (multi-session use cases) ---------------------------

import { OpenCode as OpenCodeV2 } from "@opencode/client/promise";
import { discoverHostBinaries } from "./binaries";

/** Fixed serve credential: the serve process requires basic auth. */
const SERVE_PASSWORD = "thatch-qa-password";

// --- Orphan reaping ---------------------------------------------------------

/**
 * A hard-killed runner (pkill, OOM kill, crash) never runs the per-UC
 * cleanup - those handlers live in the test process - so its opencode
 * children survive as orphans: full LLM sessions plus serve and MCP
 * subprocesses grinding through their whole pipeline with no parent to stop
 * them (the 2026-11-05 OOM incident: four detached UC sessions, one at
 * 2.8 GB, after a runner kill). Every opencode spawn therefore gets a
 * WATCHDOG SIBLING: a detached shell that kill-trees the child (deepest
 * first, so no child re-parents its own subtree while dying) the moment
 * this runner's pid dies. The watchdog is itself orphaned by the kill but
 * stays alive to do the reaping; it exits on its own once either side is
 * gone, so a normally-finished child leaves nothing behind.
 */
const spawnedChildren = new Set<{ pid: number; kill: (signal?: number) => void }>();

// Every runner spawn pipes both streams (the two call sites read them);
// pinning the option shape keeps the returned Subprocess's stderr typed as
// the ReadableStream the callers construct Response() from.
type PipeSpawnOptions = {
  cwd?: string;
  env: Record<string, string | undefined>;
  stdout: "pipe";
  stderr: "pipe";
};

function spawnWatched(args: string[], opts: PipeSpawnOptions): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const proc = Bun.spawn(args, { ...opts, stdin: "ignore" });
  spawnedChildren.add(proc);
  const watchdog = Bun.spawn(
    [
      "sh",
      "-c",
      `runner=$1; child=$2
kill_tree() {
  p=$1
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill -9 "$p" 2>/dev/null
}
while kill -0 "$runner" 2>/dev/null && ps -p "$child" >/dev/null 2>&1; do sleep 2; done
if ! kill -0 "$runner" 2>/dev/null; then kill_tree "$child"; fi`,
      "thatch-qa-watchdog",
      String(process.pid),
      String(proc.pid),
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  (watchdog as unknown as { unref?: () => void }).unref?.();
  return proc;
}

// Belt-and-suspenders for the graceful paths: an exit-handler sweep (the
// watchdog above covers only the hard-kill class). Reap and let the test
// framework's own shutdown continue - no process.exit here.
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of spawnedChildren) {
      try { child.kill(9); } catch { /* already dead */ }
    }
  });
}

/**
 * The serve-mode client: the v2 promise client (OpenCode.make) pointed at
 * the serve process, authenticated and directory-scoped through headers.
 * Use cases call it with the promise-domain input shapes (session.create
 * takes `{title}`, prompt takes `{sessionID, text}`, message.list takes
 * `{sessionID}`).
 */
export interface ServeHandle {
  /** Base URL the serve process listens on. */
  url: string;
  /** The v2 promise client for driving sessions over HTTP. */
  client: ReturnType<typeof OpenCodeV2.make>;
  /** Kills the serve process. Call in a finally block. */
  stop: () => void;
}

/**
 * Start a long-lived `opencode serve` on the fixture and return the
 * promise client for it. Unlike `opencode run` one-shots - which die at
 * turn end, taking the plugin's chat poller with them - a serve process
 * hosts sessions across many turns, so it is the only way to observe wake
 * delivery between two real sessions.
 *
 * The port is picked up front and readiness is polled over HTTP rather
 * than parsed from stdout: the startup line can lag plugin warmup well
 * past any reasonable stream-read deadline, and a pipe read under bun
 * test is not guaranteed to surface it. Any successful HTTP response
 * (even a 404) proves the server is listening.
 */
export async function startServe(ctx: QaContext): Promise<ServeHandle> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const url = `http://127.0.0.1:${port}`;
  // serve takes no project flag: it boots project-free and loads the
  // instance per request via the x-opencode-directory header, which the
  // client below sends.
  const proc = spawnWatched(
    ["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    { env: ctx.env, stdout: "pipe", stderr: "pipe" },
  );
  // Readiness deadline: an opencode serve boots in ~5-10s on an idle
  // machine. GitHub CI runners under fleet contention have measured 6x
  // wall-time degradation this week, so the budget is expected x 10
  // headroom, not a bare round number.
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`startServe: opencode serve exited early: ${err.slice(0, 500)}`);
    }
    try {
      await fetch(`${url}/health`);
      break; // any response means the server is listening
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`startServe: serve did not become reachable at ${url} within 120s`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const client = OpenCodeV2.make({
    baseUrl: url,
    headers: {
      Authorization: `Basic ${btoa(`opencode:${SERVE_PASSWORD}`)}`,
      "x-opencode-directory": ctx.dir,
    },
  });
  return { url, client, stop: () => { try { proc.kill(); } catch { /* already dead */ } } };
}
