import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeInstructions, cursorInstructions } from "./prompts";
import { installSkills, type InstallReport } from "./skills";

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

function writeMcpConfig(path: string, thatchBin: string): void {
  let config: any = { mcpServers: {} };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupt or empty - start fresh.
    }
  }
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers.thatch = {
    type: "stdio",
    command: thatchBin,
    args: ["mcp"],
  };

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
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
  // UserPromptSubmit peeks the queue. With buffered interactions, it prints
  // the extraction nudge carrying the JSON payload; with an empty queue, it
  // falls back to the static write-nudge. Either output is transcript-visible
  // since UserPromptSubmit adds stdout to context.
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
    writeMcpConfig(paths.mcpConfigPath, thatchBin);
  }

  appendInstructions(paths.claudeMdPath);
  writeHooks(paths.settingsPath, thatchBin);
  const skills = installSkills(paths.skillsDir);

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
    otherScopeSkills: otherScopeInfo(otherDir),
    global,
    mcpAddCommand: global
      ? `claude mcp add --scope user thatch -- ${thatchBin} mcp`
      : null,
  };
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

  writeMcpConfig(paths.mcpConfigPath, thatchBin);
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
// Setup detection - check whether setup was completed for the current host
// ---------------------------------------------------------------------------

export type HostKind = "claude" | "cursor";

export type SetupStatus =
  | { status: "installed"; scope: "local" | "global"; host: HostKind }
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
