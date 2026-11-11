import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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
/** Claude's config dir, honoring CLAUDE_CONFIG_DIR. Exported for the
 *  doctor, which resolves the same paths setup writes to. */
export function claudeConfigDir(homeDir: string): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homeDir, ".claude");
}

/** The Claude Code release that introduced mods - the plugin regime's
 *  floor: this is the first version whose in-process plugin surface can
 *  load the generated mod at all. Older builds get the hooks regime. */
export const CLAUDE_MODS_FLOOR = "2.1.287";

/**
 * Reports whether `claude --version` output meets the mods floor. Null
 * (claude not installed or not runnable) and unparseable output both read
 * as SUPPORTED: the plugin regime is the front door, and `thatch doctor`
 * (the on-demand diagnostic) plus the bundled server's staleness warning
 * are the safety nets that name the --hooks opt-out when the assumption
 * is wrong.
 */
export function claudeVersionSupportsMods(versionOutput: string | null): boolean {
  if (versionOutput === null) return true;
  const m = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return true;
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  const floor = CLAUDE_MODS_FLOOR.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (got[i]! > floor[i]!) return true;
    if (got[i]! < floor[i]!) return false;
  }
  return true;
}

/** Reads the installed claude CLI's --version output; null when claude is
 *  not on PATH or fails to run. */
export function claudeVersionOutput(): string | null {
  if (!Bun.which("claude")) return null;
  try {
    const r = Bun.spawnSync(["claude", "--version"], { stdout: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
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
 * Detects whether a file carries a thatch instructions block in either
 * format (current sentinels or legacy prose). The doctor's detect-only
 * read of the legacy home-root ~/CLAUDE.md: a block there is stale advice
 * naming tool spellings the reader's regime may not have. Removal stays
 * in setup (removeLegacyInstructionsBlock); this never writes.
 */
export function hasThatchInstructionsBlock(path: string): boolean {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  return content.includes(THATCH_BEGIN) || content.includes(THATCH_MARKER);
}

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
 * Removes the thatch instructions block (sentinel format, or a legacy
 * pre-sentinel prose block) from a file - the migration's cleanup for the
 * LEGACY home-root ~/CLAUDE.md: the old setup era wrote instructions
 * there, and any session whose cwd is under $HOME loads it as a
 * parent-dir CLAUDE.md - a stale block naming the standalone tool
 * spellings contradicts the plugin session's real tool names.
 *
 * Removal rules (the writer's twin): sentinel blocks remove by span;
 * intact legacy prose blocks remove by the legacy markers; a BROKEN
 * legacy block (the em-dash corruption class) removes to EOF only when
 * the heal guard says the tail is recognizably the instructions -
 * otherwise leave it for manual repair (never eat user content). Deletes
 * the file when nothing but whitespace remains. Returns true when
 * something was removed.
 */
function removeLegacyInstructionsBlock(path: string): boolean {
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, "utf8");
  let startIdx = -1;
  let endLen = 0;
  const beginIdx = existing.indexOf(THATCH_BEGIN);
  if (beginIdx >= 0) {
    const endIdx = existing.indexOf(THATCH_END, beginIdx);
    if (endIdx < 0) return false; // broken sentinels: checkSetup's report
    startIdx = beginIdx;
    endLen = endIdx + THATCH_END.length - beginIdx;
  } else if (existing.includes(THATCH_MARKER)) {
    const legacyStart = existing.indexOf(THATCH_MARKER);
    const legacyEnd = existing.indexOf(THATCH_END_MARKER, legacyStart);
    if (legacyEnd >= 0) {
      startIdx = legacyStart;
      endLen = legacyEnd + THATCH_END_MARKER.length - legacyStart;
    } else {
      // Broken legacy block: the writer's heal guard, empty block.
      return healBrokenBlock(path, existing, legacyStart, "");
    }
  }
  if (startIdx < 0) return false; // no thatch block of either format
  const rest = (existing.slice(0, startIdx) + existing.slice(startIdx + endLen)).trim();
  if (rest) writeFileSync(path, rest + "\n");
  else rmSync(path);
  return true;
}

/**
 * Ensures the CLAUDE.md instructions block for the PLUGIN regime in a
 * project directory - idempotent (appendBlock replaces the sentinel
 * block), with the plugin variant's tool spelling. The bundled server
 * calls this at startup: in the front-door world (a marketplace install,
 * no `thatch setup` run) the server is the only thatch process that knows
 * the project and can write the block - the guard-proof instructions
 * channel the mod cannot deliver (the guard passes over user mods'
 * prompt.compose hooks).
 */
export function ensurePluginInstructions(projectDir: string): void {
  appendBlock(join(projectDir, "CLAUDE.md"), claudeInstructions("plugin"), THATCH_MARKER, THATCH_END_MARKER);
}

/**
 * The bundled-server entry of a generated plugin manifest: how the
 * plugin's own MCP server is launched. Two worlds, two entries. The
 * setup-generated plugin launches the GENERATING checkout's binary
 * (thatchBin, pinning THATCH_PROJECT_DIR for project-local installs). The
 * npm package's plugin - generated by scripts/prepack.ts - launches the
 * SHIPPED binary as `bun ${CLAUDE_PLUGIN_ROOT}/bin/thatch mcp
 * --bundled`: the installed copy has no `thatch` on PATH and no
 * project dir to pin, and Claude Code substitutes
 * ${CLAUDE_PLUGIN_ROOT} with the installed plugin's cache directory.
 */
export interface PluginServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Writes the loadable Claude Code plugin tree into a directory:
 * .claude-plugin/plugin.json (the manifest, bundling the MCP server),
 * hooks/hooks.json (the modules list - what makes the plugin a mod),
 * hooks/register.js (thin shim binding the rendered instructions),
 * hooks/instructions.js (the ONE-TEMPLATE system prompt, generated from
 * src/prompts.ts so it cannot drift from the fallback regime's
 * rendering), and hooks/mod.js (the bundled mod logic, built with the
 * browser target so any node: import in its graph fails the build - the
 * mods runtime gives hooks no Node APIs).
 *
 * Shared by setup's plugin-regime install (the generated dir under
 * $CLAUDE_CONFIG_DIR or .claude/) and the npm package's prepack step
 * (the package root), so the two trees cannot drift; the server entry is
 * the one caller-specific part.
 */
export async function writePluginTree(pluginDir: string, server: PluginServerEntry): Promise<void> {
  const hooksDir = join(pluginDir, "hooks");
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(hooksDir, { recursive: true });

  const manifest = {
    $schema: "https://anthropic.com/claude-code/plugin.schema.json",
    name: "thatch",
    version: pkg.version,
    description: "Thatch memory, extraction, and cross-session chat for Claude Code.",
    author: { name: "Jeff Ober", url: "https://github.com/sysread/thatch" },
    license: "MIT",
    mcpServers: {
      thatch: { type: "stdio", ...server },
    },
  };
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(
    join(hooksDir, "hooks.json"),
    JSON.stringify({ description: "The thatch hooks module", modules: ["./register.js"] }, null, 2) + "\n",
  );
  writeFileSync(
    join(hooksDir, "register.js"),
    `// Generated by thatch (setup, or prepack for the npm package) - do not edit.
import { registerMod as thatchRegister } from "./mod.js";
import { INSTRUCTIONS } from "./instructions.js";

export function register(on) {
  return thatchRegister(on, {
    instructions: INSTRUCTIONS,
    serverKey: "thatch",
    stageTool: "plugin_stage",
    lifecycleTool: "plugin_lifecycle",
    chatWakeTool: "plugin_chat_wake",
    watchPollTool: "plugin_watch_poll",
  });
}
`,
  );
  writeFileSync(
    join(hooksDir, "instructions.js"),
    // The PLUGIN regime's variant: it teaches the watch tools as available
    // and wake delivery as working - the opposite of the hooks-regime
    // wording, which this regime's deactivation just removed.
    `// Generated by thatch (setup, or prepack for the npm package) - do not edit.\n` +
      `export const INSTRUCTIONS = ${JSON.stringify(claudeInstructions("plugin"))};\n`,
  );

  // The mod bundle: browser target - a node: import anywhere in the mod's
  // graph fails HERE (at generation) instead of at load in Claude Code.
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
}

/**
 * Installs the Claude Code PLUGIN regime: generates the plugin directory
 * (writePluginTree - manifest + bundled MCP server + mod) and deactivates
 * the fallback regime's writers (settings hooks, CLAUDE.md block,
 * standalone MCP config). Opt-in must deactivate, or both regimes deliver
 * every prompt - the fallback's auto-refresh would resurrect hooks this
 * run removed.
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
  // SOURCE-CONSISTENCY GUARD: the generated plugin mixes two sources - the
  // mod + instructions render from THIS checkout, and the manifest's server
  // command launches thatchBin. A bin whose tree lacks the plugin-regime
  // feature (a global symlink to a checkout without src/claude-plugin, the
  // mixed-source install bug) would run a server with no plugin_stage, and
  // the mod's fail-open would darken every pin silently. Fail HERE, loudly,
  // where the human running setup can see it. A bin that cannot be resolved
  // (tests pass fake paths) skips the guard - a nonexistent command fails
  // loudly at launch instead, in the host's plugin Errors tab.
  try {
    const binTree = dirname(realpathSync(thatchBin));
    if (!existsSync(join(binTree, "..", "src", "claude-plugin", "mod.ts"))) {
      throw new Error(
        `refusing to install the plugin regime from "${thatchBin}": its checkout has no src/claude-plugin (the plugin-regime feature). ` +
          `The generated mod would come from this checkout while the bundled server launched that stale binary - a mixed-source install whose stage calls all fail silently. ` +
          `Run setup from the checkout you are testing (bun bin/thatch setup --claude --dev).`,
      );
    }
  } catch (err) {
    // A nonexistent bin skips the guard (tests use fake paths); any OTHER
    // error - including this guard's own refusal - propagates.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  const pluginDir = global
    ? join(claudeConfigDir(home), "thatch-plugin")
    : join(projectDir, ".claude", "thatch-plugin");
  // Manifest: the plugin's OWN MCP server is the bundled one - no
  // `claude mcp add` / .mcp.json entry in this regime. Project-local runs
  // pin THATCH_PROJECT_DIR (same rule as the standalone config).
  await writePluginTree(pluginDir, {
    command: thatchBin,
    args: ["mcp", "--bundled"],
    ...(global ? {} : { env: { THATCH_PROJECT_DIR: projectDir } }),
  });

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
  // Instructions are NOT deactivated: the mod has no prompt.compose (the
  // guard passes over user mods' compose hooks), so the CLAUDE.md static
  // block is the ONLY instructions channel - ensured here with the PLUGIN
  // variant's tool spelling, in BOTH scopes (whichever CLAUDE.md the
  // session reads). Idempotent: appendBlock replaces the sentinel block.
  appendBlock(join(projectDir, "CLAUDE.md"), claudeInstructions("plugin"), THATCH_MARKER, THATCH_END_MARKER);
  if (global) appendBlock(join(claudeConfigDir(home), "CLAUDE.md"), claudeInstructions("plugin"), THATCH_MARKER, THATCH_END_MARKER);
  // The LEGACY home-root ~/CLAUDE.md: the old setup era wrote instructions
  // there, and any session whose cwd is under $HOME loads it as a
  // parent-dir CLAUDE.md - a stale block naming tools the plugin session
  // does not have (observed live: the QA "double registration" ghost).
  // The migration REMOVES it (the instructions live in the config-dir/
  // project blocks now); broken blocks go through the heal guard, and a
  // removal is reported so the user knows what changed.
  const legacyHomeMd = join(home, "CLAUDE.md");
  if (removeLegacyInstructionsBlock(legacyHomeMd)) {
    deactivated.push(`legacy instructions block removed: ${legacyHomeMd}`);
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
 * symmetry and forward-compatibility. Exported for the doctor, which
 * resolves the same paths setup writes to.
 */
export function cursorConfigDir(homeDir: string): string {
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
 * determined (neither env var is set - e.g. manual `thatch mcp`
 * invocation). The optional `host` argument skips env detection and checks
 * that host directly - the doctor's use: it examines every host
 * deliberately, from a terminal where no host env vars are set.
 */
export function checkSetup(projectDir: string, homeDir?: string, host?: HostKind): SetupStatus | null {
  const home = homeDir ?? process.env.HOME ?? "/tmp";
  const resolvedHost: HostKind | null =
    host ?? (process.env.CURSOR_PROJECT_DIR ? "cursor" : process.env.CLAUDE_PROJECT_DIR ? "claude" : null);
  if (!resolvedHost) return null;

  if (resolvedHost === "cursor") {
    return checkCursorSetup(projectDir, home);
  }
  return checkClaudeSetup(projectDir, home);
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
