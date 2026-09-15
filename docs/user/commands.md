# Slash commands

Thatch ships `/thatch/*` commands you run yourself, on top of the nudges the
plugin fires on its own schedule. Nudges and commands share the same
instruction text, so a behavior works the same whether it fires automatically
or you invoke it.

## Commands

- `/thatch/defrag` — find duplicate-candidate memory pairs and clusters,
  classify each one, consolidate duplicates, and mark the rest checked.
  Text after the command narrows the scope (for example, a store name).
- `/thatch/extract` — drain the extraction queue now, instead of waiting
  for the next nudge or idle-time extraction. opencode only.
- `/thatch/hygiene` — run the hygiene report and act on it: stale
  memories, memories scoped to deleted branches, and pending dedup pairs.
  The agent asks before forgetting anything that may still matter.
- `/thatch/reflect` — run the session-reflection skill to persist what the
  current session learned.
- `/thatch/compact` and `/thatch/exit` — the wrap-up commands. They run a
  pre-flight checklist (flush extraction, finish promised memory writes,
  surface loose ends) before a compaction or an exit, gated by a greenlight
  token. opencode only; the greenlight mechanics are described in the
  [user guide overview](README.md).

## Host support

| Command | opencode | Claude Code | Cursor |
|---|---|---|---|
| `/thatch/defrag` | yes | yes | yes (as an MCP prompt) |
| `/thatch/extract` | yes | no | no |
| `/thatch/hygiene` | yes | yes | yes (as an MCP prompt) |
| `/thatch/reflect` | yes | yes | yes (as an MCP prompt) |
| `/thatch/compact`, `/thatch/exit` | yes | no | no |

Why the gaps: `/thatch/extract` needs the invoking session's ID, which only
the opencode plugin can supply. The wrap-up commands trigger TUI actions
through the plugin. Cursor has no file-based commands; its prompts come from
the MCP server (`prompts/list` and `prompts/get`).

## Installation

- **opencode**: installed by the plugin on every load.
- **Claude Code**: installed by `thatch setup --claude` into the same scope
  as the skills (`.claude/commands/thatch/` project-local, or the Claude
  config dir for `--global`). Re-run setup to refresh after an upgrade.

Tool names inside the command text follow each host's spelling
(`thatch_memory_remember` on opencode, `mcp__thatch__memory_remember` on
Claude Code and Cursor).
