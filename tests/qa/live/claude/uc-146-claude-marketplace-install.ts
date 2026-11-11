import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase } from "../../runner";

/**
 * UC-146 (claude leg): the marketplace front door - validate, add, install.
 *
 * PREREQUISITES: the host's claude CLI (2.1.287+, the mods floor) and bun
 * on PATH. NO login and NO model session: every step is CLI-side, so this
 * use case runs wherever the claude binary runs. The AUTHENTICATED
 * session-load surface (the mod's prompt.submit -> plugin_stage crossing,
 * uc-134's stamp) is NOT asserted here: a fixture CLAUDE_CONFIG_DIR cannot
 * authenticate on claude 2.1.319 (the keychain credential is keyed to the
 * config dir; env-token sessions fail the /api/oauth/validate scope rule)
 * - observed 2026-11-11. That surface joins this use case when the leg's
 * fixture-auth story is settled.
 *
 * Verifies the shipped front door without a release, in two halves:
 *
 * 1. THE MARKETPLACE HALF (the repo IS the marketplace): `claude plugin
 *    validate` passes on the checkout and `claude plugin marketplace add
 *    <checkout>` succeeds - the exact command the README prints, which
 *    failed in the field with "Marketplace file not found at
 *    .../.claude-plugin/marketplace.json".
 *
 * 2. THE INSTALL HALF: `npm pack` builds the shipped artifact (prepack
 *    generates the plugin tree into the package), and a FIXTURE
 *    marketplace installs it. The fixture's thatch entry is a `command`
 *    source printing the unpacked tarball root - the documented local
 *    form that exercises the same install/cache/dependency-install
 *    machinery as the npm source, minus the registry fetch itself (which
 *    only a release proves; the release checklist carries it).
 *
 * The dependency-install assertions are the packaging precondition: an
 * npm-sourced plugin whose package lacks a supported lockfile beside its
 * package.json lands NO node_modules, and the bundled server cannot
 * start. The shipped bun.lock must produce a runtime-only node_modules -
 * Claude Code installs every package the lockfile lists, so the full
 * lockfile would land ~1 GB of devDependency trees in every user's
 * plugin cache.
 */

const useCase: UseCase = {
  name: "UC-146-claude-marketplace-install",
  preconditions: [
    "- The host's claude CLI installed (2.1.287+); bun and npm on PATH",
    "- The thatch repo checked out; no login required",
    "- No other process packing the checkout while this runs (npm pack rewrites",
    "  package.json and bun.lock transiently; postpack restores them)",
  ].join("\n"),
  steps: [
    "1. Validate the checkout's committed marketplace manifest (claude plugin validate).",
    "2. Add the checkout as a marketplace (claude plugin marketplace add) - the README's command.",
    "3. npm pack the checkout; unpack the tarball (what Claude Code's npm fetch would hold).",
    "4. Add a fixture marketplace whose thatch entry is a command source printing the unpacked",
    "    package root; install thatch from it (claude plugin install -y).",
    "5. Assert the install record, the cached plugin tree, and the dependency install:",
    "    node_modules present, runtime trees in, devDependency trees out, no plugin notes.",
  ].join("\n"),
  expected: [
    "- validate exits 0 (Validation passed); marketplace add exits 0 and declares the",
    "  marketplace in the fixture config's settings.",
    "- The install lands in installed_plugins.json (scope user) with the manifest's version.",
    "- The cached copy carries .claude-plugin/plugin.json and hooks/mod.js.",
    "- node_modules exists in the cached copy (the bun.lock-driven install ran) with the",
    "  runtime trees (@huggingface, onnxruntime-web, zod) and WITHOUT the dev trees",
    "  (@opencode, typescript, markdownlint-cli2).",
    "- claude plugin list shows the plugin enabled with no errors and no",
    "  dependencies-not-installed note.",
  ].join("\n"),

  async run() {
    const base = join("/tmp", `thatch-uc146-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const home = join(base, "home");
    const configDir = join(home, ".claude");
    const unpacked = join(base, "unpacked");
    const fixtureMkt = join(base, "fixture-marketplace");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(unpacked, { recursive: true });
    mkdirSync(join(fixtureMkt, ".claude-plugin"), { recursive: true });
    const checkout = join(import.meta.dir, "..", "..", "..", "..");
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      // NO CLAUDE_CODE_PLUGIN_CACHE_DIR here: the plugin CLI honors it for
      // state and cache, but sessions read the config-dir plugins root -
      // the two roots diverge and the session-side install record goes
      // missing (observed 2026-11-11). HOME isolation already keeps every
      // artifact inside the fixture.
      THATCH_DB_PATH: join(base, "thatch.db"),
      THATCH_QUEUE_DIR: join(base, "queue"),
      THATCH_DEBUG: "1",
      THATCH_MODEL: "mock",
    } as Record<string, string>;

    const run = (argv: string[], opts: { cwd?: string } = {}) => {
      const p = Bun.spawnSync(argv, { cwd: opts.cwd ?? base, env, stdout: "pipe", stderr: "pipe" });
      return { exitCode: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
    };

    const failures: string[] = [];

    try {
      const validate = run(["claude", "plugin", "validate", checkout]);
      if (validate.exitCode !== 0) {
        failures.push(`validate exited ${validate.exitCode}: ${(validate.stderr || validate.stdout).slice(0, 300)}`);
      }

      const add = run(["claude", "plugin", "marketplace", "add", checkout]);
      if (add.exitCode !== 0) {
        failures.push(`marketplace add exited ${add.exitCode}: ${(add.stderr || add.stdout).slice(0, 300)}`);
      }

      // npm pack: prepack generates the plugin tree, postpack restores the
      // checkout. The tarball name carries the package version - glob it.
      const pack = run(["npm", "pack", "--pack-destination", base], { cwd: checkout });
      if (pack.exitCode !== 0) {
        failures.push(`npm pack exited ${pack.exitCode}: ${(pack.stderr || pack.stdout).slice(0, 300)}`);
      }
      const tarball = readdirSync(base).find((f) => f.startsWith("jeffober-thatch-") && f.endsWith(".tgz"));
      if (!tarball) {
        failures.push("npm pack produced no jeffober-thatch-*.tgz in the fixture root");
      } else {
        const untar = run(["tar", "xzf", join(base, tarball), "-C", unpacked]);
        if (untar.exitCode !== 0) failures.push(`tar exited ${untar.exitCode}: ${untar.stderr.slice(0, 200)}`);
      }

      // The fixture marketplace: the thatch entry as a command source
      // printing the unpacked package root (copy mode -> cache copy ->
      // the lockfile-driven dependency install runs, which relative-path
      // in-place loads skip).
      const pkgRoot = join(unpacked, "package");
      writeFixtureMarketplace(fixtureMkt, pkgRoot);
      const addFixture = run(["claude", "plugin", "marketplace", "add", fixtureMkt]);
      if (addFixture.exitCode !== 0) {
        failures.push(`fixture marketplace add exited ${addFixture.exitCode}: ${(addFixture.stderr || addFixture.stdout).slice(0, 300)}`);
      }
      const install = run(["claude", "plugin", "install", "thatch@thatch-qa-fixture", "-y"]);
      if (install.exitCode !== 0) {
        failures.push(`install exited ${install.exitCode}: ${(install.stderr || install.stdout).slice(0, 300)}`);
      }

      const pluginsRoot = join(configDir, "plugins");
      const installedPath = readInstallPath(pluginsRoot);
      if (!installedPath) {
        failures.push(`installed_plugins.json under ${pluginsRoot} does not record thatch@thatch-qa-fixture`);
      } else {
        if (!existsSync(join(installedPath, ".claude-plugin", "plugin.json"))) {
          failures.push(`the cached copy at ${installedPath} lacks .claude-plugin/plugin.json`);
        }
        if (!existsSync(join(installedPath, "hooks", "mod.js"))) {
          failures.push(`the cached copy at ${installedPath} lacks hooks/mod.js (the mod did not ship)`);
        }
        // The docs' recovery path for a failed dependency install is
        // `claude plugin update` (it retries the install); use it before
        // failing, so a slow first install does not flake the use case.
        if (!existsSync(join(installedPath, "node_modules"))) {
          run(["claude", "plugin", "update", "thatch@thatch-qa-fixture", "-y"]);
        }
        const nodeModules = join(installedPath, "node_modules");
        if (!existsSync(nodeModules)) {
          failures.push(`no node_modules in the cached copy - the dependency install did not run (the lockfile precondition)`);
        } else {
          for (const runtime of ["@huggingface", "onnxruntime-web", "zod"]) {
            if (!existsSync(join(nodeModules, runtime))) failures.push(`node_modules lacks the runtime tree ${runtime}`);
          }
          for (const dev of ["@opencode", "typescript", "markdownlint-cli2"]) {
            if (existsSync(join(nodeModules, dev))) failures.push(`node_modules carries the dev tree ${dev} (the lockfile was not slimmed)`);
          }
        }
      }

      const list = run(["claude", "plugin", "list", "--json"]);
      const listed = JSON.parse(list.stdout || "[]") as Array<Record<string, unknown>>;
      const mine = listed.find((p) => p.id === "thatch@thatch-qa-fixture");
      if (!mine) {
        failures.push("claude plugin list does not show the installed plugin");
      } else {
        if (mine.enabled !== true) failures.push("the installed plugin is not enabled");
        if (Array.isArray(mine.errors) && mine.errors.length > 0) {
          failures.push(`plugin list reports errors: ${JSON.stringify(mine.errors).slice(0, 300)}`);
        }
        const notes = Array.isArray(mine.notes) ? mine.notes : [];
        if (notes.some((n) => String(n).includes("not installed"))) {
          failures.push(`plugin list reports missing dependencies: ${JSON.stringify(notes).slice(0, 300)}`);
        }
      }
    } catch (err) {
      failures.push(`use case error: ${err}`);
    }

    if (failures.length > 0) {
      for (const f of failures) console.log(`  FAIL: ${f}`);
      return "FAIL";
    }
    return "PASS";
  },
};

function writeFixtureMarketplace(dir: string, pkgRoot: string): void {
  const manifest = {
    name: "thatch-qa-fixture",
    owner: { name: "thatch QA" },
    description: "Fixture marketplace for UC-146: installs the npm-pack artifact locally.",
    plugins: [
      {
        name: "thatch",
        description: "The packed thatch package, installed through the command-source path.",
        // The command runs through sh from the user's home directory and
        // must print the plugin directory as one line.
        source: { source: "command", command: `echo ${pkgRoot}` },
      },
    ],
  };
  writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function readInstallPath(pluginsRoot: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8")) as {
      plugins?: Record<string, Array<{ installPath?: string; scope?: string }>>;
    };
    const installs = raw.plugins?.["thatch@thatch-qa-fixture"];
    const user = installs?.find((i) => i.scope === "user") ?? installs?.[0];
    return user?.installPath ?? null;
  } catch {
    return null;
  }
}

registerUseCase(useCase);
