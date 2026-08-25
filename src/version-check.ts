import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import pkg from "../package.json";

/**
 * Version skew detection and npm update checking.
 *
 * Two complementary checks:
 *
 * Check A (npm): A long-running process (MCP server or opencode plugin) polls
 * the npm registry hourly to see if a newer version of @jeffober/thatch is
 * published. The result is cached in memory and written to a file so that
 * one-shot hook processes (flush-tools) can read it without making network
 * requests. The poll is async and never blocks tool calls. If npm is
 * unreachable, the cache stays stale and the check is silently skipped.
 *
 * Check B (skew): The MCP server writes its running version to a file at
 * startup. Hook processes (flush-tools) read that file and compare it to
 * their own version from package.json. If they differ, the hooks were
 * spawned from a newer binary than the long-running server process. This is
 * the exact scenario from issue #6: the user upgraded thatch but did not
 * restart the host, so the MCP server is frozen at the old version while
 * hooks run the new code.
 *
 * Both checks share a file-based cache directory derived from the DB path
 * (same hashing as the sideband socket) so all processes independently
 * arrive at the same location without out-of-band coordination.
 */

const NPM_PACKAGE = "@jeffober/thatch";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Cache directory (shared with sideband socket path derivation)
// ---------------------------------------------------------------------------

function cacheDir(dbPath: string): string {
  const hash = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
  return join(tmpdir(), `thatch-${hash}`);
}

/** Path to the file where the running MCP server stamps its version. */
export function versionFilePath(dbPath: string): string {
  return join(cacheDir(dbPath), "version");
}

/** Path to the file where the latest npm version is cached. */
export function npmCachePath(dbPath: string): string {
  return join(cacheDir(dbPath), "npm-latest");
}

// ---------------------------------------------------------------------------
// Check B: version skew (local, instant, no network)
// ---------------------------------------------------------------------------

/**
 * Writes the running process's version to the version file. Called once at
 * MCP server or opencode plugin startup. The file is read by hook processes
 * (flush-tools) to detect version skew.
 */
export function writeVersionFile(dbPath: string): void {
  const path = versionFilePath(dbPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, pkg.version, "utf-8");
  } catch {
    // Best-effort. If the file can't be written, skew detection silently
    // degrades: flush-tools will see no version file and skip the skew check.
  }
}

/**
 * Reads the running server's version from the version file. Returns null if
 * the file doesn't exist (server never wrote it, or it was cleaned up).
 */
export function readVersionFile(dbPath: string): string | null {
  try {
    const path = versionFilePath(dbPath);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Removes the version file. Called on MCP server shutdown so stale version
 * files don't trigger false skew warnings for a different server instance.
 */
export function removeVersionFile(dbPath: string): void {
  try {
    unlinkSync(versionFilePath(dbPath));
  } catch {
    // Already gone, or never written. Fine either way.
  }
}

/**
 * Reads package.json from disk and returns the version string. Used by the
 * opencode plugin to detect that the installed package was updated while the
 * process is still running the old cached module. Returns null if the file
 * can't be read.
 */
export function readOnDiskVersion(): string | null {
  try {
    // Resolve package.json relative to this source file: src/version-check.ts
    // -> ../package.json (the repo root or the npm install directory).
    const path = join(dirname(new URL(import.meta.url).pathname), "..", "package.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Compares the on-disk version (what the running server stamped at startup)
 * against the current binary's version (from package.json). Returns a human-
 * readable skew warning if they differ, or null if they match or the file
 * is absent.
 */
export function detectSkew(dbPath: string): string | null {
  const serverVersion = readVersionFile(dbPath);
  if (serverVersion === null) return null;
  if (serverVersion === pkg.version) return null;
  return `thatch was upgraded to v${pkg.version} but this session is running v${serverVersion}. ` +
    `Restart your editor (Claude Code or Cursor) to apply the update.`;
}

// ---------------------------------------------------------------------------
// Check A: npm update polling (network, cached, async)
// ---------------------------------------------------------------------------

interface NpmCacheEntry {
  version: string;
  checkedAt: number;
}

class NpmVersionChecker {
  #dbPath: string;
  #latestVersion: string | null = null;
  #lastCheck: number = 0;
  #polling: boolean = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath: string) {
    this.#dbPath = dbPath;
    // Load cached result from file so a fresh MCP server startup benefits
    // from the last poll a previous process did.
    const cached = this.#readCacheFile();
    if (cached) {
      this.#latestVersion = cached.version;
      this.#lastCheck = cached.checkedAt;
    }
  }

  /**
   * Starts background polling. The first poll fires after the poll interval
   * has elapsed since the last check (or immediately if no cached result
   * exists). Never blocks the caller.
   */
  start(): void {
    if (this.#timer) return;
    // Fire the first poll after a short delay so server startup is not
    // impacted, and subsequent polls at the configured interval.
    const initialDelay = this.#latestVersion ? POLL_INTERVAL_MS : 10_000;
    this.#timer = setInterval(() => { void this.#poll(); }, POLL_INTERVAL_MS);
    // Fire the first check after initialDelay. If we have a recent cache,
    // we wait for the full interval before re-checking.
    setTimeout(() => { void this.#poll(); }, initialDelay);
  }

  /** Stops background polling. */
  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Returns the latest version from npm if known, or null if the cache is
   * empty. This is the fast path: no network, no I/O. The background poll
   * keeps this value fresh.
   */
  getLatestVersion(): string | null {
    return this.#latestVersion;
  }

  /**
   * Returns true if the running version is older than the latest npm
   * version. Returns false if the cache is empty (no data to compare).
   */
  isOutdated(): boolean {
    if (!this.#latestVersion) return false;
    return this.#latestVersion !== pkg.version;
  }

  /**
   * Returns a human-readable update-available warning, or null if no update
   * is known or the running version is current.
   */
  getUpdateWarning(): string | null {
    if (!this.isOutdated()) return null;
    return `thatch v${this.#latestVersion} is available. ` +
      `Run \`npm update ${NPM_PACKAGE}\` to update, then restart your editor.`;
  }

  /**
   * Fetches the latest version from the npm registry. Best-effort: any
   * network error, timeout, or parse failure is silently ignored. The
   * cache is only updated on success.
   */
  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return;
      const data = await res.json() as { version?: string };
      if (!data.version) return;
      this.#latestVersion = data.version;
      this.#lastCheck = Date.now();
      this.#writeCacheFile({ version: data.version, checkedAt: this.#lastCheck });
    } catch {
      // Network error, timeout, or parse failure. Leave the cache as-is.
      // The next poll will retry.
    } finally {
      this.#polling = false;
    }
  }

  #readCacheFile(): NpmCacheEntry | null {
    try {
      const path = npmCachePath(this.#dbPath);
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as NpmCacheEntry;
      if (!parsed.version || !parsed.checkedAt) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  #writeCacheFile(entry: NpmCacheEntry): void {
    try {
      const path = npmCachePath(this.#dbPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(entry), "utf-8");
    } catch {
      // Best-effort. If the file can't be written, only in-memory cache
      // is used. A different process won't benefit, but functionality
      // is unaffected.
    }
  }
}

// ---------------------------------------------------------------------------
// Factory and standalone helpers for hook processes
// ---------------------------------------------------------------------------

let activeChecker: NpmVersionChecker | null = null;

/**
 * Creates and starts an NpmVersionChecker for the long-running process
 * (MCP server or opencode plugin). Stores it in a module-level variable so
 * the caller can retrieve update warnings without holding a reference.
 * Call stopVersionChecker() on shutdown.
 */
export function startVersionChecker(dbPath: string): NpmVersionChecker {
  if (activeChecker) return activeChecker;
  activeChecker = new NpmVersionChecker(dbPath);
  activeChecker.start();
  return activeChecker;
}

/** Stops the active version checker and clears the module-level reference. */
export function stopVersionChecker(): void {
  if (activeChecker) {
    activeChecker.stop();
    activeChecker = null;
  }
}

/** Returns the active version checker, or null if none was started. */
export function getVersionChecker(): NpmVersionChecker | null {
  return activeChecker;
}

/**
 * Reads the npm cache file and returns an update warning if the cached
 * latest version is newer than the running version. Used by one-shot hook
 * processes (flush-tools) that don't have a long-running checker. Returns
 * null if no cache file exists or the running version is current.
 */
export function readNpmCacheForUpdate(dbPath: string): string | null {
  try {
    const path = npmCachePath(dbPath);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as NpmCacheEntry;
    if (!parsed.version) return null;
    if (parsed.version === pkg.version) return null;
    return `thatch v${parsed.version} is available. ` +
      `Run \`npm update ${NPM_PACKAGE}\` to update, then restart your editor.`;
  } catch {
    return null;
  }
}

// For testing: reset module-level state.
export function _resetForTesting(): void {
  stopVersionChecker();
}
