import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { claudeInstructions, cursorInstructions } from "./prompts";
import { installSkills, type InstallReport } from "./skills";
import { installClaudeCommands } from "./commands";
import { readRegimeMarker } from "./version-check";
import pkg from "../package.json";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

interface SetupPaths {
  /** Where to write .mcp.json (project) or print the add command (global). */
  mcpConfigPath: string | null;
  /** CLAUDE.md to append instructions to. */
  claudeMdPath: string;
  /** .claude/settings.json or $CLAUDE_CONFIG_DIR/settings.json for hooks. */
  settingsPath: string;
  /** Skills directory: project .claude/skills/ (local) or config-dir skills/ (global). */
  skillsDir: string;
  /** Whether this is a global install. */
  global: boolean;
}

/**
 * Resolve the Claude config directory. `CLAUDE_CONFIG_DIR` overrides the
 * default `~/.claude` location - used by people running multiple accounts
 * side by side (per Claude Code env-vars docs). Settings, CLAUDE.md, and
 * skills are all stored under this path in global scope.
 */
function claudeConfigDir(homeDir: string): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homeDir, ".claude");
}

/** The thatch DB path, resolved the same way bin/thatch and the MCP server
 *  do (THATCH_DB_PATH override, else under the config home). The regime
 *  marker is BESIDE the db (dirname) - deliberately not version-check's
 *  tmp cacheDir (a reboot must not erase the regime story). */
function thatchDbPath(homeDir: string): string {
  return process.env.THATCH_DB_PATH ?? join(process.env.XDG_CONFIG_HOME ?? join(homeDir, ".config"), "thatch", "thatch.db");
}

function resolvePaths(global: boolean, projectDir: string, homeDir: string): SetupPaths {
  const configDir = claudeConfigDir(homeDir);

  if (global) {
    return {
      mcpConfigPath: null,
      // Per Claude Code settings docs, user-scope CLAUDE.md lives at
      // `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md` when the
      // env var is set) - NOT `~/CLAUDE.md`. Honoring CLAUDE_CONFIG_DIR
      // here also fixes a pre-existing bug where we wrote to `~/CLAUDE.md`.
      claudeMdPath: join(configDir, "CLAUDE.md"),
      settingsPath: join(configDir, "settings.json"),
      // Global installs put skills where every project can read them:
      // the Claude config dir (Claude Code auto-discovers it).
      skillsDir: join(configDir, "skills"),
      global: true,
    };
  }

  return {
    mcpConfigPath: join(projectDir, ".mcp.json"),
    claudeMdPath: join(projectDir, "CLAUDE.md"),
    settingsPath: join(projectDir, ".claude", "settings.json"),
    // Project-local installs keep skills in the repo so they version with
    // the project and every contributor gets them. Claude Code discovers
    // project skills at .claude/skills/ alongside its own project config.
    skillsDir: join(projectDir, ".claude", "skills"),
    global: false,
  };
}

// ---------------------------------------------------------------------------
// .mcp.json - MCP server registration
// ---------------------------------------------------------------------------

/**
 * The thatch MCP server entry in the `mcpServers` shape shared by Claude
 * Code, Cursor, and many other MCP clients. writeMcpConfig persists it
 * into a config file; `thatch setup --mcp-json` prints it for harnesses
 * thatch does not configure itself.
 */
export function thatchMcpServerEntry(thatchBin: string, projectDir?: string) {
  return {
    type: "stdio",
    command: thatchBin,
    args: ["mcp"],
    // Project-LOCAL configs pin the project directory so the server's
    // identity resolution is deterministic regardless of the cwd the host
    // spawns it with. Global-scope configs must NEVER pin: one entry serves
    // every project, and a first-in-chain env override would clobber all
    // of them. (The projectDir chain in src/mcp.ts.)
    ...(projectDir ? { env: { THATCH_PROJECT_DIR: projectDir } } : {}),
  };
}

function writeMcpConfig(path: string, thatchBin: string, projectDir?: string): void {
  let config: any = { mcpServers: {} };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupt or empty - start fresh.
    }
  }
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers.thatch = thatchMcpServerEntry(thatchBin, projectDir);

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

/** Removes the thatch server entry from an mcpServers config file (the
 *  plugin regime's deactivation of the STANDALONE server). Leaves every
 *  other server and key untouched; drops the mcpServers key when it
 *  empties. */
function removeMcpServerEntry(path: string): void {
  if (!existsSync(path)) return;
  let config: any;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Corrupt - leave it alone; the regime marker still reports the regime.
    return;
  }
  if (!config?.mcpServers?.thatch) return;
  delete config.mcpServers.thatch;
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

/** Removes every thatch hook group from a Claude Code settings file - the
 *  inverse of replaceThatchHooks, which only ever adds (its filter drops
 *  our groups, then re-adds ours). The plugin regime's deactivation uses
 *  this: opt-in must DELETE the fallback's writers, or both regimes
 *  deliver every prompt. Other settings and other hooks stay untouched. */
function removeThatchHooks(settingsPath: string): void {
  if (!existsSync(settingsPath)) return;
  let settings: any;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return;
  }
  const hooks = settings?.hooks;
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    // The match is BROAD (the writer's twin rule - legacy shapes must
    // match too); the accepted cost: a user hook whose command mentions
    // "thatch" is treated as ours and removed.
    const kept = groups.filter((g: any) => !g?.hooks?.some((h: any) => h?.command?.includes("thatch")));
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/** Removes the thatch instruction block (between THATCH_BEGIN/THATCH_END)
 *  from an instructions file - the plugin regime's deactivation of the
 *  CLAUDE.md/AGENTS.md marker block. Deletes the file when nothing but
 *  whitespace remains. */
function removeBlock(path: string): void {
  if (!existsSync(path)) return;
  const existing = readFileSync(path, "utf8");
  // The remover's twin rules match the WRITER's: sentinel-format blocks
  // AND pre-sentinel legacy blocks (prose delimiters, the em-dash heal
  // class). Opt-in must deactivate BOTH - a surviving legacy block means
  // both regimes deliver instructions.
  let startIdx = -1;
  let endLen = 0;
  const beginIdx = existing.indexOf(THATCH_BEGIN);
  if (beginIdx >= 0) {
    const endIdx = existing.indexOf(THATCH_END, beginIdx);
    // Broken sentinels cannot be healed by removal (the span is unknown) -
    // leave for checkSetup, which reports them.
    if (endIdx < 0) return;
    startIdx = beginIdx;
    endLen = endIdx + THATCH_END.length - beginIdx;
  } else if (existing.includes(THATCH_MARKER)) {
    const legacyStart = existing.indexOf(THATCH_MARKER);
    const legacyEnd = existing.indexOf(THATCH_END_MARKER, legacyStart);
    if (legacyEnd >= 0) {
      startIdx = legacyStart;
      endLen = legacyEnd + THATCH_END_MARKER.length - legacyStart;
    } else {
      // Broken legacy block: the writer's heal guard, empty block - remove
      // to EOF only when the tail is recognizably the instructions; when
      // the guard fails, leave for manual repair (checkSetup reports it),
      // never eat possibly-user content.
      healBrokenBlock(path, existing, legacyStart, "");
      return;
    }
  }
  if (startIdx < 0) return; // no thatch block of either format
  const rest = (existing.slice(0, startIdx) + existing.slice(startIdx + endLen)).trim();
  if (rest) writeFileSync(path, rest + "\n");
  else rmSync(path);
}

// ---------------------------------------------------------------------------
// CLAUDE.md - append thatch instructions (idempotent)
// ---------------------------------------------------------------------------

/**
 * Sentinel delimiters for the thatch instructions block. HTML comments, not
 * prose: agents edit these files constantly (and normalize punctuation while
 * they are in there), so any prose sentence used as a delimiter eventually
 * stops matching and the block becomes un-updatable. Sentinels survive prose
 * edits because they are not prose.
 */
export const THATCH_BEGIN = "<!-- thatch:begin -->";
export const THATCH_END = "<!-- thatch:end -->";

/**
 * Legacy delimiters, used by installs before the sentinels: prose sentences
 * from the instructions themselves. Detection-only - they exist so setup can
 * find and migrate (or heal) pre-sentinel blocks. Do not write new blocks
 * with them; any edit to the file's prose breaks the match.
 */
const THATCH_MARKER = "# Persistence\n\nThatch provides persistent memory across Claude Code sessions.";
const THATCH_END_MARKER = '"Forget X" - `memory_recall` to find it, then `memory_forget`.';
const CURSOR_MARKER = "# Persistence\n\nThatch provides persistent memory across Cursor sessions.";
const CURSOR_END_MARKER = THATCH_END_MARKER;

/**
 * The instructions' last line (punctuation-insensitive tail test): the
 * "heal" rule may only consume file tail when the corruption is the known
 * kind - the legacy block running to EOF. Without this guard, a broken
 * legacy block followed by unrelated user content would eat that content.
 */
const INSTRUCTIONS_TAIL_SENTINEL = "memory_forget";

function appendBlock(
  path: string,
  instructions: string,
  legacyStartMarker: string,
  legacyEndMarker: string,
): void {
  const block = `${THATCH_BEGIN}\n${instructions.trimEnd()}\n${THATCH_END}`;

  if (!existsSync(path)) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, block + "\n");
    return;
  }

  const existing = readFileSync(path, "utf8");

  // Current format: replace between the sentinels.
  if (existing.includes(THATCH_BEGIN)) {
    const beginIdx = existing.indexOf(THATCH_BEGIN);
    const endIdx = existing.indexOf(THATCH_END, beginIdx);
    if (endIdx >= 0) {
      const afterEnd = endIdx + THATCH_END.length;
      writeFileSync(path, existing.slice(0, beginIdx) + block + existing.slice(afterEnd));
      return;
    }
    // Begin without end: the sentinel block itself was corrupted. Same heal
    // rule as the legacy broken case below.
    healBrokenBlock(path, existing, beginIdx, block);
    return;
  }

  // Legacy format: prose-sentence delimiters from a pre-sentinel install.
  if (existing.includes(legacyStartMarker)) {
    const startIdx = existing.indexOf(legacyStartMarker);
    const endIdx = existing.indexOf(legacyEndMarker, startIdx);
    if (endIdx >= 0) {
      // Intact legacy block: swap the whole span for the sentinel block.
      const afterEnd = endIdx + legacyEndMarker.length;
      writeFileSync(path, existing.slice(0, startIdx) + block + existing.slice(afterEnd));
      return;
    }
    // Broken legacy block (the observed corruption: an agent edit normalized
    // the prose - hyphens became em dashes - so the end sentence no longer
    // matches). Heal by replacing from the legacy start to EOF, but only
    // when the tail is recognizably the instructions; otherwise leave it
    // for manual repair.
    healBrokenBlock(path, existing, startIdx, block);
    return;
  }

  // No thatch block yet: append.
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, existing + sep + block + "\n");
}

/**
 * Replaces everything from `startIdx` to EOF with the fresh sentinel block,
 * but only when the corrupted tail is recognizably the thatch instructions
 * (the tail test). Reports via return value so callers can surface a
 * skipped heal; the file is left untouched when the guard does not pass.
 */
function healBrokenBlock(path: string, existing: string, startIdx: number, block: string): boolean {
  const tail = existing.slice(startIdx).slice(-400);
  if (!tail.includes(INSTRUCTIONS_TAIL_SENTINEL)) {
    return false;
  }
  writeFileSync(path, existing.slice(0, startIdx) + block + "\n");
  return true;
}

function appendInstructions(path: string): void {
  appendBlock(path, claudeInstructions(), THATCH_MARKER, THATCH_END_MARKER);
}

function appendCursorInstructions(path: string): void {
  appendBlock(path, cursorInstructions(), CURSOR_MARKER, CURSOR_END_MARKER);
}

// ---------------------------------------------------------------------------
// settings.json - hook installation
// ---------------------------------------------------------------------------

interface HookEntry {
  type: "command";
  command: string;
}

interface SettingsJson {
  hooks?: {
    SessionStart?: { hooks: HookEntry[] }[];
    PostToolBatch?: { hooks: HookEntry[] }[];
    UserPromptSubmit?: { hooks: HookEntry[] }[];
    Stop?: { hooks: HookEntry[] }[];
  };
  [key: string]: any;
}

function writeHooks(path: string, thatchBin: string): void {
  let settings: SettingsJson = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupt - start fresh.
    }
  }
  if (!settings.hooks) settings.hooks = {};

  const sessionStartCmd = `${thatchBin} reminder`;
  // PostToolBatch silently buffers tool interactions to the file-backed queue
  // (see src/extract-queue.ts). No stdout - the next model call must not block
  // on a payload that should be invisible to the agent until UserPromptSubmit.
  const bufferCmd = `${thatchBin} buffer-batch`;
  // UserPromptSubmit peeks the queue. With buffered interactions, it
  // prints the extraction nudge - on Claude Code with the payload inline
  // for in-context processing (no sub-agent), on Cursor as the
  // dispatched-extractor nudge. With an empty queue, it falls back to the
  // static write-nudge. Either output is transcript-visible since
  // UserPromptSubmit adds stdout to context.
  const flushCmd = `${thatchBin} flush-tools`;
  // Stop fires when the agent turn ends. chat-notify emits a Stop-hook
  // additionalContext reminder when chat mail is unread - the turn
  // continues so the model can read its mail, the Claude Code analog of
  // opencode's poller wake. The host's loop protections (stop_hook_active,
  // the 8-consecutive cap) plus the delivered stamp bound repeats.
  const notifyCmd = `${thatchBin} chat-notify`;

  settings.hooks.SessionStart = replaceThatchHooks(
    settings.hooks.SessionStart ?? [],
    sessionStartCmd,
  );
  settings.hooks.PostToolBatch = replaceThatchHooks(
    settings.hooks.PostToolBatch ?? [],
    bufferCmd,
  );
  settings.hooks.UserPromptSubmit = replaceThatchHooks(
    settings.hooks.UserPromptSubmit ?? [],
    flushCmd,
  );
  settings.hooks.Stop = replaceThatchHooks(
    settings.hooks.Stop ?? [],
    notifyCmd,
  );

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function replaceThatchHooks(
  groups: { hooks: HookEntry[] }[],
  command: string,
): { hooks: HookEntry[] }[] {
  // Remove existing thatch hook groups, then add ours.
  // BROAD match (the remover's twin rule - legacy shapes must match too);
  // the accepted cost: a user hook whose command merely mentions "thatch"
  // is treated as ours and replaced.
  const filtered = groups.filter(
    (g) => !g.hooks.some((h) => h.command?.includes("thatch")),
  );
  filtered.push({ hooks: [{ type: "command", command }] });
  return filtered;
}

// ---------------------------------------------------------------------------
// Main setup entry point
// ---------------------------------------------------------------------------

/**
 * Thatch skills found in the OTHER scope's directory. A local run checks the
 * user config dir; a global run checks the project. Setup never touches the
 * other scope, so these copies drift on their own - surfacing them lets the
 * CLI warn about leftovers (e.g. user-scope skills from before a repo moved
 * to project-local installs).
 */
export interface OtherScopeSkills {
  dir: string;
  count: number;
}

/**
 * Count thatch-* skill directories (or symlinks) under a skills dir without
 * touching anything. Returns 0 when the dir doesn't exist.
 */
function countThatchSkills(dir: string): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter(
    (e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.startsWith("thatch-"),
  ).length;
}

function otherScopeInfo(dir: string): OtherScopeSkills | null {
  const count = countThatchSkills(dir);
  return count > 0 ? { dir, count } : null;
}

export interface SetupResult {
  mcpConfig: string | null;
  claudeMd: string;
  settings: string;
  /** Skill install report for the directory this run wrote to. */
  skills: InstallReport;
  /** Command files (the /thatch/* actions) written by this run, if any. */
  commands: string[];
  /** Thatch skills in the opposite scope's dir, if any; never written by this run. */
  otherScopeSkills: OtherScopeSkills | null;
  global: boolean;
  /** For global installs, the `claude mcp add` command to run. */
  mcpAddCommand: string | null;
}

/**
 * Installs thatch into Claude Code. Writes MCP config, appends instructions to
 * CLAUDE.md, installs SessionStart + PostToolBatch + UserPromptSubmit hooks,
 * and installs skill files. All operations are idempotent - re-running setup
 * updates content that has drifted without clobbering unrelated configuration.
 *
 * Skills follow the install scope: project-local runs write them to the
 * repo's .claude/skills/, global runs to $CLAUDE_CONFIG_DIR/skills/. Honors
 * `CLAUDE_CONFIG_DIR` for all user-scoped paths (settings, CLAUDE.md, skills).
 *
 * @param thatchBin Absolute path to the thatch binary
 * @param global Whether to install globally or project-locally
 * @param projectDir The project directory (used for project-local installs)
 * @param homeDir Home directory (defaults to os.homedir())
 */
export function setupClaudeCode(
  thatchBin: string,
  global: boolean,
  projectDir: string,
  homeDir?: string,
): SetupResult {
  const { homedir } = require("node:os");
  const home = homeDir ?? homedir();
  const paths = resolvePaths(global, projectDir, home);

  if (paths.mcpConfigPath) {
    writeMcpConfig(paths.mcpConfigPath, thatchBin, projectDir);
  }

  appendInstructions(paths.claudeMdPath);
  writeHooks(paths.settingsPath, thatchBin);
  const skills = installSkills(paths.skillsDir);

  // Command files (the /thatch/* actions Claude Code reads as slash
  // commands) live beside skills under the .claude dir, same scope rules.
  const claudeDir = global ? claudeConfigDir(home) : join(projectDir, ".claude");
  const commands = installClaudeCommands(claudeDir);

  // The scope this run did NOT write to. Local runs leave user-scope copies
  // behind (pre-existing global installs); global runs leave project-local
  // copies in the repo. Either way the user should hear about them.
  const otherDir = global
    ? join(projectDir, ".claude", "skills")
    : join(claudeConfigDir(home), "skills");

  return {
    mcpConfig: paths.mcpConfigPath,
    claudeMd: paths.claudeMdPath,
    settings: paths.settingsPath,
    skills,
    commands,
    otherScopeSkills: otherScopeInfo(otherDir),
    global,
    mcpAddCommand: global
      ? `claude mcp add --scope user thatch -- ${thatchBin} mcp`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Claude Code plugin regime (Track 2, QA-only - never merges to main)
// ---------------------------------------------------------------------------

/** Result of a plugin-regime setup run: where the generated plugin lives
 *  and what fallback machinery was deactivated (reported to the user -
 *  deactivation is the point of the regime opt-in, so it says what it did). */
export interface PluginRegimeResult {
  pluginDir: string;
  deactivated: string[];
}

/**
 * Installs the Claude Code PLUGIN regime: generates the plugin directory
 * (manifest + bundled MCP server + mod) and deactivates the fallback
 * regime's writers (settings hooks, CLAUDE.md block, standalone MCP
 * config). Opt-in must deactivate, or both regimes deliver every prompt -
 * the fallback's auto-refresh would resurrect hooks this run removed.
 *
 * The generated plugin: plugin.json (manifest, bundling the MCP server as
 * `thatch mcp --bundled`), hooks/hooks.json (the modules list - what makes
 * the plugin a mod), hooks/register.js (thin shim binding the rendered
 * instructions), hooks/instructions.js (the ONE-TEMPLATE system prompt,
 * generated from src/prompts.ts so it cannot drift from the fallback
 * regime's rendering), and hooks/mod.js (the bundled mod logic, built with
 * the browser target so any node: import in its graph fails the build -
 * the mods runtime gives hooks no Node APIs).
 *
 * The plugin directory is stable across runs (idempotent re-generation),
 * so the user loads it once (`claude --plugin-dir <dir>` for QA) and setup
 * refreshes it in place.
 */
export async function setupClaudePluginRegime(
  thatchBin: string,
  global: boolean,
  projectDir: string,
  homeDir?: string,
): Promise<PluginRegimeResult> {
  const home = homeDir ?? process.env.HOME ?? "/tmp";
  const paths = resolvePaths(global, projectDir, home);
  const pluginDir = global
    ? join(claudeConfigDir(home), "thatch-plugin")
    : join(projectDir, ".claude", "thatch-plugin");
  const hooksDir = join(pluginDir, "hooks");
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(hooksDir, { recursive: true });

  // Manifest: the plugin's OWN MCP server is the bundled one - no
  // `claude mcp add` / .mcp.json entry in this regime. Project-local runs
  // pin THATCH_PROJECT_DIR (same rule as the standalone config).
  const manifest = {
    name: "thatch",
    version: pkg.version,
    description: "Thatch memory, extraction, and cross-session chat for Claude Code.",
    mcpServers: {
      thatch: {
        type: "stdio",
        command: thatchBin,
        args: ["mcp", "--bundled"],
        ...(global ? {} : { env: { THATCH_PROJECT_DIR: projectDir } }),
      },
    },
  };
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(
    join(hooksDir, "hooks.json"),
    JSON.stringify({ description: "The thatch hooks module", modules: ["./register.js"] }, null, 2) + "\n",
  );
  writeFileSync(
    join(hooksDir, "register.js"),
    `// Generated by thatch setup - do not edit; re-run setup to refresh.
import { registerMod as thatchRegister } from "./mod.js";
import { INSTRUCTIONS } from "./instructions.js";

export function register(on) {
  return thatchRegister(on, {
    instructions: INSTRUCTIONS,
    stageTool: { server: "thatch", tool: "plugin_stage" },
    lifecycleTool: { server: "thatch", tool: "plugin_lifecycle" },
    chatWakeTool: { server: "thatch", tool: "plugin_chat_wake" },
    watchPollTool: { server: "thatch", tool: "plugin_watch_poll" },
  });
}
`,
  );
  writeFileSync(
    join(hooksDir, "instructions.js"),
    // The PLUGIN regime's variant: it teaches the watch tools as available
    // and wake delivery as working - the opposite of the hooks-regime
    // wording, which this regime's deactivation just removed.
    `// Generated by thatch setup - do not edit; re-run setup to refresh.\n` +
      `export const INSTRUCTIONS = ${JSON.stringify(claudeInstructions("plugin"))};\n`,
  );

  // The mod bundle: browser target - a node: import anywhere in the mod's
  // graph fails HERE (at setup) instead of at load in Claude Code.
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "src", "claude-plugin", "mod.ts")],
    target: "browser",
    outdir: hooksDir,
    naming: "mod.js",
  });
  if (!build.success) {
    const logs = build.logs.map((l) => String(l)).join("\n");
    throw new Error(`building the thatch mod failed (the mod's graph must be Node-free):\n${logs}`);
  }

  // Deactivate the fallback regime's writers - BOTH scopes: the plugin
  // regime replaces the install, and a surviving hook or marker from
  // either scope would double-deliver every prompt.
  const deactivated: string[] = [];
  for (const settings of [join(claudeConfigDir(home), "settings.json"), join(projectDir, ".claude", "settings.json")]) {
    if (existsSync(settings)) {
      removeThatchHooks(settings);
      deactivated.push(`hooks: ${settings}`);
    }
  }
  for (const md of [join(claudeConfigDir(home), "CLAUDE.md"), join(projectDir, "CLAUDE.md")]) {
    if (existsSync(md)) {
      removeBlock(md);
      deactivated.push(`instructions: ${md}`);
    }
  }
  if (paths.mcpConfigPath && existsSync(paths.mcpConfigPath)) {
    removeMcpServerEntry(paths.mcpConfigPath);
    deactivated.push(`standalone MCP config: ${paths.mcpConfigPath}`);
  }
  // The PROJECT .mcp.json is swept on BOTH scopes' runs: a global-run
  // user can still have a project-local entry from an earlier fallback
  // install, and both servers delivering means double delivery.
  if (paths.mcpConfigPath !== join(projectDir, ".mcp.json") && existsSync(join(projectDir, ".mcp.json"))) {
    removeMcpServerEntry(join(projectDir, ".mcp.json"));
    deactivated.push(`standalone MCP config: ${join(projectDir, ".mcp.json")}`);
  }
  deactivated.push(
    "global MCP registration (run `claude mcp remove thatch` by hand if `claude mcp get thatch` reports one)",
  );

  return { pluginDir, deactivated };
}

// ---------------------------------------------------------------------------
// Global MCP registration (Claude Code)
// ---------------------------------------------------------------------------

/**
 * Outcome of trying to register the thatch MCP server with the `claude`
 * CLI. `registered` and `already-registered` mean the MCP server is
 * usable; `claude-missing` and `failed` mean the caller must print
 * `manualCommand` for the user to run by hand.
 */
export interface ClaudeMcpRegistration {
  status: "registered" | "already-registered" | "claude-missing" | "failed";
  manualCommand: string;
  detail: string;
}

export interface CommandRunResult {
  exitCode: number;
}

async function defaultCommandRun(argv: string[]): Promise<CommandRunResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return { exitCode: proc.exitCode ?? 1 };
}

/**
 * Runs `claude mcp add --scope user` on the user's behalf - the
 * global-setup counterpart of writing .mcp.json, which project-local
 * setup does directly. ~/.claude.json is not hand-writable (the reason
 * setup used to print the command instead), so the claude CLI does it.
 *
 * Idempotent and non-destructive: an existing registration is detected
 * via `claude mcp get thatch` (exit 1 when absent) and left untouched,
 * whatever scope or binary it points at. `claudeBin` and `run` are
 * injectable for tests; when `claude` is missing the result says so and
 * the manual command stands in.
 */
export async function registerClaudeMcpServer(
  thatchBin: string,
  opts: {
    claudeBin?: string | null;
    run?: (argv: string[]) => Promise<CommandRunResult>;
  } = {},
): Promise<ClaudeMcpRegistration> {
  const claudeBin = opts.claudeBin === undefined ? Bun.which("claude") : opts.claudeBin;
  const manualCommand = `claude mcp add --scope user thatch -- ${thatchBin} mcp`;
  const run = opts.run ?? defaultCommandRun;
  if (!claudeBin) {
    return {
      status: "claude-missing",
      manualCommand,
      detail: "claude CLI not found on PATH",
    };
  }
  try {
    const get = await run([claudeBin, "mcp", "get", "thatch"]);
    if (get.exitCode === 0) {
      return {
        status: "already-registered",
        manualCommand,
        detail: "a thatch MCP registration already exists (`claude mcp get thatch` to inspect)",
      };
    }
    const add = await run([claudeBin, "mcp", "add", "--scope", "user", "thatch", "--", thatchBin, "mcp"]);
    if (add.exitCode === 0) {
      return {
        status: "registered",
        manualCommand,
        detail: "registered with `claude mcp add --scope user`",
      };
    }
    return {
      status: "failed",
      manualCommand,
      detail: "`claude mcp add` exited non-zero",
    };
  } catch (err) {
    return {
      status: "failed",
      manualCommand,
      detail: `claude invocation failed: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Cursor setup - .cursor/mcp.json, AGENTS.md, .cursor/hooks.json, skills
// ---------------------------------------------------------------------------

/**
 * Resolve the Cursor config directory. Cursor stores config under `~/.cursor`
 * by default. No documented env override exists (unlike Claude Code's
 * CLAUDE_CONFIG_DIR), but we honor a hypothetical CURSOR_CONFIG_DIR for
 * symmetry and forward-compatibility.
 */
function cursorConfigDir(homeDir: string): string {
  return process.env.CURSOR_CONFIG_DIR ?? join(homeDir, ".cursor");
}

interface CursorSetupPaths {
  mcpConfigPath: string;
  agentsMdPath: string;
  hooksPath: string;
  skillsDir: string;
  global: boolean;
}

function resolveCursorPaths(global: boolean, projectDir: string, homeDir: string): CursorSetupPaths {
  const configDir = cursorConfigDir(homeDir);

  if (global) {
    return {
      // Cursor's global MCP config is a simple file - no equivalent of
      // `claude mcp add --scope user`. Writing ~/.cursor/mcp.json is enough.
      mcpConfigPath: join(configDir, "mcp.json"),
      agentsMdPath: join(configDir, "AGENTS.md"),
      hooksPath: join(configDir, "hooks.json"),
      // Global installs put skills where every project can read them.
      skillsDir: join(configDir, "skills"),
      global: true,
    };
  }

  return {
    mcpConfigPath: join(projectDir, ".cursor", "mcp.json"),
    agentsMdPath: join(projectDir, "AGENTS.md"),
    hooksPath: join(projectDir, ".cursor", "hooks.json"),
    // Project-local installs keep skills in the repo; Cursor auto-discovers
    // project skills at .cursor/skills/.
    skillsDir: join(projectDir, ".cursor", "skills"),
    global: false,
  };
}

/**
 * Cursor hooks use a flat format (no nesting, no `type` field):
 * { "version": 1, "hooks": { "event": [{ "command": "..." }] } }
 */
interface CursorHooksJson {
  version: number;
  hooks: {
    [event: string]: { command: string }[];
  };
  [key: string]: unknown;
}

function writeCursorHooks(path: string, thatchBin: string): void {
  let config: CursorHooksJson = { version: 1, hooks: {} };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupt - start fresh.
    }
  }
  if (!config.version) config.version = 1;
  if (!config.hooks) config.hooks = {};

  // --json makes reminder output { additional_context: "..." } which Cursor
  // injects into the session. Without --json, stdout is plain text (Claude
  // Code style) and Cursor would not parse it.
  const sessionStartCmd = `${thatchBin} reminder --json`;
  // postToolUse fires per-tool (Cursor has no PostToolBatch equivalent).
  // Silent - no stdout - so the agent loop is not delayed.
  const bufferCmd = `${thatchBin} buffer-tool`;
  // beforeSubmitPrompt is Cursor's UserPromptSubmit equivalent. Drains the
  // queue and prints the extraction nudge as JSON additional_context.
  const flushCmd = `${thatchBin} flush-tools --json`;
  // stop fires when the agent loop ends. chat-notify emits followup_message
  // (auto-submitted by Cursor as the next user message) when chat mail is
  // unread - the Cursor analog of opencode's poller wake. loop_limit bounds
  // consecutive auto-followups; reading the mail naturally terminates the
  // loop (unread drops to 0), the limit is the backstop.
  const notifyCmd = `${thatchBin} chat-notify`;

  config.hooks.sessionStart = replaceCursorThatchHooks(config.hooks.sessionStart ?? [], sessionStartCmd);
  config.hooks.postToolUse = replaceCursorThatchHooks(config.hooks.postToolUse ?? [], bufferCmd);
  config.hooks.beforeSubmitPrompt = replaceCursorThatchHooks(config.hooks.beforeSubmitPrompt ?? [], flushCmd);
  config.hooks.stop = replaceCursorThatchHooks(config.hooks.stop ?? [], notifyCmd, 3);

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

function replaceCursorThatchHooks(
  entries: { command: string; loop_limit?: number }[],
  command: string,
  loopLimit?: number,
): { command: string; loop_limit?: number }[] {
  const filtered = entries.filter((e) => !e.command?.includes("thatch"));
  filtered.push(loopLimit === undefined ? { command } : { command, loop_limit: loopLimit });
  return filtered;
}

export interface CursorSetupResult {
  mcpConfig: string;
  agentsMd: string;
  hooks: string;
  /** Skill install report for the directory this run wrote to. */
  skills: InstallReport;
  /** Thatch skills in the opposite scope's dir, if any; never written by this run. */
  otherScopeSkills: OtherScopeSkills | null;
  global: boolean;
}

/**
 * Installs thatch into Cursor. Writes .cursor/mcp.json (or ~/.cursor/mcp.json
 * for global), appends instructions to AGENTS.md, installs sessionStart +
 * postToolUse + beforeSubmitPrompt hooks in .cursor/hooks.json, and installs
 * skill files. All operations are idempotent.
 *
 * Cursor's global MCP config is a simple file write (unlike Claude Code which
 * needs `claude mcp add --scope user`). Skills follow the install scope:
 * project-local runs write them to the repo's .cursor/skills/, global runs to
 * the Cursor config dir's skills/ (Cursor also reads .claude/skills/ dirs
 * for compatibility).
 *
 * @param thatchBin Absolute path to the thatch binary
 * @param global Whether to install globally or project-locally
 * @param projectDir The project directory (used for project-local installs)
 * @param homeDir Home directory (defaults to os.homedir())
 */
export function setupCursor(
  thatchBin: string,
  global: boolean,
  projectDir: string,
  homeDir?: string,
): CursorSetupResult {
  const { homedir } = require("node:os");
  const home = homeDir ?? homedir();
  const paths = resolveCursorPaths(global, projectDir, home);

  writeMcpConfig(paths.mcpConfigPath, thatchBin, global ? undefined : projectDir);
  appendCursorInstructions(paths.agentsMdPath);
  writeCursorHooks(paths.hooksPath, thatchBin);
  const skills = installSkills(paths.skillsDir);

  // Same other-scope logic as the Claude path: surface skills this run did
  // not touch so the CLI can warn about leftovers.
  const otherDir = global
    ? join(projectDir, ".cursor", "skills")
    : join(cursorConfigDir(home), "skills");

  return {
    mcpConfig: paths.mcpConfigPath,
    agentsMd: paths.agentsMdPath,
    hooks: paths.hooksPath,
    skills,
    otherScopeSkills: otherScopeInfo(otherDir),
    global,
  };
}

// ---------------------------------------------------------------------------
// Skills-only setup - refresh skill files without touching anything else
// ---------------------------------------------------------------------------

export interface SkillsOnlyResult {
  /** Skill install report for the directory this run wrote to. */
  skills: InstallReport;
  /** Thatch skills in the opposite scope's dir, if any; never written by this run. */
  otherScopeSkills: OtherScopeSkills | null;
  global: boolean;
}

/**
 * Installs only the skill files, skipping MCP config, instructions, hooks,
 * and commands. Intended for refreshing skills in an already-set-up host
 * without rewriting the rest of the configuration. Same scope rules as full
 * setup: project-local runs write to the repo's host skills dir, global runs
 * to the host config dir, and the other scope is probed (surfaced in the
 * report) but never written.
 */
export function setupSkillsOnly(
  host: HostKind,
  global: boolean,
  projectDir: string,
  homeDir?: string,
): SkillsOnlyResult {
  const { homedir } = require("node:os");
  const home = homeDir ?? homedir();

  const skillsDir = host === "claude"
    ? resolvePaths(global, projectDir, home).skillsDir
    : resolveCursorPaths(global, projectDir, home).skillsDir;

  // Same other-scope logic as the full setup paths: surface skills this run
  // did not touch so the CLI can warn about leftovers.
  const otherDir = host === "claude"
    ? (global
      ? join(projectDir, ".claude", "skills")
      : join(claudeConfigDir(home), "skills"))
    : (global
      ? join(projectDir, ".cursor", "skills")
      : join(cursorConfigDir(home), "skills"));

  return {
    skills: installSkills(skillsDir),
    otherScopeSkills: otherScopeInfo(otherDir),
    global,
  };
}

// ---------------------------------------------------------------------------
// Setup detection - check whether setup was completed for the current host
// ---------------------------------------------------------------------------

export type HostKind = "claude" | "cursor";

export type SetupStatus =
  | { status: "installed"; scope: "local" | "global"; host: HostKind; regime?: "plugin" }
  | { status: "not-installed"; host: HostKind; message: string }
  | { status: "markers-broken"; host: HostKind; file: string; message: string };

type FileCheck = "installed" | "absent" | "broken";

function checkInstructionsFile(path: string, legacyStartMarker: string, legacyEndMarker: string): FileCheck {
  if (!existsSync(path)) return "absent";
  const content = readFileSync(path, "utf8");
  // Current format: sentinel-delimited. Begin without end is the same
  // corruption class as the legacy broken case.
  const sentinelIdx = content.indexOf(THATCH_BEGIN);
  if (sentinelIdx !== -1) {
    return content.indexOf(THATCH_END, sentinelIdx) === -1 ? "broken" : "installed";
  }
  // Legacy format: prose-sentence delimiters.
  const startIdx = content.indexOf(legacyStartMarker);
  if (startIdx === -1) return "absent";
  const endIdx = content.indexOf(legacyEndMarker, startIdx);
  if (endIdx === -1) return "broken";
  return "installed";
}

/**
 * Detects the host from env vars (CURSOR_PROJECT_DIR for Cursor,
 * CLAUDE_PROJECT_DIR for Claude Code) and checks whether `thatch setup` was
 * run for that host. Checks local instructions (in the project dir) first,
 * then global (in the config dir). Returns null if the host cannot be
 * determined (neither env var is set - e.g. manual `thatch mcp` invocation).
 */
export function checkSetup(projectDir: string, homeDir?: string): SetupStatus | null {
  const home = homeDir ?? process.env.HOME ?? "/tmp";
  const isCursor = !!process.env.CURSOR_PROJECT_DIR;
  const isClaude = !!process.env.CLAUDE_PROJECT_DIR && !isCursor;
  if (!isCursor && !isClaude) return null;

  const host: HostKind = isCursor ? "cursor" : "claude";

  if (host === "claude") {
    return checkClaudeSetup(projectDir, home);
  }
  return checkCursorSetup(projectDir, home);
}

function checkClaudeSetup(projectDir: string, home: string): SetupStatus {
  const configDir = claudeConfigDir(home);

  // The regime marker outranks the marker files: a plugin-regime install
  // DELETES the fallback markers on purpose, so "absent" would misreport
  // an installed plugin as not-installed. Scope follows the plugin
  // directory's location (global config dir vs the project's .claude/).
  if (readRegimeMarker(thatchDbPath(home)) === "plugin") {
    const scope = existsSync(join(claudeConfigDir(home), "thatch-plugin")) ? "global" : "local";
    return { status: "installed", scope, host: "claude", regime: "plugin" };
  }

  const localMd = join(projectDir, "CLAUDE.md");
  const localCheck = checkInstructionsFile(localMd, THATCH_MARKER, THATCH_END_MARKER);
  if (localCheck === "installed") return { status: "installed", scope: "local", host: "claude" };
  if (localCheck === "broken") {
    return {
      status: "markers-broken",
      host: "claude",
      file: localMd,
      message: `Thatch's instructions in ${localMd} have corrupted markers: the start marker was found but the end marker is missing. This usually happens when the file was edited externally and the thatch block was partially modified. Tell the user to fix this by running: thatch setup --claude. If that doesn't resolve it, they may need to manually remove the corrupted thatch block from ${localMd} and re-run setup.`,
    };
  }

  const globalMd = join(configDir, "CLAUDE.md");
  const globalCheck = checkInstructionsFile(globalMd, THATCH_MARKER, THATCH_END_MARKER);
  if (globalCheck === "installed") return { status: "installed", scope: "global", host: "claude" };
  if (globalCheck === "broken") {
    return {
      status: "markers-broken",
      host: "claude",
      file: globalMd,
      message: `Thatch's instructions in ${globalMd} have corrupted markers: the start marker was found but the end marker is missing. This usually happens when the file was edited externally and the thatch block was partially modified. Tell the user to fix this by running: thatch setup --claude --global. If that doesn't resolve it, they may need to manually remove the corrupted thatch block from ${globalMd} and re-run setup.`,
    };
  }

  return {
    status: "not-installed",
    host: "claude",
    message: "Thatch is running as an MCP server but has not been set up for Claude Code. The instructions that tell you how to use thatch's memory tools are missing from CLAUDE.md. Tell the user to run: thatch setup --claude",
  };
}

function checkCursorSetup(projectDir: string, home: string): SetupStatus {
  const configDir = cursorConfigDir(home);

  const localMd = join(projectDir, "AGENTS.md");
  const localCheck = checkInstructionsFile(localMd, CURSOR_MARKER, CURSOR_END_MARKER);
  if (localCheck === "installed") return { status: "installed", scope: "local", host: "cursor" };
  if (localCheck === "broken") {
    return {
      status: "markers-broken",
      host: "cursor",
      file: localMd,
      message: `Thatch's instructions in ${localMd} have corrupted markers: the start marker was found but the end marker is missing. This usually happens when the file was edited externally and the thatch block was partially modified. Tell the user to fix this by running: thatch setup --cursor. If that doesn't resolve it, they may need to manually remove the corrupted thatch block from ${localMd} and re-run setup.`,
    };
  }

  const globalMd = join(configDir, "AGENTS.md");
  const globalCheck = checkInstructionsFile(globalMd, CURSOR_MARKER, CURSOR_END_MARKER);
  if (globalCheck === "installed") return { status: "installed", scope: "global", host: "cursor" };
  if (globalCheck === "broken") {
    return {
      status: "markers-broken",
      host: "cursor",
      file: globalMd,
      message: `Thatch's instructions in ${globalMd} have corrupted markers: the start marker was found but the end marker is missing. This usually happens when the file was edited externally and the thatch block was partially modified. Tell the user to fix this by running: thatch setup --cursor --global. If that doesn't resolve it, they may need to manually remove the corrupted thatch block from ${globalMd} and re-run setup.`,
    };
  }

  return {
    status: "not-installed",
    host: "cursor",
    message: "Thatch is running as an MCP server but has not been set up for Cursor. The instructions that tell you how to use thatch's memory tools are missing from AGENTS.md. Tell the user to run: thatch setup --cursor",
  };
}
