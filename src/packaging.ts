/**
 * The published package's dependency view. Claude Code installs an
 * npm-sourced plugin's Node.js dependencies from the lockfile beside the
 * package's package.json: it prefers bun.lock (`bun install
 * --frozen-lockfile --ignore-scripts`), then the npm lockfiles
 * (`npm ci --ignore-scripts`). A bun.lock install requires bun on the
 * user's machine - the installer refuses the dependency install
 * otherwise - so the package ships an npm shrinkwrap (generated at
 * prepack from the shipped manifest) and no bun.lock: the dependency
 * install never needs a bun on the user's PATH.
 *
 * The shipped manifest is slimmed from the repo's: devDependencies and
 * scripts stripped (npm ci installs devDependencies too, and the full
 * bun.lock once landed ~1 GB of node_modules in the plugin cache - the
 * runtime closure only is ~385 MB), dependencies pinned to the exact
 * versions the repo's bun.lock resolves (the shipped install must match
 * the versions development tested, not npm's next range match), plus the
 * bun runtime itself as an optional dependency (the bundled server's
 * launcher prefers the @oven binary it installs; optional keeps a failed
 * ~90 MB binary download from failing the whole install - the launcher
 * falls back to a bun on PATH). The repo's own files stay untouched -
 * prepack saves the original package.json and postpack restores it.
 *
 * The shipped lockfile is an npm-shrinkwrap.json (npm packs a shrinkwrap,
 * never a package-lock.json) generated from the shipped manifest. Claude
 * Code's installer prefers bun.lock and refuses the dependency install
 * when bun is not on the user's machine, so the npm shrinkwrap is what
 * makes the install bun-free: its command is `npm ci --ignore-scripts`.
 * The manifest and the lockfile must agree or the install is skipped
 * entirely ("package.json and the lockfile don't list the same
 * dependencies") - the lockfile is generated FROM the manifest, so they
 * agree by construction.
 */
import { dirname, join } from "node:path";

/** The bun runtime version the shipped package installs. Pinned exact:
 * the runtime version IS the npm package version. Matches the version
 * docs/user/setup.md recommends for a PATH install. */
export const BUN_RUNTIME_VERSION = "1.4.4";

export interface BunLockfilePackageMeta {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface BunLockfile {
  lockfileVersion: number;
  configVersion?: number;
  workspaces: Record<
    string,
    {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalPeers?: string[];
    }
  >;
  packages: Record<string, [string, string?, BunLockfilePackageMeta?, string?]>;
}

/**
 * Parses a bun.lock file's text. Bun writes it with trailing commas (JSON
 * with trailing commas is not strict JSON), so the parser tolerates them.
 */
export function parseBunLockfile(text: string): BunLockfile {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as BunLockfile;
}

/**
 * The exact version a bun.lock entry resolves to for a dependency name.
 * Throws on a dependency the lockfile does not resolve or that resolves
 * to more than one entry - both mean the shipped manifest would not
 * describe a real resolution, which must fail at pack time, not on a
 * user's machine at plugin-install time.
 */
function resolvedVersion(lock: BunLockfile, name: string): string {
  const packages = lock.packages ?? {};
  const versioned = `${name}@`;
  const matches = Object.keys(packages).filter((k) => k === name || k.startsWith(versioned));
  if (matches.length === 0) throw new Error(`bun.lock has no entry for ${name}`);
  if (matches.length > 1) throw new Error(`bun.lock resolves ${name} ambiguously: ${matches.join(", ")}`);
  const key = matches[0];
  if (key !== name) return key.slice(versioned.length);
  const resolution = packages[key]?.[0] ?? "";
  if (!resolution.startsWith(versioned)) {
    throw new Error(`bun.lock entry for ${name} does not resolve to a version: ${resolution}`);
  }
  return resolution.slice(versioned.length);
}

/**
 * The shipped manifest's dependency block: the root's dependencies
 * pinned to the exact versions the repo's bun.lock resolves, plus the
 * bun runtime as an optional dependency. npm generates the shipped
 * npm-shrinkwrap.json from this block, so the shipped install and the
 * development-tested versions cannot drift apart.
 */
export function shippedDependencyView(lock: BunLockfile): {
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
} {
  const root = lock.workspaces[""];
  if (!root) throw new Error("bun.lock has no root workspace entry");
  const dependencies: Record<string, string> = {};
  for (const name of Object.keys(root.dependencies ?? {})) {
    dependencies[name] = resolvedVersion(lock, name);
  }
  return { dependencies, optionalDependencies: { bun: BUN_RUNTIME_VERSION } };
}

/**
 * The published package.json: devDependencies and scripts stripped. The
 * dependency install never needs them (npm ci would install
 * devDependencies too, and the shipped scripts reference files the
 * package does not carry), and their absence keeps the package.json
 * consistent with the generated npm-shrinkwrap.json so the dependency
 * install is not skipped.
 */
export function slimPackageJson(pkg: Record<string, unknown>): Record<string, unknown> {
  const slim = { ...pkg };
  delete slim.devDependencies;
  delete slim.scripts;
  return slim;
}

/**
 * The node-runnable dist/ (docs/plans/node-sqlite-driver.md, D12a):
 * bundles the first-party entry graph with bun build --target=node, with
 * ALL of node_modules externalized - dist carries first-party code only,
 * and the plugin install provides the dependencies via the shrinkwrap's
 * `npm ci`. Externalization keeps the dynamic-import graphs intact: the
 * embedding model's lazy `import("onnxruntime-web")` /
 * `import("@huggingface/transformers")` stay as imports in the output
 * and resolve from the installed node_modules at runtime. The entry is
 * the CLI DISPATCHER - its registry carries both the `mcp` server boot
 * and the `embed-daemon` subcommand, so the daemon's re-exec of
 * process.argv[1] + "embed-daemon" dispatches through the same bundle.
 */
export interface BundleDistOptions {
  /** The package root: entries resolve against it, outdir lands in it. */
  root: string;
  /** Entry files, relative to root. Each becomes <basename>.js in outdir. */
  entries: string[];
  /** The output directory, relative to root. Default "dist". */
  outdir?: string;
}

export interface BundleDistResult {
  /** The bundle output files' absolute paths. */
  outputs: string[];
}

export async function bundleNodeDist(opts: BundleDistOptions): Promise<BundleDistResult> {
  const outdir = join(opts.root, opts.outdir ?? "dist");
  const first = opts.entries[0];
  if (!first) throw new Error("bundleNodeDist needs at least one entry");
  // Entries share one directory, so a common root keeps the outputs flat
  // (bin/thatch.ts -> dist/thatch.js) instead of mirroring the tree.
  let build: Awaited<ReturnType<typeof Bun.build>>;
  try {
    build = await Bun.build({
      entrypoints: opts.entries.map((e) => join(opts.root, e)),
      root: join(opts.root, dirname(first)),
      outdir,
      target: "node",
      format: "esm",
      packages: "external",
    });
  } catch (err) {
    // Bun.build THROWS on resolution failures (it does not always
    // surface them through success/logs).
    throw new Error(`bundling the node dist failed:\n${err instanceof Error ? err.message : String(err)}`);
  }
  if (!build.success) {
    throw new Error(`bundling the node dist failed:\n${build.logs.map(String).join("\n")}`);
  }
  return { outputs: build.outputs.map((o) => o.path) };
}
