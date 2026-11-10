/**
 * Process commands: mcp, reminder, hygiene, prime. Each object was a
 * case of bin/thatch's switch before the registry replaced it. The hook
 * helpers are instantiated per run from ctx.dbPath - the CliContext
 * stays free of process-level plumbing.
 */
import { repoPathCache } from "../../db";
import { hygieneReport } from "../../hygiene";
import { claudeSessionStartReminder } from "../../prompts";
import { mcpSessionID } from "../../chat";
import { createHookHelpers } from "../hooks";
import { projectDir } from "../context";
import type { Subcommand } from "../types";

export const mcp: Subcommand = {
  name: "mcp",
  summary: "Start the stdio MCP server (for Claude Code, Cursor, etc.)",
  usage: () => ({
    synopsis: "thatch mcp [--bundled]",
    flags: [
      { long: "--bundled", short: null, description: "Run as the Claude Code plugin regime's bundled component: no sideband socket, no version file, no auto-refresh, no behavior seeding (see McpServerMode in src/mcp.ts). The fallback regime's `thatch mcp` (no flag) stays byte-identical." },
    ],
  }),
  async run(args, ctx) {
    // The MCP server manages its own DB connection; close this one first.
    ctx.db.close();
    const { runMcpServer } = await import("../../mcp");
    await runMcpServer(args.includes("--bundled") ? "bundled" : "standalone");
    // runMcpServer blocks until stdin closes; don't fall through to db.close().
    process.exit(0);
  },
};

export const reminder: Subcommand = {
  name: "reminder",
  summary: "Print session-start reminder (for SessionStart hook)",
  usage: () => ({
    synopsis: "thatch reminder [--json]",
    flags: [{ long: "--json", short: null, description: "Wrap the reminder as { additional_context } for hook hosts." }],
  }),
  async run(args, ctx) {
    const hh = createHookHelpers(ctx.dbPath);
    const isJson = args.includes("--json");
    const repo = await ctx.defaultStore();
    const worktree = projectDir();
    let hygiene: string | null = null;
    try {
      hygiene = await hygieneReport(ctx.db, repo, worktree, repoPathCache(ctx.db));
    } catch (err) {
      console.error(`[thatch] hygiene report failed: ${err}`);
    }
    // Chat mail check. SessionStart DOES pass a session id in the hook's
    // stdin JSON (session_id for Claude Code, conversation_id for Cursor),
    // so a hooked session learns its identity at session start, not only at
    // its first prompt. When no payload is coming (manual runs, bare
    // spawns) the read is skipped and the line keeps the old shape: a line
    // only when pending mail exists for registered sessions in this project.
    const hookInput = await hh.readHookInput("reminder");
    const hookSessionID = (hookInput?.session_id as string | undefined) ?? (hookInput?.conversation_id as string | undefined);
    const chatLine = await hh.chatHookLine(ctx.db, hookSessionID, hookInput?.transcript_path as string | undefined);
    // Claude Code identity anchor: hooks and the MCP server are children of
    // the same claude process, so recording (parent pid -> session) lets the
    // server resolve the caller without trusting the model's `as`. Recorded
    // only for payloads with session_id (Claude Code) - Cursor's hooks come
    // from a shared extension host where ppid is ambiguous. CLAUDE_CODE_
    // SESSION_ID env in the server process is the spawn-time fallback.
    if (hookInput?.session_id && chatLine) {
      try {
        ctx.db.recordChatHostPid(process.ppid, mcpSessionID(String(hookInput.session_id)));
      } catch (err) {
        console.error(`[thatch] chat host-pid anchor failed: ${err}`);
      }
    }
    const reminderBody = claudeSessionStartReminder(repo, hygiene) + (chatLine ? `\n\n${chatLine}` : "");
    if (isJson) {
      console.log(JSON.stringify({ additional_context: reminderBody }));
    } else {
      console.log(reminderBody);
    }
  },
};

export const hygiene: Subcommand = {
  name: "hygiene",
  summary: "Print the hygiene report (standalone)",
  usage: () => ({ synopsis: "thatch hygiene", flags: [] }),
  async run(_args, ctx) {
    const repo = await ctx.defaultStore();
    const worktree = projectDir();
    const report = await hygieneReport(ctx.db, repo, worktree, repoPathCache(ctx.db));
    console.log(report ?? "Store is healthy.");
  },
};

export const prime: Subcommand = {
  name: "prime",
  summary: "Prime project memory (runs the primer skill via opencode, cursor, or claude)",
  usage: () => ({ synopsis: "thatch prime", flags: [] }),
  async run() {
    const primerPrompt = "Load the thatch-project-primer skill and follow its instructions to prime this project's memory store.";
    const opencodeBin = Bun.which("opencode");
    const agentBin = Bun.which("agent");
    const claudeBin = Bun.which("claude");

    if (opencodeBin) {
      console.error("Priming project memory via opencode...");
      const proc = Bun.spawnSync([opencodeBin, "run", primerPrompt], {
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(proc.exitCode ?? 1);
    } else if (agentBin) {
      // Cursor CLI: -p for non-interactive print mode, --approve-mcps to
      // auto-approve the thatch MCP server (no interactive UI in -p mode).
      console.error("Priming project memory via cursor agent...");
      const proc = Bun.spawnSync([agentBin, "-p", primerPrompt, "--approve-mcps"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(proc.exitCode ?? 1);
    } else if (claudeBin) {
      console.error("Priming project memory via claude...");
      const proc = Bun.spawnSync([claudeBin, primerPrompt], {
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(proc.exitCode ?? 1);
    } else {
      console.error("Error: none of 'opencode', 'agent', or 'claude' found on PATH.");
      console.error("Install one of them to use thatch prime.");
      process.exit(1);
    }
  },
};
