# Multi-Host Support

Thatch runs as both an opencode plugin and an MCP server for Claude Code and
Cursor. Three integration paths share a common core---the tool definitions in
`src/tool-defs.ts`---but differ in how they deliver system prompts, prefix tool
names, and handle session lifecycle events.

## What it does

Thatch supports three host agents from a single codebase:

- **opencode plugin**---in-process, direct event hooks, warm embedding model,
  `thatch_` tool prefix
- **Claude Code MCP**---stdio MCP server, external CLI hooks,
  `mcp__thatch__` tool prefix, system prompt in CLAUDE.md
- **Cursor MCP**---same stdio MCP server, `--json` hook output format,
  `mcp__thatch__` tool prefix, system prompt in AGENTS.md

All three paths expose the same 18 tool definitions from `src/tool-defs.ts`.
The tools are host-agnostic: each takes args and a `CoreContext`
(`{ db, model, defaultStore }`) and returns a string. The host-specific
wrapping---prefixing, transport, session hooks---lives outside the core.

## The three paths

### opencode plugin (`src/index.ts`)

Runs inside opencode's Bun runtime as a loaded plugin. No setup command is
needed---opencode discovers the plugin from `opencode.json` and loads it at
startup.

**System prompt**: injected at runtime via the
`experimental.chat.system.transform` hook. The hook calls `systemPrompt(repo)`
and pushes the result into `output.system` every turn. No files are written.
The repo name is baked in at runtime, so the prompt always reflects the current
worktree.

**Tools**: registered through opencode's `tool()` wrapper in `src/tools.ts`,
which adds the `thatch_` prefix. The agent sees `thatch_memory_remember`,
`thatch_memory_recall`, etc.

**Skills**: installed to `$XDG_CONFIG_HOME/opencode/skills` at plugin init.
Both the shared skill array and the opencode-only skill array are installed.
See [../skills.md](../skills.md) for the skill system.

**Capabilities unique to this path**:

- Full access to plugin hooks: system prompt injection, session events, tool
  buffering, compaction context
- TUI toast notifications---best-effort, silently ignored in headless mode
- Direct extraction via child sessions (see [session-lifecycle.md](session-lifecycle.md))
- Compaction recovery (see [compaction-recovery.md](compaction-recovery.md))
- Background sub-agents (experimental)---the code-review coordinator dispatches
  specialist sub-agents through opencode's agent infrastructure

### Claude Code MCP server (`src/mcp.ts`)

Runs as a stdio JSON-RPC 2.0 process spawned by Claude Code. The MCP server
exposes tools via `tools/list` and `tools/call`. It is long-lived for the
session duration, keeping the embedding model warm in memory.

**System prompt**: static text appended to `CLAUDE.md` by
`thatch setup --claude`. The text is written between marker constants
(`THATCH_MARKER` / `THATCH_END_MARKER`) using the `appendBlock` helper in
`src/setup.ts`. The block is idempotent---re-running setup replaces the content
between the markers rather than duplicating it. Claude Code loads `CLAUDE.md`
at session start.

**Tools**: the MCP server exposes bare names (`memory_remember`,
`memory_recall`). Claude Code's MCP client applies the `mcp__thatch__` prefix,
so the agent sees `mcp__thatch__memory_remember`. Thatch itself does not apply
this prefix.

**Skills**: installed to `$CLAUDE_CONFIG_DIR/skills/`---shared skills only.
The code-review coordinator skill is opencode-only because it requires
sub-agent dispatch, which Claude Code does not support.

**Session behavior**: driven by external CLI hook processes (`bin/thatch`).
The hooks are registered in `.claude/settings.json` during setup. Each hook
spawns a short-lived `thatch` process that communicates with the long-lived MCP
server via the sideband socket (see [sideband.md](sideband.md)) for warm-model
access. This avoids loading the ~34 MB embedding model in every one-shot hook
process.

**Setup**: `thatch setup --claude` writes `.mcp.json` (server config),
`CLAUDE.md` (instructions block), `.claude/settings.json` (hooks), and
installs skills. See [setup.md](setup.md) for the setup system.

### Cursor MCP server (same `src/mcp.ts`)

The same stdio MCP server as Claude Code. The differences are in hook format,
system prompt file, and tool batching granularity.

**System prompt**: static text appended to `AGENTS.md` by
`thatch setup --cursor`, using the same `appendBlock` helper and marker pair.
Cursor loads `AGENTS.md` at session start.

**Tools**: same bare names over MCP, same `mcp__thatch__` prefix applied by
Cursor's MCP client.

**Skills**: installed to `$CURSOR_CONFIG_DIR/skills/`---shared skills only.

**Session behavior**: driven by Cursor hooks in flat `hooks.json` format
(`.cursor/hooks.json`). Hook output uses the `--json` flag, producing
`{ additional_context: "..." }` objects that Cursor injects into the agent's
context. The `postToolUse` hook fires per-tool---there is no batch equivalent
of Claude Code's `PostToolBatch`. Tool buffering uses `thatch buffer-tool` on
each individual tool call. Cursor uses `conversation_id` instead of
`session_id` for session tracking.

**Setup**: `thatch setup --cursor` writes `.cursor/mcp.json`, `AGENTS.md`,
`.cursor/hooks.json`, and installs skills.

## System prompt delivery

Three mechanisms, one per host. The prompt functions all live in
`src/prompts.ts`.

1. **opencode**: the `experimental.chat.system.transform` hook calls
   `systemPrompt(repo)` and pushes the result into `output.system` at runtime.
   No files are written. The prompt is generated fresh every turn.

2. **Claude Code**: `claudeInstructions()` produces the text that
   `thatch setup --claude` appends to `CLAUDE.md` between
   `THATCH_MARKER` / `THATCH_END_MARKER`. The file is loaded once at session
   start by Claude Code.

3. **Cursor**: `cursorInstructions()` produces the text that
   `thatch setup --cursor` appends to `AGENTS.md` between the same markers.
   Loaded once at session start by Cursor.

The three prompt functions are near-identical. They differ only in host name
string, config file reference (`OPENCODE.md` / `CLAUDE.md` / `AGENTS.md`), and
tool name prefix in the tool list line. Their shared prose sections---"When to
Write", "What NOT to Store", "Before Responding", "Stores", "Skills"---are
verbatim copies with these token substitutions.

There is no single-source-of-truth template that generates all three. Each
variant is an independent string constant in `src/prompts.ts`. Editing shared
prose in one variant requires mirroring the edit in the other two, or the
variants silently drift.

The tool list line in all three prompts must be kept in sync with
`TOOL_DEFS` in `src/tool-defs.ts`. The historical failure mode: a tool is added
to `TOOL_DEFS` but only two of the three prompt functions are updated, creating
an asymmetry a reviewer can catch by diffing the tool lines.

## Tool name prefixing

The 18 tool definitions in `src/tool-defs.ts` use bare names:
`memory_remember`, `memory_recall`, `memory_list`, etc. Each host applies its
own prefix.

| Host | Prefix | Applied by | Example |
|------|--------|------------|---------|
| opencode | `thatch_` | `tool()` wrapper in `src/tools.ts` | `thatch_memory_remember` |
| Claude Code | `mcp__thatch__` | Claude Code's MCP client | `mcp__thatch__memory_remember` |
| Cursor | `mcp__thatch__` | Cursor's MCP client | `mcp__thatch__memory_remember` |

The MCP server (`src/mcp.ts`) always exposes bare names. The
`mcp__thatch__` prefix is a convention of the MCP client, not of thatch.
The opencode prefix is applied in-process by the `tool()` wrapper.

## Feature availability differences

Not all features are available on all hosts. The opencode plugin has direct
access to session events, child sessions, and compaction hooks. The MCP hosts
rely on external hook processes and the sideband socket for equivalent
behavior, with some features having no MCP counterpart.

| Feature | opencode | Claude Code | Cursor |
|---------|----------|-------------|--------|
| Direct extraction (child sessions) | Yes | No | No |
| Compaction recovery | Yes | No | No |
| TUI toast notifications | Yes | No | No |
| Sideband socket | No (in-process) | Yes | Yes |
| code-review coordinator skill | Yes | No | No |
| Background sub-agents | Yes (experimental) | No | No |
| Tool batching | N/A (in-process) | PostToolBatch (batch) | postToolUse (per-tool) |

For the full parity matrix, see [../mcp-parity.md](../mcp-parity.md).

## Interactions with other features

All 18 tools are shared across all hosts via the single source of truth in
`src/tool-defs.ts`. Individual tool behavior is documented in
[memory-store.md](memory-store.md), [extraction.md](extraction.md),
[prediction-engine.md](prediction-engine.md),
[behavior-engine.md](behavior-engine.md), and
[deduplication.md](deduplication.md).

The **nudge pipeline** (see [nudge-pipeline.md](nudge-pipeline.md)) runs
in-process for opencode. For MCP hosts, it runs via the sideband socket---hook
processes query the long-lived MCP server for memory matches, predictions, and
behavior nudges through a Unix domain socket. See [sideband.md](sideband.md)
for the socket protocol.

The **extraction pipeline** (see [extraction.md](extraction.md)) uses an
in-memory ring buffer for opencode. For MCP hosts, it uses a file-backed JSONL
queue that hook processes append to and the MCP server drains.

The **setup system** (see [setup.md](setup.md)) handles Claude Code and Cursor
installation. opencode auto-installs skills and injects the system prompt at
plugin init---no setup command is needed.

**Skills** (see [../skills.md](../skills.md)) install both the shared and
opencode-only arrays for opencode. MCP hosts receive shared skills only, since
the opencode-only skills require sub-agent dispatch or in-process hooks.

## Source files

| File | Role |
|------|------|
| `src/index.ts` | opencode plugin entry---hooks, system prompt injection, session events |
| `src/mcp.ts` | MCP server (shared by Claude Code and Cursor)---stdio JSON-RPC, tool dispatch |
| `src/setup.ts` | Setup installer for Claude Code and Cursor---markers, hooks, skills |
| `src/prompts.ts` | All three system prompt variants---`systemPrompt()`, `claudeInstructions()`, `cursorInstructions()` |
| `src/tools.ts` | Thin opencode tool wrappers---imports tool-defs, adds `thatch_` prefix via `tool()` |
| `src/tool-defs.ts` | Single source of truth for all 18 tool definitions---name, description, zod schema, execute |
| `bin/thatch` | CLI hook commands for MCP hosts---`reminder`, `buffer-tool`, `flush-tools`, `setup` |
