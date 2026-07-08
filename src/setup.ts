import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeInstructions, cursorInstructions } from "./prompts";
import { installSkills, type SkillFile } from "./skills";

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
  /** Skills directory (always under the Claude config dir). */
  skillsDir: string;
  /** Whether this is a global install. */
  global: boolean;
}

/**
 * Resolve the Claude config directory. `CLAUDE_CONFIG_DIR` overrides the
 * default `~/.claude` location — used by people running multiple accounts
 * side by side (per Claude Code env-vars docs). Settings, CLAUDE.md, and
 * skills are all stored under this path in global scope. Project-local
 * installs only use it for skills (which are always user-scoped); the
 * project's own .claude/settings.json and CLAUDE.md stay in the repo.
 */
function claudeConfigDir(homeDir: string): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homeDir, ".claude");
}

function resolvePaths(global: boolean, projectDir: string, homeDir: string): SetupPaths {
  const configDir = claudeConfigDir(homeDir);
  const skillsDir = join(configDir, "skills");

  if (global) {
    return {
      mcpConfigPath: null,
      // Per Claude Code settings docs, user-scope CLAUDE.md lives at
      // `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md` when the
      // env var is set) — NOT `~/CLAUDE.md`. Honoring CLAUDE_CONFIG_DIR
      // here also fixes a pre-existing bug where we wrote to `~/CLAUDE.md`.
      claudeMdPath: join(configDir, "CLAUDE.md"),
      settingsPath: join(configDir, "settings.json"),
      skillsDir,
      global: true,
    };
  }

  return {
    mcpConfigPath: join(projectDir, ".mcp.json"),
    claudeMdPath: join(projectDir, "CLAUDE.md"),
    settingsPath: join(projectDir, ".claude", "settings.json"),
    // Skills are always user-scoped, so they always live under the config
    // dir — even when settings and CLAUDE.md are project-local.
    skillsDir,
    global: false,
  };
}

// ---------------------------------------------------------------------------
// .mcp.json — MCP server registration
// ---------------------------------------------------------------------------

function writeMcpConfig(path: string, thatchBin: string): void {
  let config: any = { mcpServers: {} };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupt or empty — start fresh.
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
// CLAUDE.md — append thatch instructions (idempotent)
// ---------------------------------------------------------------------------

const THATCH_MARKER = "# Persistence\n\nThatch provides persistent memory across Claude Code sessions.";
const THATCH_END_MARKER = '"Forget X" — `memory_recall` to find it, then `memory_forget`.';
const CURSOR_MARKER = "# Persistence\n\nThatch provides persistent memory across Cursor sessions.";
const CURSOR_END_MARKER = THATCH_END_MARKER;

/**
 * Idempotently append (or replace) a block of instructions in a markdown file.
 * The block is delimited by startMarker and endMarker so re-running setup
 * updates drifted content without clobbering surrounding text.
 */
function appendBlock(
  path: string,
  instructions: string,
  startMarker: string,
  endMarker: string,
): void {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing.includes(startMarker)) {
      const startIdx = existing.indexOf(startMarker);
      if (startIdx >= 0) {
        const endIdx = existing.indexOf(endMarker, startIdx);
        if (endIdx >= 0) {
          const afterEnd = endIdx + endMarker.length;
          const updated = existing.slice(0, startIdx) + instructions.trimEnd() + existing.slice(afterEnd);
          writeFileSync(path, updated);
          return;
        }
      }
      // Marker found but block boundaries didn't parse — leave it alone.
      return;
    }
    // Append to existing file.
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(path, existing + sep + instructions);
  } else {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, instructions);
  }
}

function appendInstructions(path: string): void {
  appendBlock(path, claudeInstructions() + "\n", THATCH_MARKER, THATCH_END_MARKER);
}

function appendCursorInstructions(path: string): void {
  appendBlock(path, cursorInstructions() + "\n", CURSOR_MARKER, CURSOR_END_MARKER);
}

// ---------------------------------------------------------------------------
// settings.json — hook installation
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
  };
  [key: string]: any;
}

function writeHooks(path: string, thatchBin: string): void {
  let settings: SettingsJson = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupt — start fresh.
    }
  }
  if (!settings.hooks) settings.hooks = {};

  const sessionStartCmd = `${thatchBin} reminder`;
  // PostToolBatch silently buffers tool interactions to the file-backed queue
  // (see src/extract-queue.ts). No stdout — the next model call must not block
  // on a payload that should be invisible to the agent until UserPromptSubmit.
  const bufferCmd = `${thatchBin} buffer-batch`;
  // UserPromptSubmit drains the queue. With buffered interactions, it prints
  // the extraction nudge carrying the JSON payload; with an empty queue, it
  // falls back to the static write-nudge. Either output is transcript-visible
  // since UserPromptSubmit adds stdout to context.
  const flushCmd = `${thatchBin} flush-tools`;

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
// Skills — install to $CLAUDE_CONFIG_DIR/skills/ (or ~/.claude/skills/ by default)
// ---------------------------------------------------------------------------

function installClaudeSkills(skillsDir: string): SkillFile[] {
  return installSkills(skillsDir);
}

// ---------------------------------------------------------------------------
// Main setup entry point
// ---------------------------------------------------------------------------

export interface SetupResult {
  mcpConfig: string | null;
  claudeMd: string;
  settings: string;
  skills: SkillFile[];
  global: boolean;
  /** For global installs, the `claude mcp add` command to run. */
  mcpAddCommand: string | null;
}

/**
 * Installs thatch into Claude Code. Writes MCP config, appends instructions to
 * CLAUDE.md, installs SessionStart + PostToolBatch + UserPromptSubmit hooks,
 * and installs skill files. All operations are idempotent — re-running setup
 * updates content that has drifted without clobbering unrelated configuration.
 *
 * Honors `CLAUDE_CONFIG_DIR` for all user-scoped paths (settings, CLAUDE.md,
 * skills). Project-local installs only use it for skills; the project's own
 * .claude/settings.json and CLAUDE.md stay in the repo.
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
  const skills = installClaudeSkills(paths.skillsDir);

  return {
    mcpConfig: paths.mcpConfigPath,
    claudeMd: paths.claudeMdPath,
    settings: paths.settingsPath,
    skills,
    global,
    mcpAddCommand: global
      ? `claude mcp add --scope user thatch -- ${thatchBin} mcp`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Cursor setup — .cursor/mcp.json, AGENTS.md, .cursor/hooks.json, skills
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
  const skillsDir = join(configDir, "skills");

  if (global) {
    return {
      // Cursor's global MCP config is a simple file — no equivalent of
      // `claude mcp add --scope user`. Writing ~/.cursor/mcp.json is enough.
      mcpConfigPath: join(configDir, "mcp.json"),
      agentsMdPath: join(configDir, "AGENTS.md"),
      hooksPath: join(configDir, "hooks.json"),
      skillsDir,
      global: true,
    };
  }

  return {
    mcpConfigPath: join(projectDir, ".cursor", "mcp.json"),
    agentsMdPath: join(projectDir, "AGENTS.md"),
    hooksPath: join(projectDir, ".cursor", "hooks.json"),
    skillsDir,
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
      // Corrupt — start fresh.
    }
  }
  if (!config.version) config.version = 1;
  if (!config.hooks) config.hooks = {};

  // --json makes reminder output { additional_context: "..." } which Cursor
  // injects into the session. Without --json, stdout is plain text (Claude
  // Code style) and Cursor would not parse it.
  const sessionStartCmd = `${thatchBin} reminder --json`;
  // postToolUse fires per-tool (Cursor has no PostToolBatch equivalent).
  // Silent — no stdout — so the agent loop is not delayed.
  const bufferCmd = `${thatchBin} buffer-tool`;
  // beforeSubmitPrompt is Cursor's UserPromptSubmit equivalent. Drains the
  // queue and prints the extraction nudge as JSON additional_context.
  const flushCmd = `${thatchBin} flush-tools --json`;

  config.hooks.sessionStart = replaceCursorThatchHooks(config.hooks.sessionStart ?? [], sessionStartCmd);
  config.hooks.postToolUse = replaceCursorThatchHooks(config.hooks.postToolUse ?? [], bufferCmd);
  config.hooks.beforeSubmitPrompt = replaceCursorThatchHooks(config.hooks.beforeSubmitPrompt ?? [], flushCmd);

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

function replaceCursorThatchHooks(
  entries: { command: string }[],
  command: string,
): { command: string }[] {
  const filtered = entries.filter((e) => !e.command?.includes("thatch"));
  filtered.push({ command });
  return filtered;
}

export interface CursorSetupResult {
  mcpConfig: string;
  agentsMd: string;
  hooks: string;
  skills: SkillFile[];
  global: boolean;
}

/**
 * Installs thatch into Cursor. Writes .cursor/mcp.json (or ~/.cursor/mcp.json
 * for global), appends instructions to AGENTS.md, installs sessionStart +
 * postToolUse + beforeSubmitPrompt hooks in .cursor/hooks.json, and installs
 * skill files. All operations are idempotent.
 *
 * Cursor's global MCP config is a simple file write (unlike Claude Code which
 * needs `claude mcp add --scope user`). Skills install to ~/.cursor/skills/
 * (auto-discovered by Cursor, which also reads ~/.claude/skills/ for compat).
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
  const skills = installClaudeSkills(paths.skillsDir);

  return {
    mcpConfig: paths.mcpConfigPath,
    agentsMd: paths.agentsMdPath,
    hooks: paths.hooksPath,
    skills,
    global,
  };
}
