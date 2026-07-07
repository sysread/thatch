# MCP Parity: OpenCode Plugin vs Claude Code

Thatch supports two integration paths:

1. **OpenCode plugin** — runs inside opencode's Bun runtime. Full access to
   plugin hooks: system prompt injection, session events, tool buffering,
   compaction context, and skill installation.
2. **Claude Code MCP server** — runs as a stdio JSON-RPC process. Tools are
   exposed via MCP `tools/list` + `tools/call`. Session behavior is driven by
   Claude Code hooks (`SessionStart`, `UserPromptSubmit`).

This document maps the feature parity and documents the gaps.

## Parity matrix

| Feature | OpenCode plugin | Claude Code MCP + hooks | Parity |
|---------|----------------|------------------------|--------|
| **Tools** (remember, recall, list, show, forget, store_list, find_dup, mark_checked) | Plugin tool registration | MCP `tools/list` + `tools/call` | **Full** |
| **System prompt** (store names, usage rules, when-to-write) | `experimental.chat.system.transform` — dynamic, repo name baked in at runtime | CLAUDE.md instructions — static text appended by `thatch setup`; repo name auto-detected at runtime by the MCP server | **Approximate** — CLAUDE.md is static but the MCP server resolves the repo at startup, so tool behavior is identical |
| **Session-start reminder** (recall nudge + hygiene heartbeat) | `session.created` event → `client.session.prompt` injects a synthetic message | `SessionStart` hook → `thatch reminder` command; stdout becomes context for Claude | **Full** |
| **Compaction context** (re-familiarize after compaction) | `experimental.session.compacting` hook appends context to the compaction output | `PostCompact` hook — side-effects only, **cannot inject context** | **Gap** — CLAUDE.md persists through compaction, so the agent retains the usage instructions, but the dynamic "re-familiarization" nudge is lost |
| **Extraction nudge** (buffer tool calls, inject JSON payload for fact extraction) | `tool.execute.after` buffers non-thatch tool calls; `chat.message` flushes the buffer as a synthetic text part with the JSON payload | No clean equivalent. `PostToolUse` fires per-call but can't buffer across calls. A file-based approach (write to temp, flush on `UserPromptSubmit`) was considered but rejected as fragile | **Gap** — the `thatch-fact-extractor` skill is installed but not automatically triggered. Agents can still load it manually when they notice tool interactions worth extracting |
| **Skills** (fact-extractor, dedup-classifier) | Installed to `$XDG_CONFIG_HOME/opencode/skills` at plugin init | Installed to `~/.claude/skills/` by `thatch setup` | **Full** — same SKILL.md format, different directory |
| **Store detection** (repo identity from git remote) | `worktree` parameter from opencode plugin | `CLAUDE_PROJECT_DIR` environment variable (set by Claude Code for stdio MCP servers) | **Full** |

## Why the gaps exist

### Compaction context

OpenCode's `experimental.session.compacting` hook lets the plugin append text
to the compaction output — the agent sees a "you are using thatch, here's what
you've learned" message after compaction. Claude Code's `PostCompact` hook is
side-effects only (logging, external state); it has no `additionalContext`
field and no decision control. `PreCompact` can block compaction but also
can't inject context.

**Mitigation**: CLAUDE.md is loaded at session start and persists through
compaction. The agent retains the usage instructions. The `SessionStart` hook
with `source: "compact"` fires after compaction, so the recall reminder runs
again — but `thatch reminder` currently doesn't distinguish compaction from
other session-start sources.

### Extraction nudge

OpenCode's extraction pipeline works by:

1. `tool.execute.after` buffers every non-thatch tool call into a per-session
   array (max 20 interactions).
2. On the next `chat.message`, the buffer is flushed and a synthetic text part
   carrying the JSON payload is injected into the conversation.
3. The agent sees the nudge, loads the `thatch-fact-extractor` skill, and
   saves durable facts via `thatch_memory_remember`.

Claude Code hooks fire per-event with no cross-call state. `PostToolUse` can
inject `additionalContext` alongside a single tool result, but there's no
mechanism to buffer across multiple tool calls and flush them together. A
file-based approach (write each interaction to `/tmp/thatch-<session>.jsonl`,
flush on `UserPromptSubmit`) was considered but rejected because:

- Session tracking is fragile (session IDs from hook input, cleanup on
  `SessionEnd`).
- The 10K character cap on `additionalContext` limits the payload size.
- The `UserPromptSubmit` hook fires before the model processes the prompt,
  so the nudge would arrive at the start of the next turn, not at the end of
  the current one — a different timing than opencode's `chat.message`.

**Mitigation**: The `UserPromptSubmit` hook includes a write-nudge that
reminds the agent to save new knowledge. The `thatch-fact-extractor` skill is
installed and can be loaded manually. The agent can also call
`thatch_memory_remember` directly when it recognizes a durable fact, which is
the core workflow regardless of whether the extraction nudge fires.

## Architecture implications

The shared tool definitions in `src/tool-defs.ts` are the single source of
truth for both paths. The opencode plugin wraps them in `tool()` with zod
schemas; the MCP server wraps them in `z.object()` for validation and
`z.toJSONSchema()` for the protocol response. Tool names differ:

- **opencode**: `thatch_memory_remember` (prefixed at the wrapper level)
- **MCP/Claude Code**: `mcp__thatch__memory_remember` (Claude Code auto-prefixes
  with the server name; the MCP server exposes `memory_remember`)

The `thatch setup` command generates CLAUDE.md instructions that reference
both forms — the full `mcp__thatch__*` names for Claude Code, and bare names
for readability.
