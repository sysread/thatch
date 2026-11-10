# MCP Parity: OpenCode Plugin vs Claude Code Plugin vs Hooks+MCP Fallback

Thatch supports three integration paths sharing one core (`src/tool-defs.ts`):

1. **OpenCode plugin** — runs inside opencode's Bun runtime (opencode 2.1+,
   v2 plugin API only). Full access to
   plugin hooks: system prompt injection, session events, in-process tool
   buffering, compaction context, and skill installation.
2. **Claude Code plugin regime** — the DEFAULT for current Claude Code
   (2.1.287+, the mods floor; plain `thatch setup --claude` installs it,
   and the marketplace install is the same regime). An in-process mod
   (`src/claude-plugin/`) handles delivery: context injection at each
   prompt, alerts, the chat-wake poller, watcher polling, and the wrap-up
   commands. The MCP server ships BUNDLED in the plugin
   (`thatch mcp --bundled`): it serves the shared tools plus the watch
   family and the plugin-internal stage/lifecycle tools, and holds all
   durable state (mod module state is wiped on reload).
3. **Claude Code hooks + MCP, and Cursor MCP + hooks** — the fallback
   regime: `thatch setup --claude --hooks` for Claude Code older than
   2.1.287 or enterprise policies that disable mods, and plain
   `thatch setup --cursor` for Cursor (which has no mods surface). A
   standalone stdio JSON-RPC MCP server plus settings hooks (Claude
   Code: `SessionStart`, `PostToolBatch`, `UserPromptSubmit`, `Stop`) or
   Cursor hooks (`sessionStart`, `postToolUse`, `beforeSubmitPrompt`,
   `stop`) in a flat `hooks.json` format.

This document maps the feature parity across the paths and documents the
remaining gaps. The plugin regime and the hooks regime never both deliver
on one install: the regime setup deactivates the fallback's delivery
writers (the settings hooks and the `.mcp.json` entry), and a regime
marker beside the DB tells `checkSetup` which story to report.

## Parity matrix

| Feature | OpenCode plugin | Claude Code plugin regime | Claude Code hooks + MCP | Cursor MCP + hooks | Parity |
|---------|----------------|--------------------------|------------------------|---------------------|--------|
| **Tools** (single source of truth) | Plugin tool registration, `thatch_` prefix | Bundled server `tools/list` + `tools/call`, `mcp__plugin_thatch_thatch__` prefix; serves the watch family (the mod's timer is its poller and delivery) and the plugin-internal stage/lifecycle tools | MCP `tools/list` + `tools/call`, `mcp__thatch__` prefix (opencode-only and v2-only tools filtered out) | MCP `tools/list` + `tools/call`, `mcp__thatch__` prefix (opencode-only and v2-only tools filtered out) | **Full** for the shared tools on every path. `get_session_info` (session identity) and `session_search`/`session_get` (conversation archaeology) are opencode-only — they read opencode.db, the wrong corpus on Claude Code; the `thatch session` CLI subcommands cover the same archaeology on any host with an opencode.db file. `session_tab`, `session_tab_open`, and `session_tab_close` are v2-opencode-only — they drive TUI session tabs over the v2 rpc-event bridge. The `chat_*` tools (cross-session chat) are SHARED — MCP hosts declare identity with the `as` argument; only the idle wake differs by path (opencode poller, plugin-regime mod timer, hooks/Cursor at their hook points). The `watch_*` tools serve on opencode and the bundled plugin-regime server; the standalone server (hooks regime, Cursor) has no poller or proactive-prompt channel, so they stay fenced there. `exit`/`compact` (the wrap-ups' greenlight tools) are opencode-only as MCP tools — the plugin regime registers them as mod tools instead |
| **System prompt** (store names, usage rules) | `experimental.chat.system.transform` — dynamic, repo baked in at runtime | One-template instructions rendered in-process by the mod (`prompt.compose`) from `src/prompts.ts`, plus an ENSURED `CLAUDE.md` block (the one instructions channel the built-in security guard never blocks) | CLAUDE.md static text appended by `thatch setup`; repo auto-detected by the MCP server at startup | AGENTS.md static text appended by `thatch setup`; repo auto-detected at startup | **Near-full** — the plugin regime renders the same template in-process; the hooks paths' static text persists through compaction, but the dynamic per-turn refresh is lost |
| **Session-start reminder** (recall nudge + hygiene heartbeat) | `session.created` event → noReply `session.synthetic({resume: false})` delivers the reminder | No dedicated session-start event (the mod's `session.start` fires once per mod load, not per session); the per-prompt stage carries the chat identity line and the recall scan from the first prompt on, but the hygiene heartbeat does not fire | `SessionStart` hook → `thatch reminder`; stdout becomes context | `sessionStart` hook → `thatch reminder --json`; output is `additional_context` JSON | **Partial** on the plugin regime (recall yes, hygiene heartbeat no); **full** on the hooks paths |
| **Compaction context** (re-familiarize after compaction) | `experimental.session.compacting` hook appends context to the compaction output | No compaction hook in the mod; the ensured `CLAUDE.md` block persists through compaction (the mitigation) | `PostCompact` hook — side-effects only, **cannot inject context** | No equivalent hook | **Gapped** on both Claude Code paths — see below |
| **Wrap-up commands** (`/thatch/compact`, `/thatch/exit`) | Registered in code through the CommandEditor (action command FILES sync to `$XDG_CONFIG_HOME/opencode/command/thatch/` at plugin init; the wrap-ups never file-install); the registered execute arms the session; the model greenlights with the kind's zero-arg tool call (`thatch_compact` / `thatch_exit`) and the next idle resolves it into the host action (compact: `session.compact`; exit: the session's own tab closing via the exit-tab-closed event) | The mod registers `/thatch_compact` and `/thatch_exit` (mod command names allow no slash) plus their zero-arg greenlight tools; arm state lives in the bundled server (survives mod reload); `turn.complete` resolves a greenlit arm — compact fires `$.session.compact`, exit reports it is safe to close via `$.ui.notify` (no mod API closes a session) | No equivalent — no plugin host to arm the check or trigger the action | No equivalent | **Full** on opencode; **full-with-degradation** on the plugin regime (exit notifies instead of closing); **gapped** on the hooks paths — needs a plugin host's arming and action routes |
| **On-demand actions** (`/thatch/defrag`, `extract`, `hygiene`, `peer-review`, `refine`, `reflect`, `self-review`, `whois`, `bug-intake`) | Command markdown synced at plugin init; nudge-backed bodies rendered from the shared prompt cores with `thatch_` tool spellings, self-contained bodies (refine, whois, and the review-mode couchings peer-review/self-review) inline in the registry; `extract` and `whois` are opencode-only (they need session identity) | Not commands in this regime — the mod registers only the wrap-ups. The nudge-backed behaviors (defrag, hygiene, reflect) still fire on their own schedule through the per-prompt stage; the skill-backed workflows (refine, the review modes, bug-intake) remain reachable by loading the skills directly | Command markdown synced by `thatch setup --claude --hooks` into `<claudeDir>/commands/thatch/`; same bodies with `mcp__thatch__` spellings; `extract` and `whois` excluded | MCP Prompts (`prompts/list` + `prompts/get`) from the same bodies; Cursor surfaces them as slash commands; `extract` and `whois` excluded | **Full** for the shared actions on opencode and the hooks paths (same bodies, per-host tool spellings); `extract` and `whois` opencode-only; the plugin regime has no action commands (wrap-ups only) |
| **Extraction** (buffer tool calls, extract durable facts) | `tool.execute.after` buffers non-meta tool calls in-process (`isMetaToolName` in `src/extraction.ts`: thatch_*, skill, task, agent, subagent — execute calls unwrapping only thatch tools are also excluded); **direct extraction** is the primary path — when the parent session goes idle with pending buffer entries, the plugin creates a child session via the SDK (`session.create` - top-level in the project directory; the runtime records the parent link) and prompts it to call `get_extraction_payload` (nudge suppressed via the `extracting` set); the prompt-hook nudge path is a **fallback** used when direct extraction throws | The mod's `tool.call` forwards each call to the bundled server's buffer push (the same file-backed JSONL queue, keyed by session); `turn.complete` triggers extraction; the next `prompt.submit` stage delivers the inline payload in the parent's context — no child sessions (no session-creation API), no one-shot hook processes | `PostToolBatch` → `thatch buffer-batch` (file-backed JSONL queue); `UserPromptSubmit` → `thatch flush-tools` peeks the queue and prints the INLINE extraction nudge: processing instructions + the full payload (or the queue-file path when over the host's 10k stdout cap), which the parent processes in its own context — no sub-agent, no fetch; the parent's `extraction_done` ack drains the delivered queue. flush-tools itself does not drain - the queue persists until a memory write or the parent's ack | `postToolUse` → `thatch buffer-tool` (single-tool, file-backed queue); `beforeSubmitPrompt` → `thatch flush-tools --json` | **Partial** — opencode uses direct extraction (parent idle → child session) as the primary path, with the nudge as fallback; the plugin regime and the Claude Code hooks regime take the inline-payload nudge (process in the parent's own context, per docs/plans/claude-code-inline-extraction.md); Cursor is nudge-only with the dispatched extractor. `get_extraction_payload` serves Cursor's extractor and opencode's children; the full payload stays out of Claude Code's context only in the queue file (the inline digest is ~700 chars/interaction max (output capped at 500, args at 120, title at 80)) |
| **Extraction feedback** (toast notifications) | the session-tab bridge's toast event -> the TUI plugin's `ui.toast.show` — fires when the extraction child goes idle, but ONLY when memories were actually written (no toast for no-save runs, to avoid notification fatigue): shows `[thatch] new: N, updated: M, deleted: K` (success); best-effort, silently ignored in headless mode | No TUI connection — no equivalent | No TUI connection — no equivalent | No TUI connection | **Gapped** — no path outside opencode can show toast notifications |
| **Automatic alerts** (notify on LLM pause / turn end) | Plugin event hook drives the `alerts.ts` state machine: `question.asked`/`permission.asked` → pause alert; `session.status` idle with a real-work round → done alert; unrecovered errors → needs-attention. Delivered via the shared `notify.ts` dispatcher, channel per event from the `alerts` config section | The mod forwards `turn.start`/`tool.call`/`turn.complete` (with the abort/error shape from `classic.StopFailure`) and `classic.PermissionRequest`/`resolved` to the bundled server's `plugin_lifecycle`; the SAME `alerts.ts` classifier runs server-side and delivers through the per-platform `notify.ts` dispatcher (banner/voice, like opencode) | No event stream — only `thatch_notify_user` when the agent chooses | No event stream — only `thatch_notify_user` when the agent chooses | **Full** on opencode and the plugin regime; **gapped** on the hooks paths (no event stream to feed the classifier) |
| **Prompt-aware recall nudge** | the `session.hook("prompt")` registration embeds the prompt with the in-process warm model, searches `db.search()`, pushes a nudge part if matches ≥ threshold | `prompt.submit` calls the bundled server's `plugin_stage` in-process — the warm model embeds + searches server-side; the nudge text returns as injected context (no socket, no one-shot process) | `UserPromptSubmit` hook → `thatch flush-tools` connects to the MCP server's sideband socket; the warm server embeds + searches; hook prints the nudge or falls back to the write nudge | `beforeSubmitPrompt` hook → `thatch flush-tools --json` (same sideband path) | **Full** — same tier order everywhere; the sideband gives the hooks' cold processes the warm model, the plugin regime calls in-process |
| **Prediction auto-fire** (user decision model) | the prompt hook scores the prompt embedding against prediction matchers; injects a `[thatch] User decision model` nudge alongside the recall nudge (separate synthetic part, same embedding call) | the prediction tier rides the same `plugin_stage` call (one shared embedding, server-side) | `UserPromptSubmit` hook → `thatch flush-tools` fires prediction query via the sideband socket's `predictions` method in parallel with the recall nudge | `beforeSubmitPrompt` hook → `thatch flush-tools --json` (same sideband path) | **Full** — same `scorePredictionNudge` entry point in every path |
| **Behavior auto-fire** (self-discipline rules) | the prompt hook scores the prompt embedding against behavior matchers; injects a `[thatch] Situational behaviors` nudge (separate synthetic part, same embedding call) | the behavior tier rides the same `plugin_stage` call (one shared embedding, server-side) | `UserPromptSubmit` hook → `thatch flush-tools` fires behavior query via the sideband socket's `behaviors` method in parallel with recall and predictions | `beforeSubmitPrompt` hook → `thatch flush-tools --json` (same sideband path) | **Full** — same `scoreBehaviorNudge` entry point in every path |
| **Skills** | Installed to `$XDG_CONFIG_HOME/opencode/skills` at plugin init (shared **+** opencode-only) | Installed by the regime's setup run into the same scope dirs as the hooks regime — the repo's `.claude/skills/` (local) or `$CLAUDE_CONFIG_DIR/skills/` (global); shared only; skills are NOT bundled in the plugin directory | Installed by `thatch setup --claude --hooks` (shared only) to the repo's `.claude/skills/` (local) or `$CLAUDE_CONFIG_DIR/skills/` (global) | Installed by `thatch setup` (shared only) to the repo's `.cursor/skills/` (local) or `~/.cursor/skills/` (global) | **Full** — same SKILL.md format on every path. `thatch-coordination` is the one opencode-only skill (it drives the v2 session-tab bridge); the code-review coordinator is shared — flat sub-agent dispatch works on Claude Code and Cursor |
| **Store detection** (repo identity from git remote) | `worktree` parameter from the opencode plugin | Same chain: `THATCH_PROJECT_DIR` (pinned in the plugin manifest for project-local) → `CLAUDE_PROJECT_DIR` env → cwd | `THATCH_PROJECT_DIR` (pinned by project-local setup) → `CLAUDE_PROJECT_DIR` env → cwd | `THATCH_PROJECT_DIR` (pinned by project-local setup) → `CURSOR_PROJECT_DIR` then `CLAUDE_PROJECT_DIR` then cwd | **Full** |
| **Setup detection at startup** | n/a — plugin auto-installs at init | the regime marker beside the DB makes `checkSetup` report the plugin install; the mod stamps a liveness file per prompt, and a stale stamp prepends a one-time plugin-not-delivering warning to the bundled server's first `tools/call` (the disabled-mod hole: `disableAllHooks` and managed `allowManagedModsOnly` silence the mod but leave its server) | `checkSetup` in MCP server: detects missing or broken instructions in CLAUDE.md | Same as Claude Code (checks AGENTS.md) | **Full** — every path warns the agent when the install is missing, broken, or silent |
| **Hook config format** | n/a — plugin registers hooks in code | n/a — the mod registers its handlers in code; the plugin manifest (`plugin.json`) lists the bundled MCP server | Nested: `.claude/settings.json` `{hooks:{Event:{hooks:[{type,command}]}}}` | Flat: `.cursor/hooks.json` `{version:1,hooks:{event:[{command}]}}` | n/a |

## Tool name conventions

The shared tool definitions in `src/tool-defs.ts` use bare names
(`memory_remember`, `memory_recall`, ...). Each host prefixes them differently:

- **opencode**: `thatch_memory_remember` — the prefix is added by the
  `tool()` wrapper in `src/tools.ts`.
- **Claude Code (plugin regime)**: `mcp__plugin_thatch_thatch__memory_remember`
  — the host prefixes the plugin manifest's bundled server with the plugin
  namespace; nudges rendered by the stage use this spelling.
- **Claude Code (hooks regime)**: `mcp__thatch__memory_remember` — Claude Code
  auto-prefixes with the server name; the MCP server exposes
  `memory_remember`.
- **Cursor**: `mcp__thatch__memory_remember` — same standalone MCP server.

The CLAUDE.md / AGENTS.md instructions generated by `thatch setup` reference
both forms — the full `mcp__thatch__*` names for the host, and bare names for
readability.

## Why the gaps exist

### Compaction context

OpenCode's `experimental.session.compacting` hook lets the plugin append text
to the compaction output — the agent sees a "you are using thatch, here's what
you've learned" message after compaction. Claude Code's `PostCompact` hook is
side-effects only (logging, external state); it has no `additionalContext`
field and no decision control, and the plugin regime's mod has no compaction
event at all. Cursor has no equivalent hook.

**Mitigation**: the CLAUDE.md / AGENTS.md instructions block is loaded at
session start and persists
through compaction, so the agent retains the usage instructions (the plugin
regime ENSURES this block; the mod also re-renders its instructions from
the one template at every session start). The
`SessionStart` / `sessionStart` hook with `source: "compact"` fires after
compaction in the hooks regime, so the recall reminder runs again. There is no
explicit "re-familiarization" nudge on any non-opencode path.

### Extraction timing

OpenCode's extraction pipeline has two paths — direct extraction (primary)
and the nudge (fallback):

**Direct extraction (primary path):**

1. `tool.execute.after` buffers every non-meta tool
   call (`isMetaToolName` in `src/extraction.ts`) into a per-session in-memory array (max 20 interactions).
2. When the parent session goes idle (`session.status` idle event) with pending
   buffer entries, the plugin calls `triggerExtraction`: creates a child session
   via `session.create` (top-level in the project directory), then prompts it via
   `session.prompt` with the extraction prompt (the
   parent's session ID is interpolated into the prompt by the plugin). The
   `extracting` set gates re-triggering while the child runs.
3. The child session runs the `thatch-fact-extractor` skill, writes memories via
   `thatch_memory_remember`. The child's payload fetch records its claim; its
   memory write (or `extraction_done`) completes that claim - consuming only
   the entries it received.
4. When the child goes idle, the handler finalizes the claim-scoped
   completion, deletes the child session, and fires a toast via the
   session-tab bridge's toast event.

**Failure recovery (no model-facing nudge exists on opencode):**

1. If `triggerExtraction` throws (session creation or prompt fails), the catch
   block clears the `extracting` flag. The pending buffer is untouched, and
   the next idle re-triggers extraction - the plugin retries without any
   model cooperation.
2. If the child errors or is deleted before completing, what it held is
   requeued to pending. If its completion signal never comes at all, the
   15-minute stale reaper returns accepted entries to pending. Either way
   the next idle re-extracts - no interaction is silently lost.

Claude Code and Cursor use a **file-backed** queue (`src/extract-queue.ts`)
because hooks fire one-shot with no cross-call state. The plugin regime
keeps the same queue for a different reason: the mod's module state is
wiped on every reload, so the durable backing lives in files the bundled
server owns:

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
prompt text. In opencode, the model is warm in-process — the prompt hook
calls `model.queryEmbed()` directly. The plugin regime is in the same
position: the mod's `prompt.submit` handler calls the bundled server's
`plugin_stage` in-process, so the warm model is right there. The hooks
regime and Cursor are the remaining problem: their hooks are
one-shot `bun` spawns that can't reach the MCP server's in-memory model.

Loading the ~34 MB model on every `UserPromptSubmit` would add ~300-700 ms to
every prompt in the critical path before the agent responds. The sideband
socket eliminates this cost; see the next section.

## Sideband socket architecture

The sideband exists for the hooks regime and Cursor only; the plugin
regime never binds or connects it (the bundled server skips the sideband,
the version file, and auto-refresh - all three exist to bridge one-shot
hook processes, and the mod calls in-process).

```text
Claude Code (hooks regime) / Cursor session
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
    └── reads the hook's stdin session id: chat identity + mail line
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

### Validation: passthrough for the guard tools, strict declared surfaces

A typo'd argument key ("labels" for "label") must survive host validation
and reach the accept-then-teach guards in `src/tool-defs.ts`, which answer
"you passed 'labels'; did you mean 'label'?" (matcher in `src/fuzzy.ts`).
The MCP server and the opencode v2 plugin each get this with a different
mechanism:

- **MCP server:** the validator (built in `compileTools`) is a
  deep-passthrough clone - nested section objects included, so a typo'd
  config_set FIELD also reaches execute. The declared `tools/list`
  inputSchema is the strict `z.object` conversion (`additionalProperties:
  false` at every level): no host validates between caller and tool on
  MCP, so the declared schema IS the public contract, and it stays
  strict. A client that strips unknown keys against the declared schema
  before sending degrades to the plain teaching text - nothing breaks.
- **opencode v2:** opencode-core validates (and its tool-input repair
  strips unknown fields of closed objects) against the DECLARED schema,
  so the declaration itself must permit what the guards teach. Only the
  four guard-bearing tools (`memory_remember`, `memory_show`,
  `memory_forget`, `config_set`) declare deep-passthrough schemas - deep,
  because a strict nested section would be stripped or rejected before
  execute could teach the correction. Every other tool declares the
  strict conversion (`additionalProperties: false`): the declared surface
  is the honest contract, and a permissive additionalProperties renders
  as a `[key: string]: unknown` index signature in the Code Mode catalog.
  Passthrough only ever admits unknown keys; declared keys keep their
  required shape (the accept-then-teach keys are schema-optional so host
  validation cannot preempt the guards). A test pins both halves in
  `tests/opencode-v2-adapter-caps.test.ts`.
