# Setup and Hook Configuration

How `thatch setup` wires each host, and which hook events each path relies on.
For feature parity and gaps, see `mcp-parity.md`. This document is the concrete
artifact reference.

## OpenCode (plugin)

No `setup` command — opencode loads the plugin from `opencode.json`:

```jsonc
{ "plugin": ["@jeffober/thatch"] }
```

The plugin entry (`src/index.ts`) registers these hooks in code:

| Hook | Input | Output | Behavior |
|------|-------|--------|----------|
| `experimental.chat.system.transform` | `{}` | `{ system: string[] }` | Pushes the system prompt (store names, usage rules). |
| `experimental.session.compacting` | `{ sessionID }` | `{ context: string[] }` | Marks the session as compacting, pushes re-familiarization context. |
| `experimental.compaction.autocontinue` | `{ sessionID }` | `{ enabled: boolean }` | Clears the compacting flag so `chat.message` nudges resume post-compaction. |
| `tool.execute.after` | `{ tool, sessionID, callID, args }` | `{ title, output, metadata }` | Buffers non-`thatch_` tool calls into the in-memory extraction ring buffer (max 20). |
| `chat.message` | `{ sessionID, messageID }` | `{ message, parts }` | Two tiers: extraction nudge if pending, else prompt-aware recall nudge. Skipped while the session is compacting. |
| `event` (`session.created`) | `{ event: { type, properties: { info: { id } } } }` | — | Calls `client.session.prompt` with the reminder + hygiene heartbeat. |
| `dispose` | — | — | Closes the DB. |

Skills install to `$XDG_CONFIG_HOME/opencode/skills` at plugin init — shared
**and** opencode-only (the coordinator needs sub-agents).

## Claude Code (MCP server + hooks)

`thatch setup --claude` (project-local) or `thatch setup --claude --global`.

### Artifacts written (Claude Code)

| Artifact | Project-local | Global (`--global`) |
|----------|--------------|---------------------|
| MCP config | `.mcp.json` (`mcpServers.thatch`, stdio, `["mcp"]`) | none — prints `claude mcp add --scope user thatch -- <bin> mcp` |
| Instructions | `CLAUDE.md` (idempotent `appendBlock`) | `$CLAUDE_CONFIG_DIR/CLAUDE.md` |
| Hooks | `.claude/settings.json` | `$CLAUDE_CONFIG_DIR/settings.json` |
| Skills | `$CLAUDE_CONFIG_DIR/skills/` (always user-scoped) | same |

`CLAUDE_CONFIG_DIR` overrides the default `~/.claude` for all user-scoped
paths. Project-local keeps `.mcp.json`, `CLAUDE.md`, and `.claude/settings.json`
in the repo; only skills are user-scoped.

### Hook events (nested `settings.json`)

```jsonc
{
  "hooks": {
    "SessionStart":     { "hooks": [{ "type": "command", "command": "<bin> reminder" }] },
    "PostToolBatch":    { "hooks": [{ "type": "command", "command": "<bin> buffer-batch" }] },
    "UserPromptSubmit": { "hooks": [{ "type": "command", "command": "<bin> flush-tools" }] }
  }
}
```

| Event | Command | Output | Role |
|-------|---------|--------|------|
| `SessionStart` | `thatch reminder` | plain text to stdout (becomes context) | Recall instructions + hygiene heartbeat |
| `PostToolBatch` | `thatch buffer-batch` | **silent** (no stdout) | Appends a batch of tool calls to the file-backed JSONL queue |
| `UserPromptSubmit` | `thatch flush-tools` | nudge text to stdout | Drains queue (extraction nudge), else recall nudge via sideband, else write nudge |

`PostToolBatch` is silent so the agent loop is not delayed; the buffered
content is invisible until `UserPromptSubmit` flushes it.

## Cursor (MCP server + hooks)

`thatch setup --cursor` (project-local) or `thatch setup --cursor --global`.
Cursor uses the same stdio MCP server as Claude Code; only the hooks differ.

### Artifacts written (Cursor)

| Artifact | Project-local | Global (`--global`) |
|----------|--------------|---------------------|
| MCP config | `.cursor/mcp.json` | `$CURSOR_CONFIG_DIR/mcp.json` (or `~/.cursor/mcp.json`) |
| Instructions | `AGENTS.md` (idempotent `appendBlock`, Cursor-marked) | `$CURSOR_CONFIG_DIR/AGENTS.md` |
| Hooks | `.cursor/hooks.json` (flat) | `$CURSOR_CONFIG_DIR/hooks.json` |
| Skills | `$CURSOR_CONFIG_DIR/skills/` (shared only) | same |

Cursor has no documented env override like `CLAUDE_CONFIG_DIR`; `CURSOR_CONFIG_DIR`
is honored for symmetry and forward-compatibility. Cursor has no equivalent of
`claude mcp add --scope user` — writing `~/.cursor/mcp.json` directly is enough.

### Hook events (flat `hooks.json`)

```jsonc
{
  "version": 1,
  "hooks": {
    "sessionStart":         [{ "command": "<bin> reminder --json" }],
    "postToolUse":          [{ "command": "<bin> buffer-tool" }],
    "beforeSubmitPrompt":   [{ "command": "<bin> flush-tools --json" }]
  }
}
```

| Event | Command | Output | Role |
|-------|---------|--------|------|
| `sessionStart` | `thatch reminder --json` | `{ additional_context: "..." }` | Recall + heartbeat, JSON-wrapped for Cursor |
| `postToolUse` | `thatch buffer-tool` | **silent** | Appends a **single** tool call to the file-backed queue |
| `beforeSubmitPrompt` | `thatch flush-tools --json` | JSON `additional_context` | Drains queue, else recall via sideband, else write nudge |

Differences from Claude Code:

- **Flat format** (`{version, hooks:{event:[{command}]}}`) vs nested.
- `postToolUse` fires **per tool** (Cursor has no `PostToolBatch`); `buffer-tool`
  reads `conversation_id` (vs `session_id`) and normalizes it to a safe filename.
- `--json` on `reminder` and `flush-tools` so Cursor parses the output as
  `additional_context`.

## Idempotence and drift

All setup operations are idempotent:

- **Instructions**: `appendBlock` searches for start/end markers and replaces
  the block between them, so re-running setup updates drifted content without
  clobbering surrounding text. No marker found → append.
- **Hooks**: `replaceThatchHooks` / `replaceCursorThatchHooks` filter out any
  hook group whose command contains `thatch`, then add the current ones. A
  legacy `thatch echo` hook is replaced with `flush-tools`. Non-thatch hooks are
  preserved.
- **MCP config**: existing `mcpServers` are preserved; only the `thatch` entry
  is set.
- **Skills**: `installSkills` only writes when on-disk content differs from the
  definition (drift detection). Skills are plugin-owned — local edits are
  overwritten on the next plugin init or `thatch setup`.

## Binary resolution

`thatch setup` resolves `<bin>` from PATH, falling back to the absolute path of
the running script. This is baked into every installed hook command, so the
hooks keep working after the session that ran setup ends.

## Setup detection at MCP startup

When the MCP server starts (`thatch mcp`, spawned by Claude Code or Cursor),
it calls `checkSetup` (`src/setup.ts`) to verify that `thatch setup` was run
for the current host. This catches two failure modes that would otherwise leave
the agent without usage instructions:

### Host detection

The host is determined from env vars set by the host process:

- `CURSOR_PROJECT_DIR` set → Cursor
- `CLAUDE_PROJECT_DIR` set (and Cursor not) → Claude Code
- Neither set → returns `null` (no check — manual `thatch mcp` invocation)

Cursor takes priority because Cursor also sets `CLAUDE_PROJECT_DIR` as an alias.

### What it checks

`checkSetup` looks for the instruction markers (start and end) in the host's
instructions file — `CLAUDE.md` for Claude Code, `AGENTS.md` for Cursor. It
checks local (in the project directory) first, then global (in the config
directory). Local takes priority.

### Three outcomes

| Outcome | Condition | Action |
|---------|-----------|--------|
| **installed** | Markers found in local or global instructions file | No warning — setup is complete |
| **not-installed** | No instructions file with markers found anywhere | Warning to stderr + prepended to first `tools/call` response: "Tell the user to run `thatch setup --<host>`" |
| **markers-broken** | Start marker found but end marker missing (file edited externally) | Warning with the specific file path and fix instructions: run `thatch setup`, or manually remove the corrupted block and re-run |

The warning is cleared after the first `tools/call` response so it surfaces
once, not on every tool call. The message instructs the LLM to notify the user
with the specific `thatch setup` command to run.
