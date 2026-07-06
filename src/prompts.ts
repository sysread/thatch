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

export function sessionStartReminder(repo: string): string {
  return `[thatch] Before responding, use thatch to recall:
(1) user preferences and personality,
(2) project architecture and conventions for "${repo}",
(3) if on a non-main branch, branch-scoped context.
Use thatch_store_list then thatch_memory_list to see what's available, then thatch_memory_recall as needed.`;
}
