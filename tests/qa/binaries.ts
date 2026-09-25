import { constants, accessSync, existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Discovery of the opencode binaries installed on this machine, for the QA
 * matrix: the opencode-driven use cases run once per
 * discovered install instead of once against whatever the PATH happens to
 * resolve first.
 *
 * Discovery asks the package manager where its formulas are installed
 * (`brew --prefix <formula>`), so it follows real installs rather than
 * hunting the user's symlinks and aliases; a PATH fallback covers
 * non-brew installs. Every candidate is validated by actually running
 * `<binary> --version` - the version output, not the formula name, decides
 * the major tag, so a future `opencode` formula shipping 3.x tags itself
 * v3 without changes here.
 *
 * Everything here is SYNCHRONOUS on purpose: registerUseCase must register
 * its per-host tests during bun's module evaluation, and a test registered
 * from a promise callback can land after the collector has moved on.
 */

export interface HostBinary {
  /** Major tag: "v1", "v2", ... UseCase.hosts values match these. */
  tag: string;
  /** Full version string from --version, e.g. "1.18.32". */
  version: string;
  /** Directory to prepend to PATH so `opencode` resolves to this binary. */
  binDir: string;
  /** Where this candidate came from, for the discovery log line. */
  origin: string;
}

interface Candidate {
  binDir: string;
  origin: string;
}

function isExecutableFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Parses `<name> [v]<major>.<minor>.<patch>` output. Null when unparseable. */
export function parseVersionOutput(text: string): { major: number; version: string } | null {
  const m = text.match(/(\d+)\.\d+\.\d+/);
  if (!m) return null;
  return { major: Number.parseInt(m[1], 10), version: m[0] };
}

function versionOfBinary(binary: string, env?: Record<string, string>): { major: number; version: string } | null {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  return parseVersionOutput(result.stdout?.toString() ?? "");
}

function joinBin(prefix: string, bin: string): string {
  return `${prefix.replace(/\/+$/, "")}/${bin}`;
}

/**
 * Brew formula bin dirs for the known opencode formulas. Asked via
 * `brew --prefix <formula>`, which is the package manager's own answer to
 * "where is this installed" - no hard-coded /opt/homebrew, no symlink
 * hunting through the user's bin dirs. A formula that is not installed
 * yields a nonexistent prefix; the executability check drops it.
 */
export function brewCandidateDirs(): Candidate[] {
  const out: Candidate[] = [];
  for (const formula of ["opencode", "opencode-v2"]) {
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      result = Bun.spawnSync(["brew", "--prefix", formula], { stdout: "pipe", stderr: "pipe" });
    } catch {
      break; // brew not installed - PATH fallback still applies.
    }
    if (result.exitCode !== 0) continue;
    const binDir = joinBin((result.stdout?.toString() ?? "").trim(), "bin");
    if (isExecutableFile(joinBin(binDir, "opencode"))) {
      out.push({ binDir, origin: `brew:${formula}` });
    }
  }
  return out;
}

/**
 * The PATH-resolved opencode, as a fallback for non-brew installs. Unlike
 * `command -v` (which on macOS counts a non-executable PATH file as found),
 * the candidate must pass a real executability check.
 */
export function pathCandidateDir(): Candidate | null {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["which", "opencode"], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  const binPath = (result.stdout?.toString() ?? "").trim();
  if (!isExecutableFile(binPath)) return null;
  return { binDir: dirname(binPath), origin: "PATH" };
}

/**
 * Pure tag-and-dedup over candidate bin dirs: runs `--version` on each
 * candidate's binary, tags by major, and dedups two ways - by real path
 * (brew's opt prefix and the PATH entry can resolve to the same cellar
 * keg) and by MAJOR (the matrix runs one leg per major; two installs
 * sharing a major would otherwise produce duplicate `[v2]` labels and
 * colliding fixture dirs). When a major has several installs the newest
 * version wins - the most representative binary of that major's current
 * state. An unparseable --version drops the candidate - a binary that
 * cannot state its version cannot be asserted about.
 */
export function tagBinaries(candidates: Candidate[], env?: Record<string, string>): HostBinary[] {
  const byTag = new Map<string, HostBinary>();
  const seenPaths = new Set<string>();
  for (const candidate of candidates) {
    const binary = joinBin(candidate.binDir, "opencode");
    let real: string;
    try {
      real = realpathSync(binary);
    } catch {
      continue;
    }
    if (seenPaths.has(real)) continue;
    const parsed = versionOfBinary(binary, env);
    if (!parsed) continue;
    seenPaths.add(real);
    const tag = `v${parsed.major}`;
    const incumbent = byTag.get(tag);
    if (!incumbent || versionLt(incumbent.version, parsed.version)) {
      byTag.set(tag, { tag, version: parsed.version, binDir: candidate.binDir, origin: candidate.origin });
    }
  }
  return [...byTag.values()];
}

/** True when semver a < semver b (numeric, dotted triples). */
function versionLt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db;
  }
  return false;
}

let cache: HostBinary[] | null = null;

/** All discovered opencode installs. Computed once per test process. */
export function discoverHostBinaries(): HostBinary[] {
  if (!cache) {
    const pathCandidate = pathCandidateDir();
    const candidates = [...brewCandidateDirs(), ...(pathCandidate ? [pathCandidate] : [])];
    cache = tagBinaries(candidates, { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });
    if (cache.length > 0) {
      const summary = cache.map((h) => `${h.tag} (${h.version}, ${h.origin})`).join(", ");
      console.log(`  [qa-matrix] discovered opencode installs: ${summary}`);
    } else {
      console.log("  [qa-matrix] no opencode installs discovered - use cases fall back to the PATH binary");
    }
  }
  return cache;
}
