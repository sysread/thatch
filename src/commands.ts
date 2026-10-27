import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REVIEW_SPECIALISTS,
  defragCore,
  extractionCore,
  hygieneCore,
  reflectCore,
  opencodeToolName,
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
 * Every command's source of truth is a complete, formal command file at
 * artifacts/commands/<name>.md (frontmatter description + user-message
 * section + body), the same artifacts layout as skills and shipped in the
 * package - a file anyone can lift into their own command directory. The
 * artifacts carry tool names in the opencode spelling (thatch_x); host
 * renderings that need the MCP spelling (mcp__thatch__x) get it from
 * mcpSpelling().
 *
 * A few bodies carry ${...} placeholders that resolve at load, for text that
 * must not be copied: ${CORE:name} (own line) splices the prompt core from
 * src/prompts.ts so nudge and command wording cannot drift;
 * ${COUCHING:target|pipeline} (own line) splices the text shared by the two
 * review-mode commands; ${CHECKLIST} (own line) and ${TOKEN:name} (inline)
 * carry the wrap-up persistence checklist and greenlight tokens. An
 * unresolved placeholder throws at load rather than passing through
 * silently (the REVIEW_COMMON lesson: a naive passthrough once corrupted
 * skill bodies).
 *
 * Two command families live here:
 *
 * - Actions (/thatch/bug-intake, defrag, extract, hygiene, peer-review,
 *   refine, reflect, self-review, whois): user-invoked commands.
 * - Wrap-ups (/thatch/compact, exit): greenlight-gated commands that need
 *   the opencode plugin's host action routes (the compact trigger and the
 *   session close-out), so they are opencode-only. Compact greenlights with
 *   a trailing token; exit greenlights with the zero-arg thatch_exit tool.
 */
export const COMMANDS_ARTIFACTS_DIR = join(import.meta.dir, "..", "artifacts", "commands");

/** Greenlight token ending /thatch/compact's assistant response when compaction is safe. */
export const COMPACT_READY_TOKEN = "THATCH_COMPACT_READY";

/**
 * The greenlight token's host action, per host: v1 drives the TUI
 * (compaction via the "session_compact" legacy alias through
 * executeCommand, the exit via the "app.exit" keymap command through
 * /tui/publish). v2 calls session.compact on the plugin's promise domain
 * and emits the session-tab bridge's TUI-only exit-tab-closed event; the
 * runtime records the exiting session's watcher deaths before either host
 * action runs (src/runtime.ts).
 */

/**
 * Shared wrap-up persistence checklist, spliced into both wrap-up artifacts
 * so the two commands cannot drift apart.
 */
const sharedChecklist = `1. Flush pending persistence. Call thatch_get_extraction_payload; if it returns buffered tool interactions, process them now (write any memories worth keeping), then call thatch_extraction_done to mark them complete. Complete any memory writes you promised earlier but have not made.
2. Check for loose ends. Review the conversation for todos, follow-ups, or open questions raised earlier that were never addressed, and surface anything the user should address before the wrap-up completes.`;

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
 * The cores live in src/prompts.ts; extract's core is opencode-only (it
 * names the opencode-spelled session tools inside the dispatched sub-agent's
 * prompt), so its tool names are literal.
 */
function coreSplice(name: string): string {
  switch (name) {
    case "defrag":
      return defragCore(opencodeToolName);
    case "hygiene":
      return hygieneCore();
    case "reflect":
      return reflectCore(opencodeToolName);
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
 * lands cleanly; ${TOKEN:name} replaces inline. Any placeholder that
 * survives resolution throws - a typo'd directive must fail at load, not
 * ship broken prompt text.
 */
function interpolateTemplate(raw: string): string {
  const resolved = raw
    .replace(/^[ \t]*\$\{CORE:([a-z]+)\}[ \t]*$/gm, (_m, name: string) => coreSplice(name))
    .replace(/^[ \t]*\$\{(COUCHING:[a-z]+|CHECKLIST)\}[ \t]*$/gm, (_m, key: string) => {
      const text = lineSplices[key];
      if (text === undefined) throw new Error(`unknown command template splice: ${key}`);
      return text;
    })
    .replace(/\$\{TOKEN:([A-Z_]+)\}/g, (_m, name: string) => {
      // Exit's token arm is gone: the exit greenlight is the thatch_exit
      // tool call, so compact is the only ${TOKEN:...} user left.
      const token = name === "COMPACT_READY_TOKEN" ? COMPACT_READY_TOKEN : undefined;
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
 * Rewrite opencode-spelled tool names for MCP hosts: `thatch_get_x` becomes
 * `mcp__thatch__get_x`. The transform is mechanical on purpose - artifacts
 * are written once in the opencode spelling and every host rendering derives
 * from them. Word-boundary + lookahead keep skill names (thatch-bug-intake),
 * prose ("thatch setup"), and hyphenated names untouched; only snake_case
 * tool names match.
 */
export function mcpSpelling(text: string): string {
  return text.replace(/\bthatch_(?=[a-z_])/g, "mcp__thatch__");
}

/**
 * One on-demand action: the command name (minus the thatch/ prefix), the
 * description (parsed from the artifact's frontmatter), and the instruction
 * body - everything after the user-message section, in the opencode tool
 * spelling. opencodeOnly marks actions that need a session identity or
 * other plugin-only capability; those are excluded from Claude Code command
 * files and MCP prompts.
 */
export interface ActionDef {
  name: string;
  description: string;
  body: string;
  opencodeOnly?: boolean;
}

/** Actions that need plugin-only capabilities (session identity): excluded
 *  from Claude Code command files and MCP prompts. */
const OPENCODE_ONLY_ACTIONS = new Set(["extract", "whois"]);

/**
 * The on-demand action set. Bodies come from artifacts/commands/<name>.md
 * with all placeholders resolved, in the opencode tool spelling. The body
 * starts at the file's first "# " heading (the user-message section above it
 * is scaffold shared by every artifact).
 */
export function actionDefs(): ActionDef[] {
  const defs: ActionDef[] = [];
  for (const file of ["defrag", "extract", "hygiene", "peer-review", "bug-intake", "refine", "reflect", "self-review", "whois"]) {
    const raw = loadCommandTemplate(file);
    const descriptionMatch = raw.match(/^description: "(.*)"$/m);
    if (!descriptionMatch) {
      throw new Error(`command artifact ${file}.md has no quoted description`);
    }
    const bodyStart = raw.indexOf("\n# ", raw.indexOf("\n# ") + 1);
    if (bodyStart === -1) {
      throw new Error(`command artifact ${file}.md has no body heading`);
    }
    defs.push({
      name: file,
      description: JSON.parse(`"${descriptionMatch[1]}"`),
      body: interpolateTemplate(raw.slice(bodyStart + 1)),
      opencodeOnly: OPENCODE_ONLY_ACTIONS.has(file),
    });
  }
  return defs;
}

/** The opencode command set: wrap-ups plus every action, as full file contents. */
export function opencodeCommandDefs(): { name: string; content: string }[] {
  return ["compact", "exit", "defrag", "extract", "hygiene", "peer-review", "bug-intake", "refine", "reflect", "self-review", "whois"].map((name) => ({
    name,
    content: interpolateTemplate(loadCommandTemplate(name)),
  }));
}

/** The action commands only - no wrap-ups (used where wrap-ups register in code). */
export function opencodeActionCommandDefs(): { name: string; content: string }[] {
  return opencodeCommandDefs().filter((d) => d.name !== "compact" && d.name !== "exit");
}

/**
 * The Claude Code command set: the actions minus the opencode-only ones.
 * The wrap-up commands are excluded too - their greenlight check needs the
 * plugin's command.execute.before arming and host action routes. Tool names
 * render in the MCP spelling.
 */
export function claudeCommandDefs(): { name: string; content: string }[] {
  return opencodeCommandDefs()
    .filter((d) => d.name !== "compact" && d.name !== "exit" && !OPENCODE_ONLY_ACTIONS.has(d.name))
    .map((d) => ({ name: d.name, content: mcpSpelling(d.content) }));
}

/**
 * Sync command files into dir. Idempotent: each file is written only when
 * its on-disk content differs. Returns the paths that were written (empty
 * when everything was current).
 */
function syncCommandFiles(dir: string, defs: { name: string; content: string }[]): string[] {
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
export function installOpencodeCommands(configHome: string, defs: { name: string; content: string }[] = opencodeCommandDefs()): string[] {
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

/**
 * Install the command files into an explicit directory for any harness that
 * reads a commands dir - the steal-them path: the files are complete,
 * formal command documents (frontmatter + user-message section + body) in
 * the opencode tool spelling. The thatch/ subdirectory preserves the
 * /thatch/ invocation namespace. Used by `thatch setup --commands-only <dir>`.
 */
export function installCommandsToDir(dir: string): string[] {
  return syncCommandFiles(join(dir, "thatch"), opencodeCommandDefs());
}

/** The wrap-up command's menu/palette description, as written in the
 *  artifact frontmatter - exported for hosts that register the wrap-up
 *  commands in code (opencode v2 CommandEditor) and need the description
 *  without reading the file. */
export function wrapUpCommandDescription(kind: "compact" | "exit"): string {
  const raw = loadCommandTemplate(kind);
  const match = raw.match(/^description: "(.*)"$/m);
  if (!match) throw new Error(`wrap-up artifact ${kind}.md has no quoted description`);
  return JSON.parse(`"${match[1]}"`);
}

/**
 * The wrap-up command's prompt body, for hosts that register commands in
 * code (opencode v2 CommandEditor): the execute hook arms the greenlight
 * check and delivers this same text as the session prompt.
 */
export function wrapUpCommandContent(kind: "compact" | "exit"): string {
  return interpolateTemplate(loadCommandTemplate(kind));
}
