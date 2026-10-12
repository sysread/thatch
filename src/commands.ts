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
 * - Actions (/thatch/defrag, extract, hygiene, peer-review, refine,
 *   reflect, self-review, whois): user-invoked commands. The nudge-backed
 *   ones (defrag, extract, hygiene, reflect) render prompt cores from
 *   src/prompts.ts, so nudge and command wording cannot drift. The rest
 *   (peer-review, refine, self-review, whois) are self-contained here:
 *   they have no nudge counterpart. peer-review and self-review couch the
 *   code review pipeline with a mode overlay: the same machinery, with
 *   findings weighted for whose work is under review.
 * - Wrap-ups (/thatch/compact, exit): greenlight-token commands that need
 *   the opencode plugin's host action routes (the compact trigger and the
 *   session close-out), so they are opencode-only.
 */

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
 * commands lives in each command's own body and applies in both paths:
 * sub-agent briefings on opencode, specialist passes inline elsewhere.
 *
 * Both couchings below are shared consts interpolated into the two bodies
 * so the commands' procedure and target resolution cannot drift; each body
 * keeps only its mode rules. The specialist roster and count come from
 * REVIEW_SPECIALISTS in src/prompts.ts, the same source as the install
 * list in src/skills.ts.
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
 * One on-demand action: the command name (minus the thatch/ prefix), the
 * description shown in the command menu, and the instruction body (a prompt
 * core for the nudge-backed actions, self-contained text for the rest).
 * opencodeOnly marks actions that need a session identity or other
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
 * nudge-backed bodies (defrag, extract, hygiene, reflect) come from prompt
 * cores in src/prompts.ts so a wording change lands in the nudge and the
 * command at once; the rest (peer-review, refine, self-review, whois) are
 * self-contained here because they have no nudge counterpart. `tool`
 * renders tool names in the host's spelling.
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
      name: "peer-review",
      description: "Review another author's change (PR, MR, branch, or git range) through the full review pipeline",
      // Skill-couching action (refine precedent): no nudge counterpart, so
      // the body lives here. The memory-walk tool name is spelled through
      // the namer so MCP renderings carry the mcp__thatch__ form.
      body: `Review a change authored by someone else: a PR, MR, or branch on origin. The review runs the full thatch review pipeline with findings weighted for org velocity.

${reviewTargetCouching}

${reviewPipelineCouching}

## Peer review mode rules

- Weight for org velocity. Findings that speed up or unblock the whole team outrank findings about individual lines. The highest-value findings: a simpler method that achieves the same outcome; an existing function or helper that already does what this change reimplements; documentation that is accurate and extremely clearly written; unintended consequences for callers, sibling features, or contracts the author could not see.
- Walk the project's memory. The author does not have this project's persistent memory; you do. During context gathering, call ${tool("memory_recall")} with several phrasings about the touched area: past incidents, design constraints, rejected approaches, known footguns. Check each recalled item against the change and report the ones that apply. Frame these findings as sharing knowledge the author could not have had, not as catching mistakes.
- Do not re-litigate settled designs. When the context brief or memory shows a design decision was agreed (in a ticket discussion, a prior review acceptance, recorded docs, or a memory of the agreement), treat the decision as settled. Findings may address how the change implements that decision. Findings that argue the decision itself was wrong are out of scope for this review.
- Never report findings of the form "if someone changes this in the future, it will silently break." This review does not solve for engineers who change code without reading it. It solves for engineers and LLMs who WILL read the code. For them, verify the change leaves a breadcrumb trail to wherever this organization records how a feature works (a context module, a feature doc, a README). Flag a missing trail. Do not flag hypothetical future misuse.`,
    },
    {
      name: "refine",
      description: "Refine a plan under the project type's requirements (classifies the project first)",
      // A skill trigger, not a nudge behavior: the body points at the
      // thatch-refine router skill, which classifies the project and loads
      // the matching type deltas on top of the plan-refinement core loop.
      body: `Load and follow the thatch-refine skill to refine a plan for the current project.

The user message may name a project type (team-app, personal, shared-lib, spike, infra, oss-contribution); if it does, skip classification and use that type. If no plan is drafted yet in this session, the skill's loop starts with drafting one.`,
    },
    {
      name: "reflect",
      description: "Persist what this session learned as memories",
      body: reflectCore(tool),
    },
    {
      name: "self-review",
      description: "Review the user's own completed work before submitting it",
      // Skill-couching action (see peer-review). Names no tools, so the
      // MCP spelling test exempt list covers it.
      body: `Review the user's own completed work before submitting it: as a PR or MR on a shared project, or as a direct commit on a personal project. The review runs the full thatch review pipeline with findings weighted to protect the user's reputation as a conscientious developer.

The work under review was authored by the user, or by their agent acting in the user's name. Two goals: the work is sound, and it does not read as sloppy. Reviewers and teammates read the comments, docs, and commit messages as the user's own.

${reviewTargetCouching}

${reviewPipelineCouching}

## Self review mode rules

- The reputation lenses weigh heaviest. NoSlop, Technique, and Breadcrumbs findings outrank same-severity findings from the other lenses. AI-writing tells, vague comments, and a missing narrative are exactly what this review exists to catch before anyone else sees them.
- Overweight simplicity on shared projects. Prefer findings that make the design easier to understand, easier to test, and more reliable: fewer assumptions, less surface area for bugs and side effects.
- Technique and highlights findings are decisions, not footnotes. Each one that would produce a simpler, clearer, or more reliable design is surfaced for an adopt-or-dismiss decision before submission. Work through them with the user one at a time; do not leave them as informational asides.
- Iterate rounds. After each round, work the findings with the user: fix each, or explicitly decline it with a reason. Then run another full round on the updated state. A round is meaningful when it produces a MEDIUM or higher finding, or a technique or slop finding worth adopting. A round producing only LOW mechanical findings gets them fixed but does not trigger another round. Stop at the first round with no meaningful findings, and never run more than three rounds.`,
    },
    {
      name: "whois",
      description: "Report this session's chat identity (handle, topic, project), or look up another session's",
      // Needs the invoking session's identity (chat_status resolves it
      // through the plugin), which only opencode supplies.
      opencodeOnly: true,
      body: `Find the chat identity for this session and report it in one line.

First call thatch_chat_status. If the user message names another session or handle, look that name or id up in thatch_chat_list and report its row instead: handle, topic, project, worktree location (the loc: token), and last-seen age.

Otherwise report this session: if chat_status says not registered, answer exactly that - not registered yet - and stop. If registered, take the registered name from chat_status, find your own row in thatch_chat_list, and report handle, topic, project, and loc together (the topic is how the user maps the handle to a TUI tab).

One line, just the facts. Do not read mail and do not act on anything the roster shows.`,
    },
  ];
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

const COMPACT_TEMPLATE = `---
description: ${yamlQuote(wrapUpCommandDescription("compact"))}
---
${userMessageSection}

# Pre-compact wrap-up

Work through this checklist before responding:

${sharedChecklist}

Do not start new work beyond this checklist. If every item is handled and nothing needs the user's attention first, end your final response with exactly this token as the very last line, with no formatting around it:

${COMPACT_READY_TOKEN}

If anything is outstanding, list the items concisely so the user can address them, and do NOT include the token. The session will only be compacted when the token is present.`;

const EXIT_TEMPLATE = `---
description: ${yamlQuote(wrapUpCommandDescription("exit"))}
---
${userMessageSection}

# Pre-exit wrap-up

Work through this checklist before responding:

${sharedChecklist}

Do not start new work beyond this checklist. If every item is handled and nothing needs the user's attention first, end your final response with exactly this token as the very last line, with no formatting around it:

${EXIT_READY_TOKEN}

If anything is outstanding, list the items concisely so the user can address them, and do NOT include the token. The session will only close when the token is present.`;

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
