import { $ } from "bun";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Isolated repo fixture for QA use-case tests. Each fixture is a clean copy
 * of the thatch repo (via `git archive HEAD`) with its own opencode config,
 * thatch DB, and temp home. The copy lives under /tmp/thatch-qa/<name>/ so
 * it inherits the /tmp/** permission allow rule in the global opencode config.
 *
 * The Venice API key is passed through via {env:VENICE_API_KEY} in the
 * opencode config — never written to disk, never echoed.
 */

const QA_ROOT = "/tmp/thatch-qa";
const REPO_ROOT = join(import.meta.dir, "..", "..");
const MODEL = process.env.QA_MODEL ?? "venice/deepseek-v4-flash-0731";

let masterReady = false;

/**
 * Create the master copy via `git archive HEAD`. Called once before the
 * test suite runs. Idempotent — safe to call multiple times.
 */
export async function ensureMaster(): Promise<string> {
  if (masterReady && existsSync(join(QA_ROOT, "master", "src", "index.ts"))) {
    return QA_ROOT;
  }

  const masterDir = join(QA_ROOT, "master");

  // Clean slate.
  rmSync(QA_ROOT, { recursive: true, force: true });
  mkdirSync(masterDir, { recursive: true });

  // git archive: tracked files only, no .git, no node_modules, no untracked.
  // Write the archive to a temp file, then extract — piping stdin into tar
  // via Bun's shell doesn't work reliably across platforms.
  const archivePath = join(QA_ROOT, "master.tar");
  await $`git archive HEAD -o ${archivePath}`.cwd(REPO_ROOT).quiet();
  await $`tar -xf ${archivePath} -C ${masterDir}`;
  rmSync(archivePath, { force: true });

  // Symlink node_modules from the real repo so tests can run without bun install.
  const realNodeModules = join(REPO_ROOT, "node_modules");
  if (existsSync(realNodeModules)) {
    await $`ln -s ${realNodeModules} ${join(masterDir, "node_modules")}`;
  }

  // Copy .opencode (gitignored, so git archive skips it). The QA skill lives here.
  const opencodeDir = join(REPO_ROOT, ".opencode");
  if (existsSync(opencodeDir)) {
    await $`cp -r ${opencodeDir} ${join(masterDir, ".opencode")}`;
    // Remove gitignored cruft from the copy.
    for (const cruft of ["node_modules", "package.json", "package-lock.json", "bun.lock"]) {
      rmSync(join(masterDir, ".opencode", cruft), { recursive: true, force: true });
    }
  }

  // Write the opencode config. Uses {env:VENICE_API_KEY} so the key is
  // never written to disk.
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
          options: {
            apiKey: "{env:VENICE_API_KEY}",
          },
        },
      },
      permission: {
        external_directory: {
          "/tmp/**": "allow",
        },
      },
    }, null, 2) + "\n",
  );

  // Plugin loader: imports from the copy's own src/index.
  writeFileSync(
    join(masterDir, ".opencode", "plugins", "thatch.ts"),
    'export { server } from "./src/index";\n',
  );

  masterReady = true;
  return QA_ROOT;
}

/**
 * Create an isolated copy of the master for a single use case. Returns the
 * directory path and an env var map to pass to the opencode subprocess.
 */
export async function createUcFixture(ucName: string): Promise<{
  dir: string;
  env: Record<string, string>;
}> {
  const masterDir = join(QA_ROOT, "master");
  const ucDir = join(QA_ROOT, ucName);

  await $`cp -r ${masterDir} ${ucDir}`;

  // Ensure the env-scoped dirs exist.
  for (const sub of ["home", "claude", "config", "queue"]) {
    mkdirSync(join(ucDir, sub), { recursive: true });
  }

  return {
    dir: ucDir,
    env: {
      THATCH_DB_PATH: join(ucDir, "thatch.db"),
      THATCH_QUEUE_DIR: join(ucDir, "queue"),
      CLAUDE_CONFIG_DIR: join(ucDir, "claude"),
      XDG_CONFIG_HOME: join(ucDir, "config"),
      HOME: join(ucDir, "home"),
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      // Pass VENICE_API_KEY through from the parent environment.
      // We reference the value by indirection so it never appears in source.
      VENICE_API_KEY: process.env.VENICE_API_KEY ?? "",
      // Inherit PATH so opencode and bun are findable.
      PATH: process.env.PATH ?? "",
    },
  };
}

/**
 * Run `opencode run` in the fixture directory with the given prompt.
 * Returns stdout+stderr and exit code.
 */
export async function runOpencode(
  dir: string,
  env: Record<string, string>,
  prompt: string,
): Promise<{ stdout: string; exitCode: number }> {
  const result = await $`opencode run --dir ${dir} --model ${MODEL} --auto ${prompt}`
    .env(env)
    .quiet()
    .nothrow();

  return {
    stdout: result.stdout.toString() + result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

/**
 * Read a use case file and build the prompt for the opencode session.
 */
export function buildPrompt(ucContent: string): string {
  return `Load the thatch-qa skill. Then execute this use case and report results:

${ucContent}

Report your result in this format:
UC-NNN: <title>
Result: PASS | FAIL | PARTIAL | MANUAL-ONLY
Evidence:
  - What was run
  - What was observed
  - What matched or didn't match the expected outcome`;
}

/**
 * Parse the result line from opencode's output.
 * Returns "PASS", "FAIL", "PARTIAL", "MANUAL-ONLY", or "UNKNOWN".
 */
export function parseResult(output: string): string {
  const match = output.match(/^Result:\s*(PASS|FAIL|PARTIAL|MANUAL-ONLY)/m);
  return match ? match[1] : "UNKNOWN";
}

/**
 * Discover all use case files in docs/qa/use-cases/.
 * Returns an array of { name, path, content } sorted by filename.
 */
export function discoverUseCases(): { name: string; path: string; content: string }[] {
  const ucDir = join(REPO_ROOT, "docs", "qa", "use-cases");
  const { readdirSync } = require("node:fs") as typeof import("node:fs");

  return readdirSync(ucDir)
    .filter((f: string) => f.startsWith("UC-") && f.endsWith(".md"))
    .sort()
    .map((f: string) => {
      const path = join(ucDir, f);
      const content = readFileSync(path, "utf8");
      return { name: f.replace(/\.md$/, ""), path, content };
    });
}

/**
 * Clean up all QA artifacts.
 */
export function cleanupQa(): void {
  rmSync(QA_ROOT, { recursive: true, force: true });
}

export { REPO_ROOT, QA_ROOT, MODEL };
