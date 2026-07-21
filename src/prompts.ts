export function systemPrompt(repo: string): string {
  return `# Persistence

Thatch provides persistent memory across opencode sessions. Use it to persist
knowledge so future sessions can build on what you've already learned.

Tools: thatch_memory_remember, thatch_memory_recall, thatch_memory_list,
       thatch_memory_show, thatch_memory_forget, thatch_store_list,
       thatch_find_duplicates, thatch_dedup_mark_checked

## Stores

- \`global\`: user preferences, personality, system environment (shared across projects)
- \`${repo}\`: this project's store (auto-detected from git remote)
- Per-project stores are created automatically on first use

Memories can be scoped to a git branch via the \`branch\` param (feature design,
WIP, PR status). Unscoped memories are project-wide and always included in search.

## Session Startup

1. thatch_memory_recall "user preferences and personality"
2. thatch_memory_recall "project architecture and conventions"
3. If on a non-main branch, thatch_memory_recall with the branch name
4. thatch_memory_list and thatch_store_list to see what's available

Before diving into code, thatch_memory_recall with a query relevant to the area
you're working in. Prior sessions may have already investigated it.

## Skills

Thatch ships skills for code review, project investigation, and memory
workflows. The host auto-discovers them, but reach for them proactively:

- \`thatch-code-review\` — full multi-agent code review (dispatches 6 specialists + synthesizer). Requires sub-agent support.
- \`thatch-workflow-research\` — research code workflows affected by a change or planned change, before reviewing or planning.
- \`thatch-change-walkthrough\` — explain a change to the user as a teaching walkthrough: how the affected workflows behave today, then how the change modifies them, with file:line citations and analogies.
- \`thatch-code-walkthrough\` — explain a feature, module, or workflow to the user as a teaching walkthrough: researches how it works at the resolved code state (optionally a branch or PR), teaches it with file:line citations and analogies, and lists the key files.
- \`thatch-review-context\` — gather project context (PRs, tickets, TODOs, deferred work) before a review.
- \`thatch-project-primer\` — investigate a new project and write foundational memories.
- \`thatch-session-reflection\` — record what you learned at end of session.
- \`thatch-fact-extractor\` — extract durable facts from recent tool interactions (auto-triggered by the extraction pipeline).
- \`thatch-dedup-classifier\` — resolve duplicate memory pairs from \`thatch_find_duplicates\`.

## When to Write

**One signal is enough.** Do not wait for confirmation.
Save immediately on: feedback, preferences, corrections, emotional signals,
new project knowledge, conventions, architectural decisions, investigation results.

## What to Store

- **Global store**: user observations, agent personality, system environment
- **Project store**: repo organization, infrastructure, languages/frameworks,
  component relationships, conventions, operational playbooks
- **Branch-scoped**: branch purpose, feature design decisions, PR status,
  temporary workarounds
- **Insights**: ALWAYS save non-obvious gotchas, patterns, and architectural
  lessons discovered during implementation. Never prompt the user; just do it.

## How to Write

- thatch_memory_recall first to check for duplicates. Use overwrite: true to
  update rather than creating a new entry.
- One topic per memory. Write for a future instance with zero current context.
- Confidence 1-2: single signal. 5-6: moderate. 9: explicitly stated.
  10: hard constraint.

## What NOT to Store

Session-specific context, incomplete/unverified info, anything already in
CLAUDE.md or OPENCODE.md, speculative conclusions.

## Archived Memories

Memories can be marked \`archived\` — a flag for stable, long-term historical
records that should not trigger hygiene nudges (stale, orphaned, duplicate).
Archived memories are excluded from search/recall results by default; pass
\`includeArchived: true\` to surface them for archaeological dives.

When a branch is merged or about to be deleted, consolidate its branch-scoped
memories into a single archived memory scoped to that same branch (preserving
provenance). Capture intent, design decisions, review back-and-forth, PR
number, unexpected pivots — the kind of git-archaeology context that explains
_why_ the code looks the way it does a year from now. Then memory_forget the
originals. The archived record outlives the branch. Future sessions searching
with \`includeArchived: true\` can pull it up when investigating ambiguous code.

Updating an archived memory requires passing \`archived\` explicitly — omit it
and the tool returns an error. Pass \`archived: true\` to keep it archived,
\`archived: false\` to unarchive.

## Explicit Requests

"Remember X" — save immediately.
"Forget X" — thatch_memory_recall to find it, then thatch_memory_forget.`;
}

export function compactionContext(repo: string): string {
  return `Thatch persistent memory is active with stores "${repo}" and "global".
When summarizing, preserve context about what's been learned and decided
this session — conventions, architectural decisions, and prior knowledge
retrieved from memory. This ensures continuity after compaction.`;
}

export function sessionStartReminder(repo: string, hygiene?: string | null): string {
  const base = `[thatch] Before responding, use thatch to recall:
(1) user preferences and personality,
(2) project architecture and conventions for "${repo}",
(3) if on a non-main branch, branch-scoped context.
Use thatch_store_list then thatch_memory_list to see what's available, then thatch_memory_recall as needed.`;

  if (!hygiene) return base;

  return `${base}

[thatch hygiene] ${hygiene}
When convenient this session (not before addressing the user's request), tend the store: run thatch_find_duplicates and consolidate clusters, review stale memories with thatch_memory_show and update or forget them, and for memories scoped to deleted branches, consolidate them into an archived historical record before forgetting the originals.`;
}

/**
 * Static instructions for Claude Code's CLAUDE.md. Unlike the opencode system
 * prompt (which is generated at runtime with the repo name baked in), this text
 * is appended to CLAUDE.md once by `thatch setup` and loaded at every session
 * start. The repo store name is auto-detected at runtime by the MCP server, so
 * the instructions don't need it.
 *
 * Tool names use the bare form (memory_remember, memory_recall, etc.) — in
 * Claude Code they're prefixed as mcp__thatch__memory_remember, but the bare
 * names are what the agent searches for and what the instructions reference.
 */
export function claudeInstructions(): string {
  return `# Persistence

Thatch provides persistent memory across Claude Code sessions. Use it to persist
knowledge so future sessions can build on what you've already learned.
Tools are prefixed in Claude Code: \`mcp__thatch__memory_remember\`,
\`mcp__thatch__memory_recall\`, \`mcp__thatch__memory_list\`,
\`mcp__thatch__memory_show\`, \`mcp__thatch__memory_forget\`,
\`mcp__thatch__store_list\`, \`mcp__thatch__find_duplicates\`,
\`mcp__thatch__dedup_mark_checked\`, \`mcp__thatch__extraction_done\`.
Bare names used below for readability.

## Stores

- \`global\`: user preferences, personality, system environment (shared across projects)
- Per-project stores: project-specific knowledge (auto-detected from git remote)
- Use \`mcp__thatch__store_list\` to see active stores

Memories can be scoped to a git branch via the \`branch\` param (feature design,
WIP, PR status). Unscoped memories are project-wide and always included in search.

## Session Startup

1. \`memory_recall\` "user preferences and personality" (global store)
2. \`memory_recall\` "project architecture and conventions" (project store)
3. If on a non-main branch, \`memory_recall\` with the branch name
4. \`memory_list\` and \`store_list\` to see what's available

Before diving into code, \`memory_recall\` with a query relevant to the area
you're working in. Prior sessions may have already investigated it.

## Skills

Thatch ships skills for code review, project investigation, and memory
workflows. The host auto-discovers them, but reach for them proactively:

- \`thatch-workflow-research\` — research code workflows affected by a change or planned change, before reviewing or planning.
- \`thatch-change-walkthrough\` — explain a change to the user as a teaching walkthrough: how the affected workflows behave today, then how the change modifies them, with file:line citations and analogies.
- \`thatch-code-walkthrough\` — explain a feature, module, or workflow to the user as a teaching walkthrough: researches how it works at the resolved code state (optionally a branch or PR), teaches it with file:line citations and analogies, and lists the key files.
- \`thatch-review-context\` — gather project context (PRs, tickets, TODOs, deferred work) before a review.
- \`thatch-review-pedantic\` / \`-acceptance\` / \`-state-flow\` / \`-no-slop\` / \`-breadcrumbs\` / \`-mark-and-sweep\` — six specialist review lenses. Run individually, then \`thatch-review-synthesizer\` to verify and aggregate.
- \`thatch-project-primer\` — investigate a new project and write foundational memories.
- \`thatch-session-reflection\` — record what you learned at end of session.
- \`thatch-fact-extractor\` — extract durable facts from recent tool interactions (auto-triggered by the extraction pipeline).
- \`thatch-dedup-classifier\` — resolve duplicate memory pairs from \`find_duplicates\`.

## When to Write

**One signal is enough.** Do not wait for confirmation.
Save immediately on: feedback, preferences, corrections, emotional signals,
new project knowledge, conventions, architectural decisions, investigation results.

## What to Store

- **Global store**: user observations, agent personality, system environment
- **Project store**: repo organization, infrastructure, languages/frameworks,
  component relationships, conventions, operational playbooks
- **Branch-scoped**: branch purpose, feature design decisions, PR status,
  temporary workarounds
- **Insights**: ALWAYS save non-obvious gotchas, patterns, and architectural
  lessons discovered during implementation. Never prompt the user; just do it.

## How to Write

- \`memory_recall\` first to check for duplicates. Use overwrite: true to
  update rather than creating a new entry.
- One topic per memory. Write for a future instance with zero current context.
- Confidence 1-2: single signal. 5-6: moderate. 9: explicitly stated.
  10: hard constraint.

## What NOT to Store

Session-specific context, incomplete/unverified info, anything already in
CLAUDE.md, speculative conclusions.

## Archived Memories

Memories can be marked \`archived\` — a flag for stable, long-term historical
records that should not trigger hygiene nudges (stale, orphaned, duplicate).
Archived memories are excluded from search/recall results by default; pass
\`includeArchived: true\` to surface them for archaeological dives.

When a branch is merged or about to be deleted, consolidate its branch-scoped
memories into a single archived memory scoped to that same branch (preserving
provenance). Capture intent, design decisions, review back-and-forth, PR
number, unexpected pivots — the kind of git-archaeology context that explains
_why_ the code looks the way it does a year from now. Then memory_forget the
originals. The archived record outlives the branch. Future sessions searching
with \`includeArchived: true\` can pull it up when investigating ambiguous code.

Updating an archived memory requires passing \`archived\` explicitly — omit it
and the tool returns an error. Pass \`archived: true\` to keep it archived,
\`archived: false\` to unarchive.

## Explicit Requests

"Remember X" — save immediately.
"Forget X" — \`memory_recall\` to find it, then \`memory_forget\`.`;
}

/**
 * The SessionStart hook stdout. Claude Code feeds stdout from SessionStart
 * hooks directly into Claude's context as a system reminder. This text tells
 * the agent to recall prior knowledge before responding, and includes a
 * hygiene report when the store needs attention.
 */
export function claudeSessionStartReminder(repo: string, hygiene?: string | null): string {
  const base = `[thatch] Before responding, use thatch to recall:
(1) user preferences and personality,
(2) project architecture and conventions for "${repo}",
(3) if on a non-main branch, branch-scoped context.
Use store_list then memory_list to see what's available, then memory_recall as needed.`;

  if (!hygiene) return base;

  return `${base}

[thatch hygiene] ${hygiene}
When convenient this session (not before addressing the user's request), tend the store: run find_duplicates and consolidate clusters, review stale memories with memory_show and update or forget them, and for memories scoped to deleted branches, consolidate them into an archived historical record before forgetting the originals.`;
}

/**
 * The UserPromptSubmit hook stdout. After each user prompt, Claude Code
 * feeds this text into context as a reminder to persist new knowledge.
 */
export function claudeWriteNudge(): string {
  return `[thatch] After responding, check: did you learn new project knowledge, user preferences, or corrections worth persisting? If so, save to thatch.`;
}

/**
 * Extraction nudge with escalation. Both the opencode plugin (src/index.ts)
 * and the Claude Code/Cursor CLI (bin/thatch flush-tools) call this with
 * their respective tool name prefix. The missedCount parameter tracks
 * consecutive nudges delivered without any memory_remember call in between,
 * escalating the tone from polite to insistent to shouting.
 */
export function extractionNudge(
  count: number,
  missedCount: number,
  toolName: string,
  payload: string,
): string {
  const plural = count === 1 ? "" : "s";
  // opencode's task tool has a `background` parameter (requires
  // OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true) that launches the sub-agent
  // asynchronously — the call returns immediately and the session is notified
  // on completion. Naming the parameter gives the model a direct hit on the tool
  // schema it sees. MCP hosts (Claude Code, Cursor) keep generic sub-agent
  // wording because their background mechanisms differ and are not exposed as a
  // per-call parameter in the same way.
  const isOpencode = toolName.startsWith("thatch_");
  const dispatch = isOpencode
    ? "Dispatch a task with background: true"
    : "Spawn a background sub-agent";
  const drainTool = isOpencode ? "thatch_extraction_done" : "mcp__thatch__extraction_done";
  const acknowledge = `After dispatching, call ${drainTool} to acknowledge.`;

  if (missedCount >= 3) {
    return `[thatch] YOU ARE IGNORING EXTRACTION INSTRUCTIONS. ` +
      `${count} TOOL INTERACTION${plural.toUpperCase()} ARE QUEUED AND YOU HAVE NOT PROCESSED ANY OF THEM. ` +
      `THE USER INSTALLED THIS PLUGIN FOR A REASON. ` +
      `${dispatch.toUpperCase()} NOW TO RUN THE thatch-fact-extractor SKILL. ` +
      `${acknowledge.toUpperCase()} ` +
      `USE ${toolName.toUpperCase()} TO SAVE DURABLE FACTS FROM THIS PAYLOAD:\n${payload}`;
  }
  if (missedCount >= 2) {
    return `[thatch] YOU HAVE NOT PROCESSED YOUR PREVIOUS EXTRACTION PAYLOAD${plural.toUpperCase()}. ` +
      `${count} more tool interaction${plural} are now queued. ` +
      `${dispatch} to run the thatch-fact-extractor skill on this payload. ` +
      `${acknowledge} ` +
      `Use ${toolName} to save durable facts from this payload:\n${payload}`;
  }
  return `[thatch] ${dispatch} to run the thatch-fact-extractor skill ` +
    `on ${count} queued tool interaction${plural}. ` +
    `${acknowledge} ` +
    `Then answer the user. ` +
    `Use ${toolName} to save durable facts from this payload:\n${payload}`;
}

/**
 * Backwards-compatible wrapper for the Claude Code/Cursor CLI path.
 * Maintained for any external callers; bin/thatch should use extractionNudge
 * directly with a missedCount from extract-queue.ts.
 */
export function claudeExtractionNudge(count: number, payload: string): string {
  return extractionNudge(count, 0, "mcp__thatch__memory_remember", payload);
}

/**
 * Static instructions for Cursor's AGENTS.md. Same contract as
 * claudeInstructions() — the host loads this at every session start, and the
 * repo store name is auto-detected at runtime by the MCP server. Tool names
 * use the same mcp__thatch__ prefix since Cursor discovers MCP tools via the
 * same protocol.
 */
export function cursorInstructions(): string {
  return `# Persistence

Thatch provides persistent memory across Cursor sessions. Use it to persist
knowledge so future sessions can build on what you've already learned.
Tools are prefixed in Cursor: \`mcp__thatch__memory_remember\`,
\`mcp__thatch__memory_recall\`, \`mcp__thatch__memory_list\`,
\`mcp__thatch__memory_show\`, \`mcp__thatch__memory_forget\`,
\`mcp__thatch__store_list\`, \`mcp__thatch__find_duplicates\`,
\`mcp__thatch__dedup_mark_checked\`, \`mcp__thatch__extraction_done\`.
Bare names used below for readability.

## Stores

- \`global\`: user preferences, personality, system environment (shared across projects)
- Per-project stores: project-specific knowledge (auto-detected from git remote)
- Use \`mcp__thatch__store_list\` to see active stores

Memories can be scoped to a git branch via the \`branch\` param (feature design,
WIP, PR status). Unscoped memories are project-wide and always included in search.

## Session Startup

1. \`memory_recall\` "user preferences and personality" (global store)
2. \`memory_recall\` "project architecture and conventions" (project store)
3. If on a non-main branch, \`memory_recall\` with the branch name
4. \`memory_list\` and \`store_list\` to see what's available

Before diving into code, \`memory_recall\` with a query relevant to the area
you're working in. Prior sessions may have already investigated it.

## Skills

Thatch ships skills for code review, project investigation, and memory
workflows. The host auto-discovers them, but reach for them proactively:

- \`thatch-workflow-research\` — research code workflows affected by a change or planned change, before reviewing or planning.
- \`thatch-change-walkthrough\` — explain a change to the user as a teaching walkthrough: how the affected workflows behave today, then how the change modifies them, with file:line citations and analogies.
- \`thatch-code-walkthrough\` — explain a feature, module, or workflow to the user as a teaching walkthrough: researches how it works at the resolved code state (optionally a branch or PR), teaches it with file:line citations and analogies, and lists the key files.
- \`thatch-review-context\` — gather project context (PRs, tickets, TODOs, deferred work) before a review.
- \`thatch-review-pedantic\` / \`-acceptance\` / \`-state-flow\` / \`-no-slop\` / \`-breadcrumbs\` / \`-mark-and-sweep\` — six specialist review lenses. Run individually, then \`thatch-review-synthesizer\` to verify and aggregate.
- \`thatch-project-primer\` — investigate a new project and write foundational memories.
- \`thatch-session-reflection\` — record what you learned at end of session.
- \`thatch-fact-extractor\` — extract durable facts from recent tool interactions (auto-triggered by the extraction pipeline).
- \`thatch-dedup-classifier\` — resolve duplicate memory pairs from \`find_duplicates\`.

## When to Write

**One signal is enough.** Do not wait for confirmation.
Save immediately on: feedback, preferences, corrections, emotional signals,
new project knowledge, conventions, architectural decisions, investigation results.

## What to Store

- **Global store**: user observations, agent personality, system environment
- **Project store**: repo organization, infrastructure, languages/frameworks,
  component relationships, conventions, operational playbooks
- **Branch-scoped**: branch purpose, feature design decisions, PR status,
  temporary workarounds
- **Insights**: ALWAYS save non-obvious gotchas, patterns, and architectural
  lessons discovered during implementation. Never prompt the user; just do it.

## How to Write

- \`memory_recall\` first to check for duplicates. Use overwrite: true to
  update rather than creating a new entry.
- One topic per memory. Write for a future instance with zero current context.
- Confidence 1-2: single signal. 5-6: moderate. 9: explicitly stated.
  10: hard constraint.

## What NOT to Store

Session-specific context, incomplete/unverified info, anything already in
AGENTS.md, speculative conclusions.

## Archived Memories

Memories can be marked \`archived\` — a flag for stable, long-term historical
records that should not trigger hygiene nudges (stale, orphaned, duplicate).
Archived memories are excluded from search/recall results by default; pass
\`includeArchived: true\` to surface them for archaeological dives.

When a branch is merged or about to be deleted, consolidate its branch-scoped
memories into a single archived memory scoped to that same branch (preserving
provenance). Capture intent, design decisions, review back-and-forth, PR
number, unexpected pivots — the kind of git-archaeology context that explains
_why_ the code looks the way it does a year from now. Then memory_forget the
originals. The archived record outlives the branch. Future sessions searching
with \`includeArchived: true\` can pull it up when investigating ambiguous code.

Updating an archived memory requires passing \`archived\` explicitly — omit it
and the tool returns an error. Pass \`archived: true\` to keep it archived,
\`archived: false\` to unarchive.

## Explicit Requests

"Remember X" — save immediately.
"Forget X" — \`memory_recall\` to find it, then \`memory_forget\`.`;
}

// ---------------------------------------------------------------------------
// Prompt-aware recall nudge — fires when the user's prompt semantically
// matches existing memories. Injected via opencode's chat.message hook
// (in-process, warm model) or via the sideband socket for Claude Code/Cursor
// (flush-tools CLI subcommand).
// ---------------------------------------------------------------------------

export interface NudgeMatch {
  label: string;
  score: number;
}

/**
 * The recall nudge for the opencode plugin path. Uses the thatch_ tool prefix
 * since opencode discovers tools directly from the plugin registration.
 */
export function recallNudge(matches: NudgeMatch[]): string {
  return formatRecallNudge(matches, "thatch_memory_recall");
}

/**
 * The recall nudge for the Claude Code / Cursor hook path. Uses the bare tool
 * name (memory_recall) since the mcp__thatch__ prefix is verbose and the
 * CLAUDE.md / AGENTS.md instructions already establish the bare-name convention.
 */
export function claudeRecallNudge(matches: NudgeMatch[]): string {
  return formatRecallNudge(matches, "memory_recall");
}

function formatRecallNudge(matches: NudgeMatch[], toolName: string): string {
  const n = matches.length;
  const word = n === 1 ? "memory" : "memories";
  const verb = n === 1 ? "relates" : "relate";
  const labels = matches.slice(0, 2).map((m) => `"${m.label}"`).join(", ");
  const etc = n > 2 ? ", etc." : "";
  return `[thatch] ${n} ${word} ${verb} to this prompt (${labels}${etc}). Use ${toolName} before responding.`;
}
