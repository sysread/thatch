# Setup and Hook Configuration

How `thatch setup` wires each host, and which hook events each path relies on.
For feature parity and gaps, see `mcp-parity.md`. This document is the concrete
artifact reference.

## OpenCode (plugin)

No `setup` command — opencode loads the plugin from `opencode.json`:

```jsonc
{ "plugin": ["@jeffober/thatch"] }
```

The plugin targets opencode 2.x through the promise-context domains
(`session.hook("prompt"/"context"/"compaction")`, `tool.transform`,
`command.transform`, `event.subscribe`), registered in code
(`src/opencode/v2.ts`) and delegating to the shared runtime
(`src/runtime.ts`). The registrations:

| Registration | Shape | Behavior |
|------|-------|----------|
| `session.hook("context")` | `{ sessionID, system, messages }` (mutated in place) | Pushes the system prompt (store names, usage rules) into the request's system array; appends the turn's stored nudge injections to the matched user message. |
| `session.hook("compaction")` | `{ sessionID, system }` (mutated in place) | Marks the session as compacting, pushes re-familiarization context. |
| `tool.hook("execute.after")` | `{ tool, sessionID, input, status, result }` | Buffers non-`thatch_`, non-`skill`, non-`task` tool calls into the in-memory extraction ring buffer (max 20). In child sessions, also tracks new/updated/deleted counts via `childMetrics` for the extraction toast. |
| `session.hook("prompt")` | `{ sessionID, messageID, prompt }` | Prompt-aware recall nudge (plus prediction/behavior auto-fire). No extraction nudge - extraction is plugin-driven at session idle. Suppressed while compacting or for task-dispatched sub-agent sessions (children that are not extraction children). |
| `event.subscribe` | `{ type, data, location? }` bus events | Dispatches on translated `type`: `session.created` (top-level) → noReply reminder (resume:false synthetic) with hygiene heartbeat; `session.created` (child with `parentID`) → records `childToParent` + snapshots parent's pending buffer. Idle (parent, pending interactions) → `triggerExtraction` (direct child-session extraction); idle (child) → complete/drain, toast with metrics, delete child. Error (child) → requeue parent's accepted entries. `session.deleted` → requeue if child, drop accepted if parent, clean maps. `session.compaction.ended` → clear compacting flag. |
| cleanup (from `setup`) | — | Closes the DB; idempotent for plugin reloads. |

Skills install to `$XDG_CONFIG_HOME/opencode/skills` at plugin init — shared
**and** opencode-only (the coordinator needs sub-agents).

Direct extraction is the primary path for opencode: when a parent session goes
idle with pending tool interactions, the event pump creates a child session
and prompts it directly via `triggerExtraction`. The prompt-hook extraction
nudge is a fallback — it fires only if direct extraction was never triggered or
threw an error (the `extracting` set is cleared on failure).

Toasts ride the session-tab rpc bridge's toast event (on child idle, with
extraction metrics: new/updated/deleted counts) and from the prompt hook (on
recall, prediction, and behavior matches). Best-effort — silently ignored if
the TUI is not connected (headless mode).

## Claude Code (MCP server + hooks)

`thatch setup --claude` (project-local) or `thatch setup --claude --global`.

### Artifacts written (Claude Code)

| Artifact | Project-local | Global (`--global`) |
|----------|--------------|---------------------|
| MCP config | `.mcp.json` (`mcpServers.thatch`, stdio, `["mcp"]`) | none — prints `claude mcp add --scope user thatch -- <bin> mcp` |
| Instructions | `CLAUDE.md` (idempotent `appendBlock`) | `$CLAUDE_CONFIG_DIR/CLAUDE.md` |
| Hooks | `.claude/settings.json` | `$CLAUDE_CONFIG_DIR/settings.json` |
| Skills | `.claude/skills/` (in the repo) | `$CLAUDE_CONFIG_DIR/skills/` |
| Commands | `.claude/commands/thatch/` (in the repo) | `$CLAUDE_CONFIG_DIR/commands/thatch/` |

`CLAUDE_CONFIG_DIR` overrides the default `~/.claude` for all user-scoped
paths. Project-local keeps everything in the repo: `.mcp.json`, `CLAUDE.md`,
`.claude/settings.json`, `.claude/skills/`, and `.claude/commands/thatch/`
(so skills and commands version with the
project and every contributor gets them).

### Hook events (nested `settings.json`)

```jsonc
{
  "hooks": {
    "SessionStart":     { "hooks": [{ "type": "command", "command": "<bin> reminder" }] },
    "PostToolBatch":    { "hooks": [{ "type": "command", "command": "<bin> buffer-batch" }] },
    "UserPromptSubmit": { "hooks": [{ "type": "command", "command": "<bin> flush-tools" }] },
    "Stop":             { "hooks": [{ "type": "command", "command": "<bin> chat-notify" }] }
  }
}
```

| Event | Command | Output | Role |
|-------|---------|--------|------|
| `SessionStart` | `thatch reminder` | plain text to stdout (becomes context) | Recall instructions + hygiene heartbeat + chat identity/mail line (reads the hook's stdin `session_id`) |
| `PostToolBatch` | `thatch buffer-batch` | **silent** (no stdout) | Appends a batch of tool calls to the file-backed JSONL queue |
| `UserPromptSubmit` | `thatch flush-tools` | nudge text to stdout | Peeks queue (extraction nudge; degraded to a restart instruction under version skew - the old server may lack the referenced tools), else fires recall, prediction, and behavior nudges via sideband in parallel, else write nudge |
| `Stop` | `thatch chat-notify` | `{ hookSpecificOutput: { additionalContext } }` when chat mail is unread, else `{}` | Post-turn chat wake: the turn continues so the model reads its mail (Claude Code's analog of opencode's poller wake); host loop protections (`stop_hook_active`, 8-consecutive cap) plus the delivered stamp bound repeats |

`PostToolBatch` is silent so the agent loop is not delayed; the buffered
content is invisible until `UserPromptSubmit` peeks it.

## Cursor (MCP server + hooks)

`thatch setup --cursor` (project-local) or `thatch setup --cursor --global`.
Cursor uses the same stdio MCP server as Claude Code; only the hooks differ.

### Artifacts written (Cursor)

| Artifact | Project-local | Global (`--global`) |
|----------|--------------|---------------------|
| MCP config | `.cursor/mcp.json` | `$CURSOR_CONFIG_DIR/mcp.json` (or `~/.cursor/mcp.json`) |
| Instructions | `AGENTS.md` (idempotent `appendBlock`, Cursor-marked) | `$CURSOR_CONFIG_DIR/AGENTS.md` |
| Hooks | `.cursor/hooks.json` (flat) | `$CURSOR_CONFIG_DIR/hooks.json` |
| Skills | `.cursor/skills/` (in the repo) | `$CURSOR_CONFIG_DIR/skills/` |

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
    "beforeSubmitPrompt":   [{ "command": "<bin> flush-tools --json" }],
    "stop":                 [{ "command": "<bin> chat-notify", "loop_limit": 3 }]
  }
}
```

| Event | Command | Output | Role |
|-------|---------|--------|------|
| `sessionStart` | `thatch reminder --json` | `{ additional_context: "..." }` | Recall + heartbeat + chat identity/mail line, JSON-wrapped for Cursor |
| `postToolUse` | `thatch buffer-tool` | **silent** | Appends a **single** tool call to the file-backed queue |
| `beforeSubmitPrompt` | `thatch flush-tools --json` | JSON `additional_context` | Peeks queue (extraction nudge; degraded to a restart instruction under version skew), else recall, prediction, and behavior via sideband, else write nudge |
| `stop` | `thatch chat-notify` | `{ followup_message }` or `{}` | Post-turn chat wake: when chat mail is unread, Cursor auto-submits the follow-up as the next user message (Cursor's analog of opencode's poller wake); `loop_limit: 3` bounds consecutive follow-ups |

Differences from Claude Code:

- **Flat format** (`{version, hooks:{event:[{command}]}}`) vs nested.
- `postToolUse` fires **per tool** (Cursor has no `PostToolBatch`); `buffer-tool`
  reads `conversation_id` (vs `session_id`) and normalizes it to a safe filename.
- `--json` on `reminder` and `flush-tools` so Cursor parses the output as
  `additional_context`.

## Idempotence and drift

All setup operations are idempotent:

- **Instructions**: `appendBlock` wraps the block in sentinel comments
  (`<!-- thatch:begin -->` / `<!-- thatch:end -->`) and replaces the block
  between them, so re-running setup updates drifted content without
  clobbering surrounding text. No marker found → append. Pre-sentinel
  installs used prose sentences from the instructions themselves as
  delimiters; `appendBlock` migrates intact legacy blocks and heals the
  broken kind (an agent edit normalizing punctuation - hyphens to em
  dashes - breaks the prose end marker) when the file tail still looks
  like the instructions; anything else is left for manual repair.
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

Separately from host detection, the project directory used for store/chat
identity resolution resolves as `THATCH_PROJECT_DIR ?? CURSOR_PROJECT_DIR
?? CLAUDE_PROJECT_DIR ?? cwd` in the MCP server; project-local `thatch
setup` runs pin `THATCH_PROJECT_DIR` into the written MCP config.

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
