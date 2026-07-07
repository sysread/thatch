import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeInstructions } from "./prompts";
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

function appendInstructions(path: string): void {
  const instructions = claudeInstructions() + "\n";

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing.includes(THATCH_MARKER)) {
      // Already has thatch instructions — replace the block.
      const startIdx = existing.indexOf("# Persistence\n\nThatch provides persistent memory across Claude Code sessions.");
      if (startIdx >= 0) {
        const endMarker = '"Forget X" — `memory_recall` to find it, then `memory_forget`.';
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
