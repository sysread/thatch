/**
 * The published package's dependency view. Claude Code installs an
 * npm-sourced plugin's Node.js dependencies from the lockfile beside the
 * package's package.json, with no dev/production split - it installs
 * every package the lockfile lists (verified live: the full bun.lock
 * landed ~1 GB of node_modules in the plugin cache, devDependency trees
 * included). The published package therefore ships a slimmed dependency
 * view: package.json without devDependencies or scripts, and bun.lock
 * reduced to the runtime closure of package.json's dependencies
 * (~385 MB). The repo's own files stay untouched - prepack saves the
 * originals and postpack restores them.
 *
 * Both artifacts must agree or Claude Code skips the dependency install
 * entirely ("package.json and the lockfile don't list the same
 * dependencies"), leaving the bundled server without node_modules - the
 * slimming strips the same key set from both sides.
 */

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

/** The package name a bun.lock packages-map key denotes: bare names are
 *  used as-is; `name@version` keys (and scoped `@scope/name@version`)
 *  strip at the last `@`. */
function keyToName(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * The runtime dependency closure of a bun.lock: every package reachable
 * from the root workspace's `dependencies` through `dependencies` and
 * `optionalDependencies` edges (optional edges keep the platform-specific
 * binaries - sharp's @img packages - that the wasm embedding backend
 * never invokes but the dependency declarations require). Dev-only trees
 * and the optional peer (@opencode/plugin, provided by the opencode host)
 * stay out.
 *
 * Throws on a dependency the lockfile does not resolve or that resolves
 * to more than one entry - both mean the slimmed lockfile would not
 * satisfy a frozen install, which must fail here at pack time, not on a
 * user's machine at plugin-install time.
 */
export function runtimeClosure(lock: BunLockfile): Set<string> {
  const root = lock.workspaces[""];
  if (!root) throw new Error("bun.lock has no root workspace entry");
  const packages = lock.packages ?? {};

  const entryFor = (name: string): [string, string?, BunLockfilePackageMeta?, string?] => {
    const matches = Object.keys(packages).filter((k) => k === name || k.startsWith(`${name}@`));
    if (matches.length === 0) throw new Error(`bun.lock has no entry for ${name}`);
    if (matches.length > 1) throw new Error(`bun.lock resolves ${name} ambiguously: ${matches.join(", ")}`);
    return packages[matches[0]];
  };

  const closure = new Set<string>();
  const queue = Object.keys(root.dependencies ?? {});
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name)) continue;
    closure.add(name);
    const meta = entryFor(name)[2] ?? {};
    for (const bucket of ["dependencies", "optionalDependencies"] as const) {
      for (const dep of Object.keys(meta[bucket] ?? {})) {
        if (!closure.has(dep)) queue.push(dep);
      }
    }
  }
  return closure;
}

/**
 * The published package.json: devDependencies and scripts stripped. The
 * dependency install never needs them (npm never installs devDependencies
 * for consumers, and the shipped scripts reference files the package does
 * not carry), and their absence keeps the package.json consistent with
 * the slimmed bun.lock so the dependency install is not skipped.
 */
export function slimPackageJson(pkg: Record<string, unknown>): Record<string, unknown> {
  const slim = { ...pkg };
  delete slim.devDependencies;
  delete slim.scripts;
  return slim;
}

/**
 * The published bun.lock: the packages map reduced to the runtime
 * closure, and the root workspace entry reduced to match (name,
 * dependencies, peer declarations). Entry contents are untouched - they
 * carry the integrity hashes the frozen install verifies against.
 */
export function slimLockfile(lock: BunLockfile): BunLockfile {
  const root = lock.workspaces[""];
  if (!root) throw new Error("bun.lock has no root workspace entry");
  const closure = runtimeClosure(lock);
  return {
    lockfileVersion: lock.lockfileVersion,
    ...(lock.configVersion !== undefined ? { configVersion: lock.configVersion } : {}),
    workspaces: {
      "": {
        ...(root.name !== undefined ? { name: root.name } : {}),
        ...(root.dependencies ? { dependencies: root.dependencies } : {}),
        ...(root.peerDependencies ? { peerDependencies: root.peerDependencies } : {}),
        ...(root.optionalPeers ? { optionalPeers: root.optionalPeers } : {}),
      },
    },
    packages: Object.fromEntries(
      Object.entries(lock.packages ?? {}).filter(([key]) => closure.has(keyToName(key))),
    ),
  };
}
