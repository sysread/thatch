/**
 * The doctor: `thatch doctor`'s check engine. Every check is read-only -
 * the doctor diagnoses and advises, `thatch setup` repairs. Findings are
 * plain data (section, check name, verdict, detail, optional fix) so the
 * CLI renders them and the tests assert them without touching printing.
 *
 * The governing contract: HOST-RELEVANT ADVICE ONLY, REPORTED ON DEMAND.
 * A finding about the Claude Code plugin regime is fine here because the
 * human ran a diagnostic deliberately. The same claude state must never
 * leak into host-agnostic surfaces - every other CLI command, or an MCP
 * server spawned by a different host - that leak was the dispatch-path
 * warning this command retired (mixed-host machines saw claude alarms on
 * every terminal command whenever claude hadn't recently run).
 *
 * The sections mirror the hosts thatch integrates with:
 * - common: the database and thatch's own version currency
 * - opencode: the plugin install surfaces, the dev shim, daemon evidence
 * - claude: the plugin or hooks regime, the mod ping, leftover writers
 * - cursor: the standalone-server + hooks integration (there is no plugin
 *   regime for Cursor - no marker value, no mods - so its checks stop at
 *   config, markers, and hooks)
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import pkg from "../package.json";
import { compareSemver, readRegimeMarker, readModLiveness, MOD_LIVENESS_STALE_MS, npmCachePath } from "./version-check";
import {
  claudeConfigDir,
  cursorConfigDir,
  claudeVersionOutput,
  claudeVersionSupportsMods,
  CLAUDE_MODS_FLOOR,
  checkSetup,
  hasThatchInstructionsBlock,
} from "./setup";
import { CHAT_STALE_MS, humanAge } from "./chat";

export type DoctorVerdict = "pass" | "warn" | "fail" | "info";
export type DoctorSection = "common" | "opencode" | "claude" | "cursor";

/** One diagnostic result: what was checked, what was found, and - when the
 *  verdict is warn or fail - the action that repairs it. `fix` names a
 *  command or edit; the doctor never performs it. */
export interface DoctorFinding {
  section: DoctorSection;
  check: string;
  verdict: DoctorVerdict;
  detail: string;
  fix?: string;
}

/** The DB surface the doctor reads. A structural slice of ThatchDB so
 *  tests can stub it without opening a database. */
export interface DoctorDb {
  listStores(): string[];
  listChatSessions(): { name: string; host_kind: string; last_seen: string }[];
}

export interface DoctorDeps {
  db: DoctorDb;
  dbPath: string;
  projectDir: string;
  home: string;
  /** Frozen clock for age-dependent verdicts (ping freshness, heartbeat,
   *  npm-check age). Defaults to Date.now(). */
  now?: number;
  /** The installed claude's `--version` output; null when claude is absent
   *  or fails to run. Injectable so tests stay deterministic. */
  claudeVersionOutput?: () => string | null;
  /** Probes `claude mcp get thatch`: exit 0 means a user-scope thatch MCP
   *  registration exists (the plugin regime deactivates those; a survivor
   *  double-delivers). Injectable for tests. */
  claudeMcpGetThatch?: () => Promise<{ exitCode: number }>;
  /** The installed opencode's `--version` output; null when absent. */
  opencodeVersion?: () => string | null;
}

// ---------------------------------------------------------------------------
// Shared file helpers
// ---------------------------------------------------------------------------

/** Reads and parses a JSON file, or null when absent or corrupt. The
 *  doctor reports state; a corrupt file is a finding, not a crash. */
function readJson(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** True when an mcpServers config file (Claude Code / Cursor / generic MCP
 *  shape) carries a thatch entry. */
function mcpConfigHasThatch(path: string): boolean {
  return readJson(path)?.mcpServers?.thatch != null;
}

/** The settings files that can carry thatch hook groups, both scopes:
 *  the Claude config dir (global) and the project's .claude/ (local). */
function claudeSettingsPaths(deps: DoctorDeps): string[] {
  return [join(claudeConfigDir(deps.home), "settings.json"), join(deps.projectDir, ".claude", "settings.json")];
}

/** The settings files that actually carry thatch hook groups. The match is
 *  the writer's broad rule (removeThatchHooks): any hook group whose
 *  command mentions thatch counts. */
function claudeSettingsWithThatchHooks(deps: DoctorDeps): string[] {
  return claudeSettingsPaths(deps).filter((path) => {
    const settings = readJson(path);
    if (!settings?.hooks) return false;
    for (const groups of Object.values(settings.hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      if ((groups as any[]).some((g) => g?.hooks?.some((h: any) => typeof h?.command === "string" && h.command.includes("thatch")))) {
        return true;
      }
    }
    return false;
  });
}

/** The flat Cursor hooks files (project .cursor/hooks.json, then the
 *  config dir) that carry thatch commands. */
function cursorHooksFiles(deps: DoctorDeps): string[] {
  const paths = [join(deps.projectDir, ".cursor", "hooks.json"), join(cursorConfigDir(deps.home), "hooks.json")];
  return paths.filter((path) => {
    const config = readJson(path);
    if (!config?.hooks) return false;
    for (const entries of Object.values(config.hooks as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      if ((entries as any[]).some((e) => typeof e?.command === "string" && e.command.includes("thatch"))) return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Common: the database and thatch's own version
// ---------------------------------------------------------------------------

export function commonFindings(deps: DoctorDeps): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  try {
    const stores = deps.db.listStores();
    findings.push({
      section: "common",
      check: "database",
      verdict: "pass",
      detail: `reachable at ${deps.dbPath} (${stores.length} store${stores.length === 1 ? "" : "s"})`,
    });
  } catch (err) {
    findings.push({
      section: "common",
      check: "database",
      verdict: "fail",
      detail: `query failed: ${err instanceof Error ? err.message : String(err)}`,
      fix: "check the file's permissions and that no other process holds an exclusive lock on it",
    });
  }
  findings.push(npmUpdateFinding(deps));
  return findings;
}

/** The version-currency check: this binary against the npm cache a
 *  long-running process (any host's) keeps fresh with hourly polls. No
 *  cache yet is information, not a problem - it means no thatch host has
 *  run long enough to poll. */
function npmUpdateFinding(deps: DoctorDeps): DoctorFinding {
  const now = deps.now ?? Date.now();
  const cached = readJson(npmCachePath(deps.dbPath)) as { version?: string; checkedAt?: number } | null;
  if (!cached?.version || !cached.checkedAt) {
    return {
      section: "common",
      check: "update",
      verdict: "info",
      detail: `running v${pkg.version}; no npm update check has run yet (a long-running thatch process - any host's - polls hourly)`,
    };
  }
  const checkedAge = humanAge(new Date(cached.checkedAt).toISOString(), now);
  if (compareSemver(pkg.version, cached.version) < 0) {
    return {
      section: "common",
      check: "update",
      verdict: "warn",
      detail: `v${cached.version} is available (running v${pkg.version}; checked ${checkedAge})`,
      fix: `npm update -g @jeffober/thatch, then restart your host (a dev shim re-export needs no update - it follows its checkout)`,
    };
  }
  return {
    section: "common",
    check: "update",
    verdict: "pass",
    detail: `running v${pkg.version}, the latest known (checked ${checkedAge})`,
  };
}

// ---------------------------------------------------------------------------
// OpenCode: install surfaces, the dev shim, daemon evidence
// ---------------------------------------------------------------------------

/** The opencode release the plugin requires: `session.synthetic`'s resume
 *  option and the typed session.compact/remove/list members (see
 *  docs/dev/features/opencode-plugin.md). */
const OPENCODE_FLOOR = "2.1.0";

function defaultOpencodeVersion(): string | null {
  const bin = Bun.which("opencode");
  if (!bin) return null;
  try {
    const r = Bun.spawnSync([bin, "--version"], { stdout: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

export function opencodeFindings(deps: DoctorDeps): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const now = deps.now ?? Date.now();
  const opencodeDir = join(process.env.XDG_CONFIG_HOME ?? join(deps.home, ".config"), "opencode");
  const pluginsDir = join(opencodeDir, "plugins");
  const fileShim = join(pluginsDir, "thatch.ts");
  const dirShim = join(pluginsDir, "thatch");

  const rawVersion = (deps.opencodeVersion ?? defaultOpencodeVersion)();
  const versionMatch = rawVersion?.match(/(\d+\.\d+\.\d+)/)?.[0] ?? null;

  // Install surfaces: the package entry in a config file, a checkout
  // auto-load dir in the project, or a dev shim in the plugins dir.
  // Detection is a substring scan, not a JSON parse - opencode configs
  // are JSONC, and a diagnostic only needs to know the entry is there.
  const surfaces: string[] = [];
  for (const cfg of [join(opencodeDir, "opencode.json"), join(opencodeDir, "opencode.jsonc"), join(deps.projectDir, "opencode.json"), join(deps.projectDir, "opencode.jsonc")]) {
    if (existsSync(cfg) && readFileSync(cfg, "utf8").includes("@jeffober/thatch")) surfaces.push(`@jeffober/thatch in ${cfg}`);
  }
  for (const d of [join(deps.projectDir, ".opencode", "plugin", "thatch"), join(deps.projectDir, ".opencode", "plugins", "thatch")]) {
    if (existsSync(d)) surfaces.push(`checkout auto-load dir ${d}`);
  }
  const hasShim = existsSync(fileShim) || existsSync(dirShim);

  // The not-detected merge: no binary, no config entry, no shim, no
  // auto-load dir - one line instead of a binary info plus an install
  // info that both say nothing.
  if (surfaces.length === 0 && !hasShim && rawVersion === null) {
    findings.push({
      section: "opencode",
      check: "install",
      verdict: "info",
      detail: "not detected (no opencode on PATH, no plugin entry in any config, no shim, no auto-load dir)",
    });
    return findings;
  }

  if (rawVersion === null) {
    findings.push({ section: "opencode", check: "binary", verdict: "info", detail: "opencode not found on PATH" });
  } else if (versionMatch === null) {
    findings.push({ section: "opencode", check: "binary", verdict: "info", detail: `opencode on PATH (${rawVersion}); version unparseable, floor not checked` });
  } else if (compareSemver(versionMatch, OPENCODE_FLOOR) < 0) {
    findings.push({
      section: "opencode",
      check: "binary",
      verdict: "warn",
      detail: `opencode ${versionMatch} predates ${OPENCODE_FLOOR} - the plugin cannot load on it`,
      fix: "upgrade opencode to 2.1 or newer",
    });
  } else {
    findings.push({ section: "opencode", check: "binary", verdict: "pass", detail: `opencode ${versionMatch} on PATH (meets the ${OPENCODE_FLOOR} plugin floor)` });
  }

  if (surfaces.length > 0) {
    findings.push({ section: "opencode", check: "install", verdict: "pass", detail: `plugin configured: ${surfaces.join("; ")}` });
  } else if (!hasShim) {
    findings.push({
      section: "opencode",
      check: "install",
      verdict: "info",
      detail: "no plugin entry in any config and no auto-load dir (a shim may still exist - see the shim check)",
    });
  }

  findings.push(...shimFindings({ fileShim, dirShim, hasShim }));

  // Daemon evidence: the chat registry's opencode rows are written and
  // heartbeat-ed only by the plugin's poller, so a fresh heartbeat is
  // plugin evidence. The absence is NOT counter-evidence - a daemon whose
  // sessions never registered in chat leaves no trace - and the wording
  // stays honest about that boundary.
  try {
    const rows = deps.db.listChatSessions().filter((r) => r.host_kind === "opencode");
    if (rows.length === 0) {
      findings.push({
        section: "opencode",
        check: "daemon",
        verdict: "info",
        detail: "no opencode sessions in the chat registry - not proof the plugin is unloaded (a daemon whose sessions never registered in chat leaves no trace)",
      });
    } else {
      const newest = rows.reduce((a, b) => (Date.parse(a.last_seen) >= Date.parse(b.last_seen) ? a : b));
      const ageMs = now - Date.parse(newest.last_seen);
      if (ageMs <= CHAT_STALE_MS) {
        findings.push({
          section: "opencode",
          check: "daemon",
          verdict: "pass",
          detail: `an opencode daemon is live (session "${newest.name}" heartbeat-ed ${Math.max(Math.round(ageMs / 1000), 0)}s ago)`,
        });
      } else {
        findings.push({
          section: "opencode",
          check: "daemon",
          verdict: "info",
          detail: `last opencode activity ${humanAge(newest.last_seen, now)} ago (session "${newest.name}") - no daemon has heartbeat-ed since`,
        });
      }
    }
  } catch {
    findings.push({ section: "opencode", check: "daemon", verdict: "info", detail: "skipped: the chat registry is unreadable (see the database check)" });
  }
  return findings;
}

/** The dev shim checks. The shim is the local-development install form
 *  (docs/user/setup.md): a plain default-export re-export pointing at a
 *  checkout. Its failure classes are all load-stoppers or tab-losers, and
 *  none of them can be fixed from inside the plugin (the duplicate-id
 *  check runs before any plugin code), which is why the doctor reports
 *  them instead. */
function shimFindings(paths: { fileShim: string; dirShim: string; hasShim: boolean }): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  if (!paths.hasShim) return findings;

  if (existsSync(paths.fileShim) && existsSync(paths.dirShim)) {
    findings.push({
      section: "opencode",
      check: "shim",
      verdict: "fail",
      detail: `a file shim (thatch.ts) and a directory shim (thatch/) coexist in ${dirname(paths.dirShim)} - opencode stops loading ALL plugins (duplicate plugin id, caught before any plugin code runs)`,
      fix: `delete ${paths.fileShim}; the directory form (thatch/index.ts + tui.ts) is the one that loads the tab-strip plugin`,
    });
    return findings;
  }

  const isDir = existsSync(paths.dirShim);
  const entry = isDir ? join(paths.dirShim, "index.ts") : paths.fileShim;
  if (isDir && !existsSync(entry)) {
    findings.push({
      section: "opencode",
      check: "shim",
      verdict: "fail",
      detail: `the directory shim has no index.ts - the plugin cannot load`,
      fix: `recreate ${entry} as a default-export re-export (docs/user/setup.md, Local development)`,
    });
    return findings;
  }
  if (isDir && !existsSync(join(paths.dirShim, "tui.ts"))) {
    findings.push({
      section: "opencode",
      check: "shim",
      verdict: "warn",
      detail: "no tui.ts beside index.ts - session tabs will not open (the core plugin still works)",
      fix: `add ${join(paths.dirShim, "tui.ts")} re-exporting the checkout's src/opencode/tui-plugin (docs/user/setup.md)`,
    });
  }

  const body = readFileSync(entry, "utf8");
  if (/export\s*\{[^}]*\bserver\b/.test(body)) {
    findings.push({
      section: "opencode",
      check: "shim",
      verdict: "fail",
      detail: "the shim re-exports the named `server` export - that export was removed with the v1 SDK, and the shim fails to link",
      fix: "replace the shim with the default-export form (docs/user/setup.md, Local development)",
    });
    return findings;
  }

  const target = body.match(/from\s+"([^"]+)"/)?.[1];
  if (!target) {
    findings.push({
      section: "opencode",
      check: "shim",
      verdict: "fail",
      detail: `the shim has no re-export target to parse`,
      fix: "rewrite it as `export { default } from \"<thatch-checkout>/src/index\";` (docs/user/setup.md)",
    });
    return findings;
  }
  const resolved = resolve(dirname(entry), target);
  // Bun resolves extensionless re-exports (.ts/.js tried in order); the
  // doctor's existence check must try the same suffixes or every
  // conventionally-written shim reads as dead.
  const targetExists = [resolved, `${resolved}.ts`, `${resolved}.js`].some((p) => existsSync(p));
  if (!targetExists) {
    findings.push({
      section: "opencode",
      check: "shim",
      verdict: "fail",
      detail: `the shim points at ${resolved}, which no longer exists - the plugin fails to load`,
      fix: `re-point ${entry} at a live checkout (docs/user/setup.md, Local development)`,
    });
    return findings;
  }
  const checkoutRoot = resolve(resolved, "..", "..");
  const targetVersion = readJson(join(checkoutRoot, "package.json"))?.version;
  if (typeof targetVersion === "string" && targetVersion !== pkg.version) {
    findings.push({
      section: "opencode",
      check: "shim",
      verdict: "warn",
      detail: `the shim targets ${checkoutRoot} at v${targetVersion}, while this thatch is v${pkg.version} - the daemon loads the shim's checkout, not this one`,
      fix: `re-point the shim, or accept the drift if it is deliberate (a worktree shim during development)`,
    });
  } else {
    findings.push({
      section: "opencode",
      check: "shim",
      verdict: "pass",
      detail: `shim targets ${checkoutRoot}${typeof targetVersion === "string" ? ` (v${targetVersion})` : ""}`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Claude Code: the plugin or hooks regime
// ---------------------------------------------------------------------------

async function defaultClaudeMcpGetThatch(): Promise<{ exitCode: number }> {
  const claudeBin = Bun.which("claude");
  if (!claudeBin) return { exitCode: 1 };
  try {
    const proc = Bun.spawnSync([claudeBin, "mcp", "get", "thatch"], { stdout: "pipe", stderr: "pipe" });
    return { exitCode: proc.exitCode ?? 1 };
  } catch {
    return { exitCode: 1 };
  }
}

export async function claudeFindings(deps: DoctorDeps): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const now = deps.now ?? Date.now();
  const configDir = claudeConfigDir(deps.home);
  const globalPluginDir = join(configDir, "thatch-plugin");
  const projectPluginDir = join(deps.projectDir, ".claude", "thatch-plugin");
  const marker = readRegimeMarker(deps.dbPath, "claude");
  const rawVersion = (deps.claudeVersionOutput ?? claudeVersionOutput)();

  if (rawVersion !== null) {
    findings.push({ section: "claude", check: "binary", verdict: "pass", detail: `claude ${rawVersion} on PATH` });
    findings.push(
      claudeVersionSupportsMods(rawVersion)
        ? { section: "claude", check: "mods floor", verdict: "pass", detail: `${rawVersion} meets ${CLAUDE_MODS_FLOOR} - mods can load, so the plugin regime is available` }
        : {
            section: "claude",
            check: "mods floor",
            verdict: "warn",
            detail: `${rawVersion} predates ${CLAUDE_MODS_FLOOR} - mods cannot load, so the plugin regime cannot run on this claude`,
            fix: "thatch setup --claude --hooks installs the hooks regime instead (or upgrade claude)",
          },
    );
  }

  // The not-detected merge: no binary, no marker, no plugin dir, no
  // instructions markers, no hooks - one line instead of six that all
  // say nothing. The legacy-block check still runs: a stale ~/CLAUDE.md
  // block matters even without claude installed (sessions under $HOME
  // load that file).
  if (rawVersion === null && marker === null && !existsSync(globalPluginDir) && !existsSync(projectPluginDir)) {
    const setupStatus = checkSetup(deps.projectDir, deps.home, "claude");
    const hookFiles = claudeSettingsWithThatchHooks(deps);
    if ((setupStatus === null || setupStatus.status === "not-installed") && hookFiles.length === 0) {
      findings.push({
        section: "claude",
        check: "install",
        verdict: "info",
        detail: "not detected (no claude on PATH, no regime marker, no plugin directory, no instructions markers, no hooks)",
      });
      findings.push(legacyBlockFinding(deps));
      return findings;
    }
  }

  if (marker === "plugin") {
    findings.push(...(await claudePluginRegimeFindings(deps, { globalPluginDir, projectPluginDir, rawVersion, now })));
  } else {
    findings.push(...claudeHooksRegimeFindings(deps));
    if (existsSync(globalPluginDir) || existsSync(projectPluginDir)) {
      findings.push({
        section: "claude",
        check: "regime",
        verdict: "warn",
        detail: "the plugin directory exists but the regime marker is absent - ambiguous state (both regimes' files are present)",
        fix: "thatch setup --claude regenerates the plugin regime and its marker, or --hooks returns to the hooks regime cleanly",
      });
    }
  }

  findings.push(legacyBlockFinding(deps));
  return findings;
}

/** The plugin-regime branch (marker says plugin). The plugin dir, its
 *  manifest's source consistency (the mixed-source guard, reused from
 *  setup as a read), the mod bundle, the ping, and the fallback writers
 *  that must NOT survive the regime (each survivor double-delivers). */
async function claudePluginRegimeFindings(
  deps: DoctorDeps,
  state: { globalPluginDir: string; projectPluginDir: string; rawVersion: string | null; now: number },
): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const scopeDir = existsSync(state.globalPluginDir) ? state.globalPluginDir : existsSync(state.projectPluginDir) ? state.projectPluginDir : null;
  if (scopeDir === null) {
    findings.push({
      section: "claude",
      check: "regime",
      verdict: "fail",
      detail: "the regime marker says the plugin regime owns this install, but no plugin directory exists (claude uninstalled the plugin?)",
      fix: "thatch setup --claude regenerates the plugin, or thatch setup --claude --hooks returns to the hooks regime (which clears the marker)",
    });
    return findings;
  }
  const scope = scopeDir === state.globalPluginDir ? "global" : "project-local";
  findings.push({ section: "claude", check: "regime", verdict: "pass", detail: `plugin regime installed (${scope}: ${scopeDir})` });

  if (state.rawVersion !== null && !claudeVersionSupportsMods(state.rawVersion)) {
    findings.push({
      section: "claude",
      check: "regime",
      verdict: "fail",
      detail: `the regime marker says plugin, but claude ${state.rawVersion} predates mods - claude can never load this plugin`,
      fix: "thatch setup --claude --hooks installs the regime this claude can run (or upgrade claude, then re-run setup)",
    });
  }

  // Manifest source-consistency: the plugin mixes two sources - the mod
  // and instructions rendered by the GENERATING checkout, and the server
  // the manifest's command launches. setup refuses to generate a
  // mismatched pair; the doctor re-checks the installed pair read-only,
  // because an npm update or a moved checkout can break it afterwards.
  // Each tree sub-finding reports independently - a broken tree does not
  // suppress the ping or the leftover-writer findings below, which stay
  // meaningful (a dead tree with a fresh ping means a claude session ran
  // the plugin recently, from this directory).
  const manifest = readJson(join(scopeDir, ".claude-plugin", "plugin.json"));
  const command = manifest?.mcpServers?.thatch?.command;
  if (!manifest || typeof command !== "string") {
    findings.push({
      section: "claude",
      check: "plugin tree",
      verdict: "fail",
      detail: "the plugin manifest is missing or names no bundled-server command",
      fix: "thatch setup --claude regenerates the plugin directory",
    });
  } else {
    let binTree: string | null = null;
    try {
      binTree = dirname(realpathSync(command));
    } catch {
      // Nonexistent command - reported below with the path it names.
    }
    if (binTree === null) {
      findings.push({
        section: "claude",
        check: "plugin tree",
        verdict: "fail",
        detail: `the manifest's server command (${command}) does not exist - the checkout it pointed at moved or was deleted`,
        fix: "thatch setup --claude regenerates the plugin from a live checkout",
      });
    } else if (!existsSync(join(binTree, "..", "src", "claude-plugin", "mod.ts"))) {
      findings.push({
        section: "claude",
        check: "plugin tree",
        verdict: "fail",
        detail: `mixed-source install: the bundled server comes from ${binTree}, whose checkout lacks src/claude-plugin - the mod and the server disagree, and every stage call fails silently`,
        fix: "re-run thatch setup --claude from the checkout you want the plugin to serve",
      });
    } else if (!existsSync(join(scopeDir, "hooks", "mod.js"))) {
      findings.push({
        section: "claude",
        check: "plugin tree",
        verdict: "fail",
        detail: "the built mod bundle (hooks/mod.js) is missing - the plugin loads but registers nothing",
        fix: "thatch setup --claude regenerates the plugin directory",
      });
    } else {
      const treeVersion = readJson(join(binTree, "..", "package.json"))?.version;
      if (typeof treeVersion === "string" && typeof manifest.version === "string" && treeVersion !== manifest.version) {
        findings.push({
          section: "claude",
          check: "plugin tree",
          verdict: "warn",
          detail: `the plugin was generated by v${manifest.version} but its server tree is v${treeVersion} (an update moved underneath the generated plugin)`,
          fix: "thatch setup --claude regenerates the plugin so both halves match",
        });
      } else {
        findings.push({
          section: "claude",
          check: "plugin tree",
          verdict: "pass",
          detail: `consistent: the bundled server comes from ${binTree}${typeof treeVersion === "string" ? ` (v${treeVersion})` : ""}`,
        });
      }
    }
  }

  // Ping freshness: the mod stamps on every prompt through the bundled
  // server's stage tool. Staleness has two innocent readings (claude is
  // not running; the plugin was just regenerated and not loaded yet) and
  // one real one (the mod's hooks are disabled while the server lives) -
  // the finding names all three instead of alarming.
  const lastPing = readModLiveness(deps.dbPath);
  if (lastPing === null) {
    findings.push({
      section: "claude",
      check: "ping",
      verdict: "warn",
      detail: "the mod has never pinged - the plugin has not run in a claude session yet (expected right after setup)",
      fix: `load it: claude --plugin-dir ${scopeDir}`,
    });
  } else {
    const age = state.now - lastPing;
    if (age <= MOD_LIVENESS_STALE_MS) {
      findings.push({
        section: "claude",
        check: "ping",
        verdict: "pass",
        detail: `the mod pinged ${humanAge(new Date(lastPing).toISOString(), state.now)} - the plugin is loaded and delivering`,
      });
    } else {
      findings.push({
        section: "claude",
        check: "ping",
        verdict: "warn",
        detail: `the mod last pinged ${humanAge(new Date(lastPing).toISOString(), state.now)} - expected when claude is not running; if it is, the mod's hooks are disabled (disableAllHooks / allowManagedModsOnly) or the plugin is not loaded`,
        fix: `claude --plugin-dir ${scopeDir} (re)loads it; thatch setup --claude --hooks switches regimes entirely`,
      });
    }
  }

  // Fallback writers that must not survive the regime: each one that
  // remains delivers beside the plugin - every prompt twice.
  const hookFiles = claudeSettingsWithThatchHooks(deps);
  if (hookFiles.length > 0) {
    findings.push({
      section: "claude",
      check: "fallback writers",
      verdict: "warn",
      detail: `settings hooks survived the plugin regime's deactivation (${hookFiles.join(", ")}) - both regimes deliver every prompt`,
      fix: "re-run thatch setup --claude (its deactivation sweep removes them), or delete the thatch hook entries by hand",
    });
  }
  const projectMcp = join(deps.projectDir, ".mcp.json");
  if (mcpConfigHasThatch(projectMcp)) {
    findings.push({
      section: "claude",
      check: "fallback writers",
      verdict: "warn",
      detail: `a standalone thatch entry sits in ${projectMcp} beside the plugin regime - both servers deliver`,
      fix: `delete the mcpServers.thatch entry from ${projectMcp}`,
    });
  }
  if (state.rawVersion !== null) {
    const probe = (deps.claudeMcpGetThatch ?? defaultClaudeMcpGetThatch)();
    const { exitCode } = await probe;
    if (exitCode === 0) {
      findings.push({
        section: "claude",
        check: "fallback writers",
        verdict: "warn",
        detail: "a user-scope thatch MCP registration survives beside the plugin regime (claude mcp get thatch reports one)",
        fix: "claude mcp remove thatch",
      });
    } else {
      findings.push({ section: "claude", check: "fallback writers", verdict: "pass", detail: "no standalone registration or hooks survive the plugin regime" });
    }
  }
  return findings;
}

/** The hooks-regime branch (no marker): the fallback integration's own
 *  state - instructions markers via checkSetup, and the settings hooks
 *  that actually deliver them. Marker/hook mismatch is the failure class
 *  (instructions without hooks = silent nudges; hooks without
 *  instructions = a session that gets reminders it cannot follow). */
function claudeHooksRegimeFindings(deps: DoctorDeps): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const setupStatus = checkSetup(deps.projectDir, deps.home, "claude");
  const hookFiles = claudeSettingsWithThatchHooks(deps);

  if (setupStatus === null || setupStatus.status === "not-installed") {
    findings.push({
      section: "claude",
      check: "install",
      verdict: "info",
      detail: "no instructions markers found (thatch setup --claude was never run, or the block was removed)",
    });
  } else if (setupStatus.status === "markers-broken") {
    findings.push({
      section: "claude",
      check: "install",
      verdict: "fail",
      detail: `the instructions markers in ${setupStatus.file} are corrupted (the start marker is present, the end marker is missing)`,
      fix: "thatch setup --claude rewrites the block (add --global when the file is the config dir's, not the project's)",
    });
  } else {
    findings.push({
      section: "claude",
      check: "install",
      verdict: "pass",
      detail: `hooks regime installed (${setupStatus.scope === "global" ? "global" : "project-local"} scope: instructions markers present)`,
    });
  }

  if (setupStatus?.status === "installed" && hookFiles.length === 0) {
    findings.push({
      section: "claude",
      check: "hooks",
      verdict: "warn",
      detail: "the instructions are installed but no thatch hooks are registered in settings.json - nudges and extraction never fire",
      fix: "thatch setup --claude re-registers them",
    });
  } else if ((setupStatus === null || setupStatus.status === "not-installed") && hookFiles.length > 0) {
    findings.push({
      section: "claude",
      check: "hooks",
      verdict: "warn",
      detail: `thatch hooks are registered (${hookFiles.join(", ")}) but no instructions markers exist - the hooks fire into sessions that were never taught the tools`,
      fix: "thatch setup --claude installs the instructions (or remove the hooks if they are leftovers)",
    });
  } else if (hookFiles.length > 0) {
    findings.push({ section: "claude", check: "hooks", verdict: "pass", detail: `thatch hooks registered (${hookFiles.join(", ")})` });
  }
  return findings;
}

/** The legacy home-root ~/CLAUDE.md sweep state: the old setup era wrote
 *  instructions there, and any session whose cwd is under $HOME loads it
 *  as a parent-dir CLAUDE.md - stale tool spellings for a plugin-regime
 *  reader. setup's migration removes it; the doctor reports survivors. */
function legacyBlockFinding(deps: DoctorDeps): DoctorFinding {
  const legacy = join(deps.home, "CLAUDE.md");
  if (hasThatchInstructionsBlock(legacy)) {
    return {
      section: "claude",
      check: "legacy block",
      verdict: "warn",
      detail: `a stale thatch instructions block sits in ${legacy} - sessions whose cwd is under the home directory load it and see wrong tool spellings`,
      fix: "re-running thatch setup --claude removes it (the migration), or delete the block between the thatch markers by hand",
    };
  }
  return { section: "claude", check: "legacy block", verdict: "pass", detail: `no thatch block at ${legacy}` };
}

// ---------------------------------------------------------------------------
// Cursor: the standalone-server + hooks integration
// ---------------------------------------------------------------------------

export function cursorFindings(deps: DoctorDeps): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const configDir = cursorConfigDir(deps.home);
  const projectMcp = join(deps.projectDir, ".cursor", "mcp.json");
  const globalMcp = join(configDir, "mcp.json");
  const entry = [projectMcp, globalMcp].find((p) => mcpConfigHasThatch(p));
  const setupStatus = checkSetup(deps.projectDir, deps.home, "cursor");
  const hooksFiles = cursorHooksFiles(deps);

  if (entry === undefined && (setupStatus === null || setupStatus.status === "not-installed") && hooksFiles.length === 0) {
    return [
      {
        section: "cursor",
        check: "install",
        verdict: "info",
        detail: "not detected (no thatch entry in .cursor/mcp.json or the config dir, no AGENTS.md markers, no hooks)",
      },
    ];
  }

  if (entry !== undefined) {
    findings.push({ section: "cursor", check: "install", verdict: "pass", detail: `standalone server configured in ${entry}` });
  } else {
    findings.push({ section: "cursor", check: "install", verdict: "info", detail: "no thatch entry in .cursor/mcp.json or the config dir" });
  }

  if (setupStatus === null || setupStatus.status === "not-installed") {
    findings.push({
      section: "cursor",
      check: "markers",
      verdict: "info",
      detail: "no AGENTS.md instructions markers found",
    });
  } else if (setupStatus.status === "markers-broken") {
    findings.push({
      section: "cursor",
      check: "markers",
      verdict: "fail",
      detail: `the instructions markers in ${setupStatus.file} are corrupted (the start marker is present, the end marker is missing)`,
      fix: "thatch setup --cursor rewrites the block (add --global when the file is the config dir's, not the project's)",
    });
  } else {
    findings.push({
      section: "cursor",
      check: "markers",
      verdict: "pass",
      detail: `instructions markers present (${setupStatus.scope === "global" ? "global" : "project-local"} scope)`,
    });
  }

  if (setupStatus?.status === "installed" && hooksFiles.length === 0) {
    findings.push({
      section: "cursor",
      check: "hooks",
      verdict: "warn",
      detail: "the instructions are installed but no thatch hooks are registered in .cursor/hooks.json - nudges and extraction never fire",
      fix: "thatch setup --cursor re-registers them",
    });
  } else if (hooksFiles.length > 0) {
    findings.push({ section: "cursor", check: "hooks", verdict: "pass", detail: `thatch hooks registered (${hooksFiles.join(", ")})` });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Runs every section, in output order: common, opencode, claude, cursor. */
export async function collectDoctorFindings(deps: DoctorDeps): Promise<DoctorFinding[]> {
  return [...commonFindings(deps), ...opencodeFindings(deps), ...(await claudeFindings(deps)), ...cursorFindings(deps)];
}

/** 1 when any finding failed, 0 otherwise - warnings never fail the run,
 *  so `thatch doctor && ...` gates on real breakage only. */
export function doctorExitCode(findings: DoctorFinding[]): number {
  return findings.some((f) => f.verdict === "fail") ? 1 : 0;
}
