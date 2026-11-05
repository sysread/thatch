/**
 * The setup command: installs config, instructions, hooks, skills, and
 * commands for a host (Claude Code / Cursor) or an explicit directory.
 * Was a case of bin/thatch's switch before the registry replaced it.
 */
import { join, resolve } from "node:path";
import { setupClaudeCode, setupCursor, setupSkillsOnly, registerClaudeMcpServer, thatchMcpServerEntry, type OtherScopeSkills } from "../../setup";
import { installSkills, type InstallReport } from "../../skills";
import { installCommandsToDir, opencodeCommandDefs } from "../../commands";
import { projectDir } from "../context";
import type { Subcommand } from "../types";

export const setup: Subcommand = {
  name: "setup",
  summary: "Install config + instructions + hooks + skills",
  usage: () => ({
    synopsis: "thatch setup --claude [--cursor] [--local|--global] [--skills-only [dir]]",
    flags: [
      { long: "--claude", short: null, description: "Set up Claude Code." },
      { long: "--cursor", short: null, description: "Set up Cursor." },
      { long: "--local", short: null, description: "Project-local scope; the default." },
      { long: "--global", short: null, description: "User-global scope." },
      { long: "--skills-only", short: null, description: "Refresh just the skill files. With an explicit directory, installs the skills into that directory (no host flag needed)." },
      { long: "--commands-only", short: null, description: "Install the command files into <dir>/thatch/ for any harness (complete formal command files; no host flag; --global is rejected)." },
      { long: "--mcp-json", short: null, description: "Print the MCP server config as JSON on stdout (can be combined with other setup flags; writes nothing, stdout carries only the JSON when set)." },
    ],
  }),
  async run(args) {
    const isGlobal = args.includes("--global");
    // --local is the default scope; accepted explicitly so the flag the
    // user types always matches what the command does.
    const isLocal = args.includes("--local");
    const isClaude = args.includes("--claude");
    const isCursor = args.includes("--cursor");
    // --skills-only narrows the run to the skill install: same host and
    // scope rules, but MCP config, instructions, hooks, and commands are
    // left untouched. With an explicit directory it instead installs into
    // that directory for any harness that reads a skills dir: host and
    // scope selection does not apply. A host flag (--claude, --cursor) or
    // --local only names a default skills location, and the directory
    // replaces it, so the flag is ignored with a note. --global claims a
    // scope the explicit directory cannot have, so it is refused.
    const skillsOnlyIdx = args.indexOf("--skills-only");
    const skillsOnlyEq = args.find((a) => a.startsWith("--skills-only="));
    const skillsOnly = skillsOnlyIdx !== -1 || skillsOnlyEq !== undefined;
    // The directory value is parsed by hand (not flagValue) because the
    // bare flag is meaningful, same as --stale. The --skills-only=<dir>
    // form is honored too; a token starting with -- is always a sibling
    // flag, never the directory.
    const eqValue = skillsOnlyEq?.slice("--skills-only=".length);
    const bareNext = skillsOnlyIdx !== -1 ? args[skillsOnlyIdx + 1] : undefined;
    const skillsTarget = eqValue || (bareNext && !bareNext.startsWith("--") ? bareNext : null);
    const customSkillsDir = skillsTarget ? resolve(process.cwd(), skillsTarget) : null;
    // --mcp-json prints the MCP server entry as JSON on stdout for hosts
    // thatch does not configure itself. It writes nothing and the entry
    // itself is host-agnostic, so it needs no host flag: it is valid
    // alone and can be combined with any other setup run.
    const mcpJson = args.includes("--mcp-json");
    // When --mcp-json is set, stdout carries only the JSON so scripts can
    // pipe it; human-readable output goes to stderr. Error paths keep
    // console.error in both modes: errors are never stdout data.
    const say = mcpJson ? console.error : console.log;

    if (isGlobal && isLocal) {
      console.error("Choose one scope: --local or --global.");
      process.exit(1);
    }
    if (customSkillsDir && isGlobal) {
      console.error("A directory passed to --skills-only cannot be combined with --global.");
      process.exit(1);
    }
    // --commands-only <dir>: install the command files into <dir>/thatch/ for
    // any harness that reads a commands dir (the steal-them path: the files
    // are complete, formal command documents). Directory form only - the
    // host setup paths already sync commands in their full runs.
    const commandsOnlyEq = args.find((a) => a.startsWith("--commands-only="));
    const commandsOnlyIdx = args.indexOf("--commands-only");
    const commandsTarget = commandsOnlyEq?.slice("--commands-only=".length) ?? (commandsOnlyIdx !== -1 && args[commandsOnlyIdx + 1] && !args[commandsOnlyIdx + 1].startsWith("--") ? args[commandsOnlyIdx + 1] : undefined);
    const commandsOnly = commandsOnlyIdx !== -1 || commandsOnlyEq !== undefined;
    if (commandsOnly && !commandsTarget) {
      console.error("--commands-only needs a directory: thatch setup --commands-only <dir>");
      process.exit(1);
    }
    if (commandsOnly && isGlobal) {
      console.error("A directory passed to --commands-only cannot be combined with --global.");
      process.exit(1);
    }
    const customCommandsDir = commandsTarget ? resolve(process.cwd(), commandsTarget) : null;
    if (skillsOnly && !customSkillsDir && !isClaude && !isCursor) {
      console.error("Specify at least one host: --claude and/or --cursor, or give --skills-only a directory.");
      console.error("Usage: thatch setup --claude [--cursor] [--local|--global] [--skills-only [dir]] [--mcp-json]");
      process.exit(1);
    }
    if (!skillsOnly && !mcpJson && !isClaude && !isCursor && !customCommandsDir) {
      console.error("Specify at least one host: --claude and/or --cursor.");
      console.error("Usage: thatch setup --claude [--cursor] [--local|--global] [--skills-only [dir]] [--mcp-json]");
      process.exit(1);
    }

    // Resolve the thatch binary path for hooks and MCP config.
    // If `thatch` is on PATH (npm global install, opencode plugin install),
    // use the bare name - it survives updates and works across machines.
    // If not on PATH (local dev checkout), use the absolute path to this script.
    const thatchOnPath = Bun.which("thatch");
    const thatchBin = thatchOnPath ?? resolve(process.argv[1] ?? process.execPath);
    const dir = projectDir();

    // Shared reporting: where skills went and what the pass did, so an
    // idempotent re-run still tells the user something true. Closes over
    // `say`, so every setup path follows the --mcp-json stderr routing.
    const printSkills = (result: { skills: InstallReport; otherScopeSkills: OtherScopeSkills | null; global: boolean }) => {
      const { added, updated, removed, unchanged } = result.skills;
      say(`  Skills:        ${result.skills.dir}`);
      say(`                 ${added.length} added, ${updated.length} updated, ${removed.length} removed, ${unchanged.length} unchanged`);
      if (result.otherScopeSkills) {
        const { dir: otherDir, count } = result.otherScopeSkills;
        if (result.global) {
          say(`  Note: ${count} thatch skills exist in ${otherDir} (project scope); --global does not update them.`);
        } else {
          say(`  Note: ${count} thatch skills remain in ${otherDir} (user scope; not updated by this run). Run setup with --global to refresh them, or remove them if this repo now owns its skills.`);
        }
      }
    };

    // A host or scope flag names a default location; an explicit directory
    // replaces it. Keep the run going, but say the flag did nothing.
    if (customSkillsDir && (isClaude || isCursor || isLocal)) {
      say("  Note: host and scope flags have no effect with an explicit skills directory.");
    }
    // Same note when a scope flag names nothing that runs: with no
    // explicit directory and no host flag, the run has nothing to scope,
    // so --local/--global did nothing. A host flag makes the scope real
    // (the install below uses it), so no note in that case. `say` keeps
    // the note off stdout when --mcp-json is set.
    if (!customSkillsDir && !isClaude && !isCursor && mcpJson && (isGlobal || isLocal)) {
      say("  Note: scope flags have no effect with --mcp-json.");
    }

    if (customSkillsDir) {
      // Host-agnostic install: the explicit directory is the only input, so
      // there is no other-scope copy to probe and no host restart note.
      let skills: InstallReport;
      try {
        skills = installSkills(customSkillsDir);
      } catch (err) {
        // installSkills writes each skill file as it goes and does not roll
        // back, so the directory can hold a partial install when we get here.
        console.error(`Error: cannot install skills into ${customSkillsDir}: ${err instanceof Error ? err.message : err}`);
        console.error("Fix the path or permissions and run again; some skill files may already be written.");
        process.exit(1);
      }
      const result = { skills, otherScopeSkills: null, global: false };

      say(`Thatch skills installed to ${customSkillsDir}.`);
      say("");
      printSkills(result);
      say("");
      say(`Point your harness's skills directory at ${customSkillsDir} to pick up the skills.`);
    }

    if (customCommandsDir) {
      // Host-agnostic command install: complete, formal command files into
      // <dir>/thatch/ (the subdirectory preserves the /thatch/ invocation
      // namespace). No other-scope probing and no host restart note - the
      // harness picks the files up on its next command scan.
      let written: string[];
      try {
        written = installCommandsToDir(customCommandsDir);
      } catch (err) {
        console.error(`Error: cannot install commands into ${customCommandsDir}: ${err instanceof Error ? err.message : err}`);
        console.error("Fix the path or permissions and run again; some command files may already be written.");
        process.exit(1);
      }
      say(`Thatch commands installed to ${join(customCommandsDir, "thatch")}.`);
      say(`                 ${written.length} written (${written.length === opencodeCommandDefs().length ? "full set" : "partial"}, the rest were already current)`);
      say("");
      say(`Point your harness's commands directory at ${customCommandsDir} to pick up the commands.`);
    }

    if (isClaude && !customSkillsDir) {
      if (skillsOnly) {
        const result = setupSkillsOnly("claude", isGlobal, dir);

        say(`Thatch skills updated for Claude Code (${isGlobal ? "global" : "project-local"}).`);
        say("");
        printSkills(result);
        say("");
        say("Restart Claude Code for the changes to take effect.");
      } else {
        const result = setupClaudeCode(thatchBin, isGlobal, dir);

        say(`Thatch setup complete for Claude Code (${isGlobal ? "global" : "project-local"}).`);
        say("");
        if (result.mcpConfig) {
          say(`  MCP config:    ${result.mcpConfig}`);
        }
        say(`  Instructions:  ${result.claudeMd}`);
        say(`  Hooks:         ${result.settings}`);
        printSkills(result);
        if (result.commands.length > 0) {
          say(`  Commands:      ${result.commands.length} written (${result.commands.map((p) => p.split("/").pop()).join(", ")})`);
        }
        say("");
        if (result.mcpAddCommand) {
          // Global setup cannot write ~/.claude.json directly, so run the
          // registration on the user's behalf. Idempotent: an existing
          // registration is left alone; a missing or failing claude CLI
          // falls back to printing the manual command.
          const reg = await registerClaudeMcpServer(thatchBin);
          if (reg.status === "registered") {
            say(`  MCP server:    ${reg.detail}`);
          } else if (reg.status === "already-registered") {
            say(`  MCP server:    already registered (claude mcp get thatch to inspect)`);
          } else {
            say("To register the MCP server globally, run:");
            say(`  ${result.mcpAddCommand}`);
            say(`  (${reg.detail})`);
          }
          say("");
        }
        say("Restart Claude Code for the changes to take effect.");
      }
    }

    if (isCursor && !customSkillsDir) {
      if (skillsOnly) {
        const result = setupSkillsOnly("cursor", isGlobal, dir);

        say("");
        say(`Thatch skills updated for Cursor (${isGlobal ? "global" : "project-local"}).`);
        say("");
        printSkills(result);
        say("");
        say("Restart Cursor for the changes to take effect.");
      } else {
        const result = setupCursor(thatchBin, isGlobal, dir);

        say("");
        say(`Thatch setup complete for Cursor (${isGlobal ? "global" : "project-local"}).`);
        say("");
        say(`  MCP config:    ${result.mcpConfig}`);
        say(`  Instructions:  ${result.agentsMd}`);
        say(`  Hooks:         ${result.hooks}`);
        printSkills(result);
        say("");
        say("Restart Cursor for the changes to take effect.");
      }
    }

    // The printed entry is deliberately unpinned: the user chooses where to
    // paste it, and one entry may serve many projects. A pinned
    // THATCH_PROJECT_DIR in a global config would force that one project
    // directory on every project sharing the config (see
    // thatchMcpServerEntry). The server instead resolves the project from
    // the project-directory env vars the host sets, or from its spawn cwd
    // (src/mcp.ts projectDir chain).
    // console.log, not say: `say` is the stderr detour, and this JSON is
    // the one output that must stay on stdout when --mcp-json is set.
    if (mcpJson) {
      console.log(JSON.stringify({ mcpServers: { thatch: thatchMcpServerEntry(thatchBin) } }, null, 2));
    }
  },
};
