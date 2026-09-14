import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Thatch's wrap-up slash commands for opencode, shipped as command markdown
 * files synced into the global opencode config dir (~/.config/opencode/command/
 * thatch/). The plugin writes them on every load so template updates self-heal
 * without a reinstall. Config is loaded before plugins during server startup,
 * so a first-ever install becomes visible on the next start.
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

/** One wrap-up command: the command name (minus the thatch/ prefix) and its full markdown file content. */
export interface CommandDef {
  name: string;
  content: string;
}

/** The wrap-up command set, as full command-file contents ready to write. */
export function opencodeCommandDefs(): CommandDef[] {
  return [
    { name: "compact", content: COMPACT_TEMPLATE },
    { name: "exit", content: EXIT_TEMPLATE },
  ];
}

/**
 * Sync the wrap-up commands into <configHome>/opencode/command/thatch/.
 * Idempotent: each file is written only when its on-disk content differs.
 * Returns the paths that were written (empty when everything was current).
 */
export function installOpencodeCommands(configHome: string): string[] {
  const dir = join(configHome, "opencode", "command", "thatch");
  const written: string[] = [];
  for (const def of opencodeCommandDefs()) {
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
