# thatch

Persistent agent memory via local embeddings + SQLite. Bun-only (bun:sqlite,
Bun.$) — it does not run under Node. Works with OpenCode (as a plugin) and
Claude Code (as an MCP server).

## Commands

```bash
bun install            # deps
bun test               # full suite (<1s, no network)
bun run bin/thatch     # CLI: stores|list|show|search|forget|mcp|reminder|hygiene|setup
bunx tsc --noEmit      # typecheck (tests are excluded from tsconfig)
```

mise.toml exists for local convenience only (bun pin, task aliases). mise is
NOT installed in Claude Code cloud sandboxes — use the bun commands above.
Never run `bin/release` / `mise run release`: releases are the maintainer's
prerogative (tag push → GitHub Actions → npm via OIDC trusted publishing).

## Orientation

- `docs/dev/README.md` — architecture, module map, plugin hooks, data flow,
  design invariants. Read this before changing src/.
- `docs/dev/mcp-parity.md` — OpenCode plugin vs Claude Code MCP feature
  comparison, including documented gaps.
- `docs/plans/` — decision records; 002 explains why extraction/dedup are
  agent-driven and the opencode hook-wiring gotchas.
- `docs/qa/README.md` — test conventions and coverage map.

## Invariants (see docs/plans/002)

- The plugin never writes memories autonomously; agents do, via tools.
- Embedding spaces are discriminated by vector dimension, not model tag.
- Skills are plugin-owned, installed to $XDG_CONFIG_HOME/opencode/skills
  (opencode) or ~/.claude/skills/ (Claude Code), never into the worktree.
- Hook failures are logged with a [thatch] prefix, never swallowed.
- Tool definitions are the single source of truth (src/tool-defs.ts). Adding
  a tool means adding one entry to TOOL_DEFS.

# Persistence

Thatch provides persistent memory across Claude Code sessions. Use it to persist
knowledge so future sessions can build on what you've already learned.
Tools are prefixed in Claude Code: `mcp__thatch__memory_remember`,
`mcp__thatch__memory_recall`, `mcp__thatch__memory_list`,
`mcp__thatch__memory_show`, `mcp__thatch__memory_forget`,
`mcp__thatch__store_list`, `mcp__thatch__find_duplicates`,
`mcp__thatch__dedup_mark_checked`.
Bare names used below for readability.

## Stores

- `global`: user preferences, personality, system environment (shared across projects)
- Per-project stores: project-specific knowledge (auto-detected from git remote)
- Use `mcp__thatch__store_list` to see active stores

Memories can be scoped to a git branch via the `branch` param (feature design,
WIP, PR status). Unscoped memories are project-wide and always included in search.

## Session Startup

1. `memory_recall` "user preferences and personality" (global store)
2. `memory_recall` "project architecture and conventions" (project store)
3. If on a non-main branch, `memory_recall` with the branch name
4. `memory_list` and `store_list` to see what's available

Before diving into code, `memory_recall` with a query relevant to the area
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

- `memory_recall` first to check for duplicates. Use overwrite: true to
  update rather than creating a new entry.
- One topic per memory. Write for a future instance with zero current context.
- Confidence 1-2: single signal. 5-6: moderate. 9: explicitly stated.
  10: hard constraint.

## What NOT to Store

Session-specific context, incomplete/unverified info, anything already in
CLAUDE.md, speculative conclusions.

## Explicit Requests

"Remember X" — save immediately.
"Forget X" — `memory_recall` to find it, then `memory_forget`.
