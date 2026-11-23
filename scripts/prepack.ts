// npm lifecycle script: runs before `npm pack` and `npm publish` build the
// tarball. Two jobs:
//
// 1. Generates the Claude Code plugin tree into the package root so the
//    tarball carries a loadable plugin: .claude-plugin/plugin.json (the
//    manifest Claude Code reads after fetching an npm-sourced plugin) plus
//    hooks/ (the mod, its modules list, the shim, the rendered
//    instructions). The same generator writes the setup-generated plugin
//    in ~/.claude/thatch-plugin, so the two trees cannot drift.
//
// 2. Slims the dependency view the tarball ships (see src/packaging.ts):
//    package.json without devDependencies or scripts, bun.lock reduced to
//    the runtime closure. Without this, Claude Code's dependency install
//    lands ~1 GB of node_modules (it installs every package the lockfile
//    lists, dev trees included); slimmed, it is ~385 MB. The originals
//    are saved to .pack-orig/ and restored by scripts/postpack.ts after
//    the tarball is built.
//
// The server entry differs from the setup-generated one by necessity: the
// package must not assume `thatch` is on PATH or carry a THATCH_PROJECT_DIR
// pinned at pack time. Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} with
// the installed plugin's cache directory, and bun (a stated prerequisite)
// runs the shipped bin directly.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePluginTree } from "../src/setup";
import { parseBunLockfile, slimLockfile, slimPackageJson } from "../src/packaging";

const root = join(import.meta.dir, "..");

await writePluginTree(root, {
  command: "bun",
  args: ["${CLAUDE_PLUGIN_ROOT}/bin/thatch", "mcp", "--bundled"],
});

// The marketplace entry mirrors the generated plugin.json's mcpServers:
// /plugin's Discover view renders a remote entry's own component fields
// ("Component summary not available for remote plugin" when it declares
// none), and an entry's mcpServers never applies when the package has its
// own manifest - the mirror is display-only. Verify it here so drift fails
// the release build instead of showing a stale server config in /plugin.
// The other component fields (commands, agents, skills, hooks) must stay
// undeclared: the plugin ships none as Claude Code components (the shared
// skills install via `thatch setup`, the mod loads from the default
// hooks/hooks.json location), and with the package's plugin.json present,
// entry skills/commands/agents append to the manifest at install and entry
// hooks replace per-event matchers - either would corrupt the install.
const manifest = JSON.parse(
  readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"),
);
const marketplace = JSON.parse(
  readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
);
const entry = marketplace.plugins.find((p: { name: string }) => p.name === "thatch");
if (!entry) {
  throw new Error("marketplace.json lists no thatch entry");
}
if (JSON.stringify(entry.mcpServers) !== JSON.stringify(manifest.mcpServers)) {
  throw new Error(
    "marketplace.json's thatch entry mcpServers must mirror the generated " +
      "plugin.json's mcpServers (the /plugin Discover view renders the entry " +
      `for remote sources). Expected:\n${JSON.stringify(manifest.mcpServers, null, 2)}`,
  );
}
for (const field of ["commands", "agents", "skills", "hooks"] as const) {
  if (entry[field] !== undefined) {
    throw new Error(
      `marketplace.json's thatch entry declares "${field}": the plugin ships ` +
        `no ${field} as Claude Code components, and an entry's component ` +
        "fields merge into the package's own plugin.json at install",
    );
  }
}

const origDir = join(root, ".pack-orig");
// Self-heal: an interrupted pack leaves .pack-orig beside slimmed copies,
// so restore before saving - a re-run must snapshot the REAL originals,
// never a previous run's output.
if (existsSync(origDir)) {
  copyFileSync(join(origDir, "package.json"), join(root, "package.json"));
  copyFileSync(join(origDir, "bun.lock"), join(root, "bun.lock"));
}
mkdirSync(origDir, { recursive: true });
copyFileSync(join(root, "package.json"), join(origDir, "package.json"));
copyFileSync(join(root, "bun.lock"), join(origDir, "bun.lock"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(root, "package.json"), JSON.stringify(slimPackageJson(pkg), null, 2) + "\n");
const lock = parseBunLockfile(readFileSync(join(root, "bun.lock"), "utf8"));
writeFileSync(join(root, "bun.lock"), JSON.stringify(slimLockfile(lock), null, 2) + "\n");
