import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REVIEW_SPECIALISTS,
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
 * - Actions (/thatch/bug-intake, defrag, extract, hygiene, peer-review,
 *   refine, reflect, self-review, whois): user-invoked commands.
 * - Wrap-ups (/thatch/compact, exit): greenlight-token commands that need
 *   the opencode plugin's host action routes (the compact trigger and the
 *   session close-out), so they are opencode-only.
 *
 * Every body's source text lives in artifacts/commands/<name>.md (the same
 * artifacts layout as skills), NOT in this file. The artifacts are templates:
 * a ${...} placeholder resolves at load time, and an unknown placeholder
 * throws rather than passing through silently (the REVIEW_COMMON lesson -
 * a naive passthrough once spliced the wrong content into skill bodies):
 *
 * - ${TOOL:name} (inline) - the named tool in the host's spelling.
 * - ${CORE:name} (own line) - the prompt core from src/prompts.ts for the
 *   nudge-backed actions, so nudge and command wording cannot drift.
 * - ${COUCHING:name} (own line) - shared text shared by the review-mode
 *   commands (target | pipeline), so those two cannot drift apart.
 * - ${CHECKLIST} (own line) - the wrap-up persistence checklist.
 * - ${TOKEN:name} (inline) - a greenlight token constant.
 */
export const COMMANDS_ARTIFACTS_DIR = join(import.meta.dir, "..", "artifacts", "commands");

/** Greenlight token ending /thatch/compact's assistant response when compaction is safe. */
export const COMPACT_READY_TOKEN = "THATCH_COMPACT_READY";

/** Greenlight token ending /thatch/exit's assistant response when exiting is safe. */
export const EXIT_READY_TOKEN = "THATCH_EXIT_READY";

/**
 * The greenlight token's host action, per host: v1 drives the TUI
 * (compaction via the "session_compact" legacy alias through
 * executeCommand, the exit via the "app.exit" keymap command through
 * /tui/publish). v2 calls session.compact on the plugin's promise domain
 * and emits the session-tab bridge's TUI-only exit-tab-closed event; the
 * runtime records the exiting session's watcher deaths before either host
 * action runs (src/runtime.ts).
 */

const sharedChecklist = `1. Flush pending persistence. Call thatch_get_extraction_payload; if it returns buffered tool interactions, process them now (write any memories worth keeping), then call thatch_extraction_done to mark them complete. Complete any memory writes you promised earlier but have not made.
2. Check for loose ends. Review the conversation for todos, follow-ups, or open questions raised earlier that were never addressed, and surface anything the user should address before the wrap-up completes.`;

const userMessageSection = `# User Message

$ARGUMENTS

(That section carries the text typed after the command. When it is empty, treat the user message as n/a - the command was run bare.)`;

/**
 * How the review-mode commands (peer-review, self-review) run the code
 * review machinery on the host at hand. opencode has the
 * thatch-code-review coordinator skill and sub-agent dispatch; Claude Code
 * and Cursor have neither, so the same procedure runs inline through the
 * shared specialist skills. The mode overlay that differentiates the two
 * commands lives in each command's artifact and applies in both paths:
 * sub-agent briefings on opencode, specialist passes inline elsewhere.
 *
 * Both couchings are spliced into the two artifacts at load so the commands'
 * procedure and target resolution cannot drift; each artifact keeps only its
 * mode rules. The specialist roster and count come from
 * REVIEW_SPECIALISTS in src/prompts.ts, the same source as the install list
 * in src/skills.ts.
 */
const reviewPipelineCouching = `If the thatch-code-review skill is available, load it and follow its steps, with one addition: apply the mode rules below throughout - to context gathering, every specialist briefing, and the synthesis.

If that skill is not available on this host, run the same procedure yourself, in order:
- Resolve the review range. Compute the merge-base against the base branch's remote tracking ref (for example origin/main), not the working branch's own upstream, and cite every file:line against the range's head SHA with git show, never the working tree. A PR or MR number resolves through the host's CLI (gh pr view, glab mr view) plus fetching the head ref (git fetch origin refs/pull/N/head on GitHub, refs/merge-requests/N/head on GitLab, or the source branch). A repository with no remote reviews the working tree's recent commits instead.
- Build the context brief with the thatch-review-context skill.
- Partition large diffs into review units.
- Run the ${REVIEW_SPECIALISTS.length} specialist skills (${REVIEW_SPECIALISTS.join(", ")}) on each unit.
- Synthesize with thatch-review-synthesizer.
The mode rules below apply in every specialist pass and in the synthesis, on every host. If the specialist skills are not installed on this host, tell the user to run thatch setup for it.`;

/**
 * How the review-mode commands resolve what to review. Shared so the two
 * commands accept the same target syntax and default identically.
 */
const reviewTargetCouching = `The user message may name the review target: a branch, a PR or MR number, or a git range. On MCP hosts the Focus: line carries that text instead. If no target is given, review the current branch against its base.`;

/**
 * Line-spliced shared text, resolved for ${COUCHING:name} and ${CHECKLIST}.
 * These exist so text shared across command artifacts is single-sourced in
 * code; the artifacts carry the directive, never a copy.
 */
const lineSplices: Record<string, string> = {
  "COUCHING:target": reviewTargetCouching,
  "COUCHING:pipeline": reviewPipelineCouching,
  CHECKLIST: sharedChecklist,
};

/**
 * The prompt cores for the nudge-backed actions, resolved for ${CORE:name}.
 * The cores live in src/prompts.ts and take the host's tool namer; extract's
 * core is opencode-only (it names the opencode-spelled session tools inside
 * the dispatched sub-agent's prompt), so its tool names are literal.
 */
function coreSplice(name: string, tool: ToolNamer): string {
  switch (name) {
    case "defrag":
      return defragCore(tool);
    case "hygiene":
      return hygieneCore();
    case "reflect":
      return reflectCore(tool);
    case "extract":
      return extractionCore("thatch_get_extraction_payload", "thatch_extraction_done", ' with session_id \\"SESSION_ID\\"');
    default:
      throw new Error(`unknown command template core: ${name}`);
  }
}

function loadCommandTemplate(name: string): string {
  return readFileSync(join(COMMANDS_ARTIFACTS_DIR, `${name}.md`), "utf8");
}

/**
 * Resolve a command artifact's ${...} placeholders. Line-form splices
 * (CORE, COUCHING, CHECKLIST) replace the whole line so multi-line text
 * lands cleanly; inline forms (TOOL, TOKEN) replace in place. Any
 * placeholder that survives resolution throws - a typo'd directive must
 * fail at load, not ship broken prompt text.
 */
function interpolateTemplate(raw: string, tool: ToolNamer): string {
  const resolved = raw
    .replace(/^[ \t]*\$\{CORE:([a-z]+)\}[ \t]*$/gm, (_m, name: string) => coreSplice(name, tool))
    .replace(/^[ \t]*\$\{(COUCHING:[a-z]+|CHECKLIST)\}[ \t]*$/gm, (_m, key: string) => {
      const text = lineSplices[key];
      if (text === undefined) throw new Error(`unknown command template splice: ${key}`);
      return text;
    })
    .replace(/\$\{TOOL:([a-z_]+)\}/g, (_m, name: string) => tool(name))
    .replace(/\$\{TOKEN:([A-Z_]+)\}/g, (_m, name: string) => {
      const token = name === "COMPACT_READY_TOKEN" ? COMPACT_READY_TOKEN : name === "EXIT_READY_TOKEN" ? EXIT_READY_TOKEN : undefined;
      if (!token) throw new Error(`unknown command template token: ${name}`);
      return token;
    });
  const leftover = resolved.match(/\$\{[A-Z_]+(?::[a-zA-Z_]+)?\}/);
  if (leftover) {
    throw new Error(`unresolved command template placeholder: ${leftover[0]}`);
  }
  return resolved;
}

/**
 * One on-demand action: the command name (minus the thatch/ prefix), the
 * description shown in the command menu, and the instruction body loaded
 * from artifacts/commands/<name>.md. opencodeOnly marks actions that need a
 * session identity or other plugin-only capability; those are excluded from
 * Claude Code command files and MCP prompts.
 */
export interface ActionDef {
  name: string;
  description: string;
  body: string;
  opencodeOnly?: boolean;
}

/**
 * The on-demand action set, shared by every host that renders actions.
 * Bodies load from artifacts/commands/; the nudge-backed ones splice their
 * prompt cores so a wording change lands in the nudge and the command at
 * once. `tool` renders tool names in the host's spelling.
 */
export function actionDefs(tool: ToolNamer): ActionDef[] {
  const defs: Array<Omit<ActionDef, "body"> & { opencodeOnly?: boolean }> = [
    {
      name: "defrag",
      description: "Consolidate duplicate and near-duplicate memories in the store",
    },
    {
      name: "extract",
      description: "Drain the extraction queue now",
      // Needs the invoking session's ID (via get_session_info, opencode-only)
      // and the plugin's extraction payload provider.
      opencodeOnly: true,
    },
    {
      name: "hygiene",
      description: "Tend the memory store: stale entries, orphans, pending dedup pairs",
    },
    {
      name: "peer-review",
      description: "Review another author's change (PR, MR, branch, or git range) through the full review pipeline",
      // Skill-couching action (refine precedent): no nudge counterpart. The
      // memory-walk tool name is spelled through the namer so MCP renderings
      // carry the mcp__thatch__ form.
    },
    {
      name: "bug-intake",
      description: "Coordinate incoming bug reports: triage, verify against source, route to a filed issue or a landed fix",
      // Skill-couching action (refine precedent): the full coordinator
      // protocol lives in the thatch-bug-intake skill; the artifact points
      // at it and carries the routing rules that decide the destination.
    },
    {
      name: "refine",
      description: "Refine a plan under the project type's requirements (classifies the project first)",
      // A skill trigger, not a nudge behavior: the body points at the
      // thatch-refine router skill, which classifies the project and loads
      // the matching type deltas on top of the plan-refinement core loop.
    },
    {
      name: "reflect",
      description: "Persist what this session learned as memories",
    },
    {
      name: "self-review",
      description: "Review the user's own completed work before submitting it",
      // Skill-couching action (see peer-review). Names no tools, so the
      // MCP spelling test exempt list covers it.
    },
    {
      name: "whois",
      description: "Report this session's chat identity (handle, topic, project), or look up another session's",
      // Needs the invoking session's identity (chat_status resolves it
      // through the plugin), which only opencode supplies.
      opencodeOnly: true,
    },
  ];
  return defs.map((def) => ({
    ...def,
    body: interpolateTemplate(loadCommandTemplate(def.name), tool),
  }));
}

/**
 * Renders a YAML double-quoted scalar. Plain scalars break on values
 * containing ": " (invalid YAML - the mapping key would be ambiguous), and
 * opencode's lenient fallback parser does not rescue every host path, so the
 * description must always be quoted.
 */
function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

/** Renders one action as a full command markdown file. */
export function renderActionCommand(action: ActionDef): string {
  return `---
description: ${yamlQuote(action.description)}
---
${userMessageSection}

# ${action.name.charAt(0).toUpperCase() + action.name.slice(1)}

${action.body}`;
}

/** The wrap-up command's menu/palette description. Host-neutral on purpose:
 *  what actually happens after the greenlight differs per host (v1 exits the
 *  app, v2 closes the session's tab), and the template text the MODEL reads
 *  is shared verbatim by both hosts. */
export function wrapUpCommandDescription(kind: "compact" | "exit"): string {
  return kind === "compact"
    ? "Flush thatch persistence, check for loose ends, then compact if clear"
    : "Flush thatch persistence, check for loose ends, then end the session if clear";
}

/** Wrap-up bodies load from artifacts and interpolate checklist + token; the
 *  frontmatter and user-message scaffolding stay code-rendered so the
 *  description stays single-sourced in wrapUpCommandDescription. */
function wrapUpTemplate(kind: "compact" | "exit"): string {
  const body = interpolateTemplate(loadCommandTemplate(kind), opencodeToolName);
  return `---
description: ${yamlQuote(wrapUpCommandDescription(kind))}
---
${userMessageSection}

${body}`;
}

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
  return wrapUpTemplate(kind);
}

const COMPACT_TEMPLATE = wrapUpTemplate("compact");
const EXIT_TEMPLATE = wrapUpTemplate("exit");

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
 * plugin's command.execute.before arming and host action routes.
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
