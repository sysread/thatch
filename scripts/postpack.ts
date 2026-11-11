// npm lifecycle script: runs after `npm pack` and `npm publish` have built
// the tarball. Restores what scripts/prepack.ts changed in the working
// tree (the slimmed package.json and bun.lock come back from .pack-orig/)
// and removes the generated plugin tree, so packs leave no droppings.
// Only GENERATED paths are touched: .claude-plugin/marketplace.json is
// committed (the repo IS the marketplace) and must survive every pack.
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const origDir = join(root, ".pack-orig");
if (existsSync(origDir)) {
  copyFileSync(join(origDir, "package.json"), join(root, "package.json"));
  copyFileSync(join(origDir, "bun.lock"), join(root, "bun.lock"));
  rmSync(origDir, { recursive: true, force: true });
}
rmSync(join(root, ".claude-plugin", "plugin.json"), { force: true });
rmSync(join(root, "hooks"), { recursive: true, force: true });
