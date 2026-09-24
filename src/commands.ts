import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defragCore,
  extractionCore,
  hygieneCore,
  mcpToolName,
  opencodeToolName,
  reflectCore,
  type ToolNamer,
} from "./prompts";

/**
 * Thatch's slash commands, shipped as command markdown files synced into each
 * host's command directory:
 *
 * - opencode: ~/.config/opencode/command/thatch/ - synced by the plugin on
 *   every load, so template updates self-heal without a reinstall. Config is
 *   loaded before plugins during server startup, so a first-ever install
 *   becomes visible on the next start.
 * - Claude Code: ~/.claude/commands/thatch/ (or the project's .claude/
 *   commands/thatch/) - synced by `thatch setup --claude`, which has no
 *   plugin to do it on load.
 *
 * Two command families live here:
 *
 * - Actions (/thatch/defrag, extract, hygiene, reflect): user-invoked
 *   wrappers around a behavior that the nudges otherwise only run on their
 *   own schedule. Each action body is a prompt core from src/prompts.ts, so
 *   nudge and command wording cannot drift.
 * - Wrap-ups (/thatch/compact, exit): greenlight-token commands that need
 *   the opencode plugin's TUI control routes, so they are opencode-only.
 */

/** Greenlight token ending /thatch/compact's assistant response when compaction is safe. */
export const COMPACT_READY_TOKEN = "THATCH_COMPACT_READY";

/** Greenlight token ending /thatch/exit's assistant response when exiting is safe. */
export const EXIT_READY_TOKEN = "THATCH_EXIT_READY";

/**
 * The plugin triggers compaction by running the TUI's compact action. The
 * execute-command route only accepts legacy alias names, and "session_compact"
 * maps to the same session.compact action the built-in /compact command runs.
 * There is no exit alias, so the exit path publishes the TUI keymap command
 * ("app.exit") directly via /tui/publish.
 */

const sharedChecklist = `1. Flush pending persistence. Call thatch_get_extraction_payload; if it returns buffered tool interactions, process them now (write any memories worth keeping), then call thatch_extraction_done to mark them complete. Complete any memory writes you promised earlier but have not made.
2. Check for loose ends. Review the conversation for todos, follow-ups, or open questions raised earlier that were never addressed, and surface anything the user should address before the wrap-up completes.`;

const userMessageSection = `# User Message

$ARGUMENTS

(That section carries the text typed after the command. When it is empty, treat the user message as n/a - the command was run bare.)`;

/**
 * One on-demand action: the command name (minus the thatch/ prefix), the
 * description shown in the command menu, and the instruction body (a prompt
 * core). opencodeOnly marks actions that need a session identity or other
 * plugin-only capability; those are excluded from Claude Code command files
 * and MCP prompts.
 */
export interface ActionDef {
  name: string;
  description: string;
  body: string;
  opencodeOnly?: boolean;
}

/**
 * The on-demand action set, shared by every host that renders actions. The
 * bodies come from prompt cores so a wording change lands in the nudge and
 * the command at once. `tool` renders tool names in the host's spelling.
 */
export function actionDefs(tool: ToolNamer): ActionDef[] {
  return [
    {
      name: "defrag",
      description: "Consolidate duplicate and near-duplicate memories in the store",
      body: defragCore(tool),
    },
    {
      name: "extract",
      description: "Drain the extraction queue now",
      // Needs the invoking session's ID (via get_session_info, opencode-only)
      // and the plugin's extraction payload provider.
      opencodeOnly: true,
      body: `First call thatch_get_session_info to learn this session's ID. Below, replace SESSION_ID with that value.

Dispatch a task with background: true and subagent_type: "general" (required for thatch tool access) with this prompt:

"${extractionCore("thatch_get_extraction_payload", "thatch_extraction_done", ' with session_id \\"SESSION_ID\\"')}"

After dispatching, call thatch_extraction_done to acknowledge.`,
    },
    {
      name: "hygiene",
      description: "Tend the memory store: stale entries, orphans, pending dedup pairs",
      body: hygieneCore(),
    },
    {
      name: "reflect",
      description: "Persist what this session learned as memories",
      body: reflectCore(tool),
    },
  ];
}

/** Renders one action as a full command markdown file. */
export function renderActionCommand(action: ActionDef): string {
  return `---
description: ${action.description}
---
${userMessageSection}

# ${action.name.charAt(0).toUpperCase() + action.name.slice(1)}

${action.body}`;
}

const COMPACT_TEMPLATE = `---
description: Flush thatch persistence, check for loose ends, then compact if clear
---
${userMessageSection}

# Pre-compact wrap-up

Work through this checklist before responding:

${sharedChecklist}

Do not start new work beyond this checklist. If every item is handled and nothing needs the user's attention first, end your final response with exactly this token as the very last line, with no formatting around it:

${COMPACT_READY_TOKEN}

If anything is outstanding, list the items concisely so the user can address them, and do NOT include the token. The session will only be compacted when the token is present.`;

const EXIT_TEMPLATE = `---
description: Flush thatch persistence, check for loose ends, then exit opencode if clear
---
${userMessageSection}

# Pre-exit wrap-up

Work through this checklist before responding:

${sharedChecklist}
3. Leave the chat directory. Call thatch_chat_unregister for this session - the session is exiting, so other sessions must stop addressing mail to it.

Do not start new work beyond this checklist. If every item is handled and nothing needs the user's attention first, end your final response with exactly this token as the very last line, with no formatting around it:

${EXIT_READY_TOKEN}

If anything is outstanding, list the items concisely so the user can address them, and do NOT include the token. opencode will only exit when the token is present.`;

/** One command: the command name (minus the thatch/ prefix) and its full markdown file content. */
export interface CommandDef {
  name: string;
  content: string;
}

/**
 * The wrap-up command's prompt body, for hosts that register commands in
 * code (opencode v2 CommandEditor): the execute hook arms the greenlight
 * check and delivers this same text as the session prompt.
 */
export function wrapUpCommandContent(kind: "compact" | "exit"): string {
  return kind === "compact" ? COMPACT_TEMPLATE : EXIT_TEMPLATE;
}

/** The action commands only - no wrap-ups (used where wrap-ups register in code). */
export function opencodeActionCommandDefs(): CommandDef[] {
  return actionDefs(opencodeToolName).map((a) => ({ name: a.name, content: renderActionCommand(a) }));
}

/** The opencode command set: wrap-ups plus every action, as full file contents. */
export function opencodeCommandDefs(): CommandDef[] {
  return [
    { name: "compact", content: COMPACT_TEMPLATE },
    { name: "exit", content: EXIT_TEMPLATE },
    ...opencodeActionCommandDefs(),
  ];
}

/**
 * The Claude Code command set: the actions minus the opencode-only ones.
 * The wrap-up commands are excluded too - their greenlight check needs the
 * plugin's command.execute.before arming and TUI control routes.
 */
export function claudeCommandDefs(): CommandDef[] {
  return actionDefs(mcpToolName)
    .filter((a) => !a.opencodeOnly)
    .map((a) => ({ name: a.name, content: renderActionCommand(a) }));
}

/**
 * Sync command files into dir. Idempotent: each file is written only when
 * its on-disk content differs. Returns the paths that were written (empty
 * when everything was current).
 */
function syncCommandFiles(dir: string, defs: CommandDef[]): string[] {
  const written: string[] = [];
  for (const def of defs) {
    const path = join(dir, `${def.name}.md`);
    let current: string | null = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = null;
    }
    if (current !== def.content) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, def.content);
      written.push(path);
    }
  }
  return written;
}

/**
 * Sync opencode's commands into <configHome>/opencode/command/thatch/.
 * defs overrides the set (hosts whose plugin API registers wrap-up commands
 * in code pass the action-only set - a registered command and a file with
 * the same name would collide).
 */
export function installOpencodeCommands(configHome: string, defs: CommandDef[] = opencodeCommandDefs()): string[] {
  return syncCommandFiles(join(configHome, "opencode", "command", "thatch"), defs);
}

/**
 * Removes wrap-up command files left in the opencode command dir. Hosts
 * that register wrap-up commands in code (v2) pass the action-only set to
 * installOpencodeCommands, but files written by earlier v1 runs persist -
 * syncCommandFiles never removes - and a stale file collides with the
 * registered command (both versions share the config dir). Call this
 * before installing on such hosts. Idempotent: missing files are fine.
 */
export function removeWrapUpCommandFiles(configHome: string): void {
  const dir = join(configHome, "opencode", "command", "thatch");
  for (const kind of ["compact", "exit"] as const) {
    try {
      unlinkSync(join(dir, `${kind}.md`));
    } catch {
      // ENOENT is the expected steady state; anything else is equally
      // harmless for a best-effort cleanup.
    }
  }
}

/** Sync Claude Code's commands into <claudeDir>/commands/thatch/ (claudeDir is ~/.claude or <project>/.claude). */
export function installClaudeCommands(claudeDir: string): string[] {
  return syncCommandFiles(join(claudeDir, "commands", "thatch"), claudeCommandDefs());
}
