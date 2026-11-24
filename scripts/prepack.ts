// npm lifecycle script: runs before `npm pack` and `npm publish` build the
// tarball. Four jobs:
//
// 1. Bundles the node-runnable dist/ (src/packaging.ts's bundleNodeDist):
//    first-party code only, node_modules externalized. The launchers run
//    it under a capable node before they fall back to bun or @oven.
//
// 2. Generates the Claude Code plugin tree into the package root so the
//    tarball carries a loadable plugin: .claude-plugin/plugin.json (the
//    manifest Claude Code reads after fetching an npm-sourced plugin) plus
//    hooks/ (the mod, its modules list, the shim, the rendered
//    instructions). The same generator writes the setup-generated plugin
//    in ~/.claude/thatch-plugin, so the two trees cannot drift.
//
// 2. Writes the shipped dependency view (see src/packaging.ts):
//    package.json without devDependencies or scripts, dependencies pinned
//    to the exact versions the repo's bun.lock resolves, plus the bun
//    runtime itself as an optional dependency - the bundled server's
//    launcher (bin/mcp) prefers the @oven binary it installs. An npm
//    lockfile is then generated from that manifest with
//    `npm install --package-lock-only` and shipped as
//    npm-shrinkwrap.json - npm publishes a shrinkwrap but never a
//    package-lock.json, and Claude Code's plugin installer picks the
//    shrinkwrap over bun.lock and installs with `npm ci --ignore-scripts`,
//    so a user needs no bun on PATH at all. The lockfile is generated,
//    not committed - postpack removes it.
//
// The server entry differs from the setup-generated one by necessity: the
// package must not assume `thatch` is on PATH or carry a THATCH_PROJECT_DIR
// pinned at pack time. Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} with
// the installed plugin's cache directory, and the launcher script finds
// the plugin's own bun runtime.
//
// The originals are saved to .pack-orig/ and restored by
// scripts/postpack.ts after the tarball is built.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePluginTree } from "../src/setup";
import { bundleNodeDist, parseBunLockfile, shippedDependencyView, slimPackageJson } from "../src/packaging";

const root = join(import.meta.dir, "..");

// The node-runnable dist/: the launchers' first choice under a capable
// node (bin/thatch's probe). One bundle over the CLI DISPATCHER - its
// registry carries both the `mcp` server boot and the `embed-daemon`
// re-exec target. Prepack runs under bun (the pack scripts do), so the
// bundle step is bun-only; the OUTPUT runs under node >= 22.13.
await bundleNodeDist({ root, entries: ["bin/thatch.ts"] });

await writePluginTree(root, {
  command: "${CLAUDE_PLUGIN_ROOT}/bin/mcp",
  args: ["mcp", "--bundled"],
});

// The marketplace entry declares NO component fields, and must stay that
// way: the plugin ships none of these as Claude Code components (the
// shared skills install via `thatch setup`, the mod loads from the default
// hooks/hooks.json location), and with the package's plugin.json present,
// entry skills/commands/agents append to the manifest at install and entry
// hooks replace per-event matchers - either would corrupt the install. A
// "Component summary not available for remote plugin" line in /plugin's
// Discover view is the honest cost of that restraint.
const marketplace = JSON.parse(
  readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
);
const entry = marketplace.plugins.find((p: { name: string }) => p.name === "thatch");
if (!entry) {
  throw new Error("marketplace.json lists no thatch entry");
}
for (const field of ["commands", "agents", "skills", "hooks", "mcpServers"] as const) {
  if (entry[field] !== undefined) {
    throw new Error(
      `marketplace.json's thatch entry declares "${field}": the plugin ships ` +
        `no ${field} as Claude Code components, and an entry's component ` +
        "fields merge into the package's own plugin.json at install",
    );
  }
}

const origDir = join(root, ".pack-orig");
// Self-heal: an interrupted pack leaves .pack-orig beside the slimmed
// copy, so restore before saving - a re-run must snapshot the REAL
// original, never a previous run's output.
if (existsSync(origDir)) {
  copyFileSync(join(origDir, "package.json"), join(root, "package.json"));
}
mkdirSync(origDir, { recursive: true });
copyFileSync(join(root, "package.json"), join(origDir, "package.json"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = parseBunLockfile(readFileSync(join(root, "bun.lock"), "utf8"));
const shipped = { ...slimPackageJson(pkg), ...shippedDependencyView(lock) };
writeFileSync(join(root, "package.json"), JSON.stringify(shipped, null, 2) + "\n");

// The manifest and the lockfile must agree or Claude Code skips the
// dependency install entirely; generating the lockfile from the shipped
// manifest keeps them in sync by construction. Shipped as
// npm-shrinkwrap.json - npm packs a shrinkwrap, never a package-lock.json.
rmSync(join(root, "package-lock.json"), { force: true });
rmSync(join(root, "npm-shrinkwrap.json"), { force: true });
const npmInstall = Bun.spawnSync(
  ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (npmInstall.exitCode !== 0) {
  throw new Error(`npm install --package-lock-only failed (exit ${npmInstall.exitCode})`);
}
renameSync(join(root, "package-lock.json"), join(root, "npm-shrinkwrap.json"));
