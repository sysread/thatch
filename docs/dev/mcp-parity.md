# MCP Parity: OpenCode Plugin vs Claude Code vs Cursor

Thatch supports three integration paths sharing one core (`src/tool-defs.ts`):

1. **OpenCode plugin** — runs inside opencode's Bun runtime. Full access to
   plugin hooks: system prompt injection, session events, in-process tool
   buffering, compaction context, and skill installation.
2. **Claude Code MCP server** — runs as a stdio JSON-RPC process. Tools are
   exposed via MCP `tools/list` + `tools/call`. Session behavior is driven by
   Claude Code hooks (`SessionStart`, `PostToolBatch`, `UserPromptSubmit`).
3. **Cursor MCP server** — same stdio MCP server as Claude Code. Session
   behavior is driven by Cursor hooks (`sessionStart`, `postToolUse`,
   `beforeSubmitPrompt`) in a flat `hooks.json` format.

This document maps the feature parity and documents the remaining gaps.

## Parity matrix

| Feature | OpenCode plugin | Claude Code MCP + hooks | Cursor MCP + hooks | Parity |
|---------|----------------|------------------------|---------------------|--------|
| **Tools** (18, single source of truth) | Plugin tool registration, `thatch_` prefix | MCP `tools/list` + `tools/call`, `mcp__thatch__` prefix | MCP `tools/list` + `tools/call`, `mcp__thatch__` prefix | **Full** |
| **System prompt** (store names, usage rules) | `experimental.chat.system.transform` — dynamic, repo baked in at runtime | CLAUDE.md static text appended by `thatch setup`; repo auto-detected by the MCP server at startup | AGENTS.md static text appended by `thatch setup`; repo auto-detected at startup | **Approximate** — static text persists through compaction, so the agent retains the usage instructions, but the dynamic per-turn refresh is lost |
| **Session-start reminder** (recall nudge + hygiene heartbeat) | `session.created` event → `client.session.prompt` injects a synthetic message | `SessionStart` hook → `thatch reminder`; stdout becomes context | `sessionStart` hook → `thatch reminder --json`; output is `additional_context` JSON | **Full** |
| **Compaction context** (re-familiarize after compaction) | `experimental.session.compacting` hook appends context to the compaction output | `PostCompact` hook — side-effects only, **cannot inject context** | No equivalent hook | **Gapped** — see below |
| **Extraction** (buffer tool calls, extract durable facts) | `tool.execute.after` buffers non-thatch, non-skill, non-task tool calls in-process; **direct extraction** is the primary path — when the parent session goes idle with pending buffer entries, the plugin creates a child session via the SDK (`client.session.create` with `parentID`) and prompts it to call `get_extraction_payload` (nudge suppressed via the `extracting` set); the `chat.message` nudge path is a **fallback** used when direct extraction throws | `PostToolBatch` → `thatch buffer-batch` (file-backed JSONL queue); `UserPromptSubmit` → `thatch flush-tools` peeks the queue and prints the nudge with session ID + fetch tool name (does not drain — the queue persists until a memory write or `extraction_done`) | `postToolUse` → `thatch buffer-tool` (single-tool, file-backed queue); `beforeSubmitPrompt` → `thatch flush-tools --json` | **Partial** — opencode uses direct extraction (parent idle → child session) as the primary path, with the nudge as fallback; MCP hosts are nudge-only. Both paths use `get_extraction_payload` to fetch the queued interactions as a tool response, keeping the full payload out of the main session's context window. Nudge timing differs: the nudge arrives at the **start** of the next turn in Claude Code/Cursor; opencode's direct extraction fires at **end of turn** (session idle), and the nudge fallback fires at the start of the next turn like MCP |
| **Extraction feedback** (toast notifications) | `client.tui.showToast` fires when the extraction child goes idle — shows `[thatch] new: N, updated: M, deleted: K` (success) or `extraction complete — nothing to save` (info); best-effort, silently ignored in headless mode | No TUI connection — MCP hosts have no equivalent | No TUI connection | **Gapped** — MCP hosts cannot show toast notifications |
| **Prompt-aware recall nudge** | `chat.message` hook embeds the prompt with the in-process warm model, searches `db.search()`, pushes a nudge part if matches ≥ threshold | `UserPromptSubmit` hook → `thatch flush-tools` connects to the MCP server's sideband socket; the warm server embeds + searches; hook prints the nudge or falls back to the write nudge | `beforeSubmitPrompt` hook → `thatch flush-tools --json` (same sideband path) | **Full** — sideband socket gives cold hook processes access to the warm MCP server's model |
| **Prediction auto-fire** (user decision model) | `chat.message` hook scores the prompt embedding against prediction matchers; injects a `[thatch] User decision model` nudge alongside the recall nudge (separate synthetic part, same embedding call) | `UserPromptSubmit` hook → `thatch flush-tools` fires prediction query via the sideband socket's `predictions` method in parallel with the recall nudge | `beforeSubmitPrompt` hook → `thatch flush-tools --json` (same sideband path) | **Full** — same `scorePredictionNudge` entry point in both paths |
| **Behavior auto-fire** (self-discipline rules) | `chat.message` hook scores the prompt embedding against behavior matchers; injects a `[thatch] Situational behaviors` nudge (separate synthetic part, same embedding call) | `UserPromptSubmit` hook → `thatch flush-tools` fires behavior query via the sideband socket's `behaviors` method in parallel with recall and predictions | `beforeSubmitPrompt` hook → `thatch flush-tools --json` (same sideband path) | **Full** — same `scoreBehaviorNudge` entry point in both paths |
| **Skills** | Installed to `$XDG_CONFIG_HOME/opencode/skills` at plugin init (shared **+** opencode-only) | Installed to `$CLAUDE_CONFIG_DIR/skills/` by `thatch setup` (shared only) | Installed to `~/.cursor/skills/` by `thatch setup` (shared only) | **Full** — same SKILL.md format; the code-review coordinator is opencode-only (needs sub-agents) |
| **Store detection** (repo identity from git remote) | `worktree` parameter from the opencode plugin | `CLAUDE_PROJECT_DIR` env (set by Claude Code for stdio MCP servers) | `CURSOR_PROJECT_DIR` then `CLAUDE_PROJECT_DIR` then cwd | **Full** |
| **Setup detection at startup** | n/a — plugin auto-installs at init | `checkSetup` in MCP server: detects missing or broken instructions in CLAUDE.md | Same as Claude Code (checks AGENTS.md) | **Full** — warns the agent to tell the user to run `thatch setup` |
| **Hook config format** | n/a — plugin registers hooks in code | Nested: `.claude/settings.json` `{hooks:{Event:{hooks:[{type,command}]}}}` | Flat: `.cursor/hooks.json` `{version:1,hooks:{event:[{command}]}}` | n/a |

## Tool name conventions

The shared tool definitions in `src/tool-defs.ts` use bare names
(`memory_remember`, `memory_recall`, ...). Each host prefixes them differently:

- **opencode**: `thatch_memory_remember` — the prefix is added by the
  `tool()` wrapper in `src/tools.ts`.
- **Claude Code**: `mcp__thatch__memory_remember` — Claude Code auto-prefixes
  with the server name; the MCP server exposes `memory_remember`.
- **Cursor**: `mcp__thatch__memory_remember` — same MCP server.

The CLAUDE.md / AGENTS.md instructions generated by `thatch setup` reference
both forms — the full `mcp__thatch__*` names for the host, and bare names for
readability.

## Why the gaps exist

### Compaction context

OpenCode's `experimental.session.compacting` hook lets the plugin append text
to the compaction output — the agent sees a "you are using thatch, here's what
you've learned" message after compaction. Claude Code's `PostCompact` hook is
side-effects only (logging, external state); it has no `additionalContext`
field and no decision control. Cursor has no equivalent hook.

**Mitigation**: CLAUDE.md / AGENTS.md is loaded at session start and persists
through compaction, so the agent retains the usage instructions. The
`SessionStart` / `sessionStart` hook with `source: "compact"` fires after
compaction in Claude Code, so the recall reminder runs again. There is no
explicit "re-familiarization" nudge for hosts without a compaction hook.

### Extraction timing

OpenCode's extraction pipeline has two paths — direct extraction (primary)
and the nudge (fallback):

**Direct extraction (primary path):**

1. `tool.execute.after` buffers every non-thatch, non-skill, non-task tool
   call into a per-session in-memory array (max 20 interactions).
2. When the parent session goes idle (`session.status` idle event) with pending
   buffer entries, the plugin calls `triggerExtraction`: creates a child session
   via `client.session.create` (with `parentID`), then prompts it via
   `client.session.promptAsync` (or `prompt`) with the extraction payload. The
   `extracting` set suppresses the nudge in `chat.message` while the child runs.
3. The child session runs the `thatch-fact-extractor` skill, writes memories via
   `thatch_memory_remember`. A memory write in the child drains the parent's
   buffer snapshot (via the `childToParent` Map and `consumeSnapshot`) and
   resets the missed-nudge counter.
4. When the child goes idle, the handler drains any remaining snapshot entries
   (covers no-save runs), deletes the child session, and fires a toast via
   `client.tui.showToast`.

**Nudge (fallback path):**

1. If `triggerExtraction` throws (session creation or prompt fails), the catch
   block clears the `extracting` flag. On the next `chat.message`, the buffer is
   **peeked** (not drained) and a synthetic text part carrying the JSON payload
   is injected into the conversation. The buffer persists until the agent writes
   a memory or calls `thatch_extraction_done`, so ignored nudges repeat and
   escalate (polite → insistent → ALL-CAPS) via the `missedNudges` counter.
2. The agent sees the nudge, loads the `thatch-fact-extractor` skill, and saves
   durable facts via `thatch_memory_remember`. A memory write in the session
   (or a child sub-agent via the `childToParent` Map) or `thatch_extraction_done`
   drains the buffer and resets the missed-nudge counter.

Claude Code and Cursor use a **file-backed** queue (`src/extract-queue.ts`)
because hooks fire one-shot with no cross-call state:

1. `PostToolBatch` (Claude Code) / `postToolUse` (Cursor) appends each tool
   interaction to a per-session JSONL file under `$XDG_CACHE_HOME/thatch/queue/`
   (max 20, oldest dropped). These commands are silent — no stdout — so the
   agent loop is not delayed.
2. `UserPromptSubmit` / `beforeSubmitPrompt` runs `thatch flush-tools`, which
   peeks the queue (does not drain it) and prints the JSON payload. The queue
   persists until the agent writes a memory or calls `thatch_extraction_done`,
   so ignored nudges accumulate and escalate (polite → insistent → ALL-CAPS)
   via the file-backed missed-nudge counter. This arrives at the **start**
   of the next turn (before the model processes the prompt), not at the end of
   the current one.

The two paths produce the same JSON shape via `buildExtractionPayload()`, so
the fact-extractor skill receives an identical contract regardless of host.

### Recall nudge without a warm model

The prompt-aware recall nudge needs the embedding model to embed the user's
prompt text. In opencode, the model is warm in-process — the `chat.message`
hook calls `model.queryEmbed()` directly. In Claude Code/Cursor, hooks are
one-shot `bun` spawns that can't reach the MCP server's in-memory model.

Loading the ~34 MB model on every `UserPromptSubmit` would add ~300-700 ms to
every prompt in the critical path before the agent responds. The sideband
socket eliminates this cost; see the next section.

## Sideband socket architecture

```text
Claude Code / Cursor session
├── MCP server (long-lived, warm model)
│   ├── stdio JSON-RPC (tool calls)
│   └── Unix socket sideband (embed + search for hooks)
├── UserPromptSubmit / beforeSubmitPrompt hook → thatch flush-tools [--json]
│   ├── peeks the file-backed extraction queue (does not drain)
│   ├── connects to sideband socket
│   ├── sends prompt text
│   ├── receives match labels + scores
│   └── prints recall nudge or falls back to write nudge
├── PostToolBatch → thatch buffer-batch (Claude Code)
│   └── postToolUse → thatch buffer-tool (Cursor)
└── SessionStart / sessionStart hook → thatch reminder [--json]
```

The socket path is derived from a SHA-256 hash of the DB path — both the MCP
server and hook processes resolve the same DB path independently (from
`THATCH_DB_PATH` or the default under `XDG_CONFIG_HOME`), so they arrive at the
same socket path without out-of-band coordination. The path lives under
`os.tmpdir()`.

The protocol is newline-delimited JSON: one request per connection, one
response. Requests are `{"method":"match|predictions|behaviors",
"text":"...","stores":[...],"threshold":N,"limit":N}`. Responses are
`{"ok":true,"matches":[...]}` / `{"ok":true,"predictions":[...]}` /
`{"ok":true,"behaviors":[...]}` or `{"ok":false,"error":"..."}`.

Graceful degradation: if the socket isn't available (MCP server not running,
old version, stale socket from a crash, or a >2 s timeout), `sidebandMatch`
returns `null` and `flush-tools` falls back to the static write nudge. The
recall nudge is best-effort — its absence never blocks the agent's workflow. A
stale socket file left by a crash is cleaned up on connection error.

## Architecture implications

The shared tool definitions in `src/tool-defs.ts` are the single source of
truth for all three paths. The opencode plugin wraps them in `tool()` with zod
schemas and a `thatch_` prefix; the MCP server (used by both Claude Code and
Cursor) wraps them in `z.object()` for validation and `z.toJSONSchema()` for
the protocol response. See `docs/dev/setup-and-hooks.md` for the concrete
files, hook event names, and command shapes each host writes.
