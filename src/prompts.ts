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

## Explicit Requests

"Remember X" — save immediately.
"Forget X" — thatch_memory_recall to find it, then thatch_memory_forget.`;
}

export function compactionContext(repo: string): string {
  return `Thatch persistent memory is active with stores "${repo}" and "global".
Use thatch_memory_recall to retrieve prior knowledge, thatch_memory_remember
to persist important decisions, patterns, and conventions encountered so far.
Include context about what's been learned and decided when summarizing.`;
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
When convenient this session (not before addressing the user's request), tend the store: run thatch_find_duplicates and consolidate clusters, review stale memories with thatch_memory_show and update or forget them, and forget memories scoped to deleted branches.`;
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
\`mcp__thatch__dedup_mark_checked\`.
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
When convenient this session (not before addressing the user's request), tend the store: run find_duplicates and consolidate clusters, review stale memories with memory_show and update or forget them, and forget memories scoped to deleted branches.`;
}

/**
 * The UserPromptSubmit hook stdout. After each user prompt, Claude Code
 * feeds this text into context as a reminder to persist new knowledge.
 */
export function claudeWriteNudge(): string {
  return `[thatch] After responding, check: did you learn new project knowledge, user preferences, or corrections worth persisting? If so, save to thatch.`;
}
