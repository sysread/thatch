# Thatch

Persistent memory for AI coding agents. Thatch gives your agent the ability to
remember information across sessions using local embeddings and SQLite. It
works with **OpenCode** (as a plugin), **Claude Code** (as an MCP server), and
**Cursor** (as an MCP server).

## Feature docs

This README is the overview. Each feature has its own guide:

- [memory.md](memory.md): persistent memory store
- [extraction.md](extraction.md): automatic fact extraction from tool calls
- [watchers.md](watchers.md): event-driven notifications (PR and branch watching)
- [cross-session-chat.md](cross-session-chat.md): sessions messaging each other on one machine
- [notifications.md](notifications.md): banner and voice notifications, user config
- [prediction-engine.md](prediction-engine.md): user decision model
- [behavior-engine.md](behavior-engine.md): agent self-discipline rules
- [default-behaviors.md](default-behaviors.md): what ships automatically
- [hygiene.md](hygiene.md): store maintenance signals
- [deduplication.md](deduplication.md): duplicate detection and resolution
- [skills.md](skills.md): structured workflow skills
- [code-review.md](code-review.md): multi-agent code review pipeline
- [setup.md](setup.md): installation and configuration
- [cli.md](cli.md): command-line tool reference

## Installation

### OpenCode

Publish to npm and add thatch to your opencode config:

```jsonc
// opencode.jsonc or opencode.json
{
  "plugin": ["@jeffober/thatch"]
}
```

OpenCode installs the plugin and its dependencies automatically on next start.

For async extraction (child sessions run in the background):

```bash
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

Without this env var, extraction still works. The child session runs
fire-and-forget instead of asynchronously. Put it in your shell rc,
`mise.toml` `[env]`, or `.envrc`.

For local development before publishing, use a file path:

```jsonc
{ "plugin": ["./path/to/thatch/src/index.ts"] }
```

Or place the thatch repo in `.opencode/plugins/` for auto-loading.

### Claude Code

Install the MCP server, hooks, instructions, and skills into Claude Code:

```bash
thatch setup --claude            # project-local (writes .mcp.json, CLAUDE.md, .claude/)
thatch setup --claude --global   # user-scoped (~/.claude/)
```

`bun` must be on PATH (the thatch binary runs under bun). `setup` is idempotent.
Re-running it updates drifted content without clobbering unrelated config.
For a global install, `setup` prints the `claude mcp add --scope user` command
to run instead of writing a project `.mcp.json`.

### Cursor

```bash
thatch setup --cursor            # project-local (.cursor/mcp.json, AGENTS.md, .cursor/hooks.json)
thatch setup --cursor --global   # user-scoped (~/.cursor/)
```

Cursor has no `claude mcp add` equivalent. `setup` writes `~/.cursor/mcp.json`
directly. Hook output is JSON-wrapped (`--json`) so Cursor injects it as
`additional_context`.

### Before running setup

The `thatch` binary must resolve `bun` on PATH. Install from npm (`npm i -g
@jeffober/thatch`) or from a checkout (`bun run bin/thatch`).

## How it works

### Stores

Every git repo gets its own store, named after the repo's remote identity
(e.g., `sysread/thatch`). There is also a shared `global` store for
information that applies across all projects.

Stores are created automatically. No setup required.

### Memory tools

| Tool | What it does |
|------|-------------|
| `thatch_memory_remember` | Save a piece of information. Label it, and thatch embeds it for later recall. |
| `thatch_memory_recall` | Search for relevant information using natural language. Searches both the current project's store and `global` by default. |
| `thatch_memory_list` | List all memory labels in a store. |
| `thatch_memory_show` | Read the full content of a memory by exact label. |
| `thatch_memory_forget` | Delete a memory by label. |

### Store tools

| Tool | What it does |
|------|-------------|
| `thatch_store_list` | List all available stores. |

### Deduplication tools

| Tool | What it does |
|------|-------------|
| `thatch_find_duplicates` | Surface pairs of memories with suspiciously similar content. |
| `thatch_dedup_mark_checked` | Record the verdict for a reviewed pair so it stops being re-reported. |

### Extraction tools

| Tool | What it does |
|------|-------------|
| `thatch_extraction_done` | Acknowledge extraction buffer work. In the nudge fallback path, quiets the nudge while holding entries until the extractor completes. In a child extractor session, marks entries complete. Called by the model after dispatching the fact-extractor skill. |
| `thatch_get_extraction_payload` | Retrieve the queued tool interactions for the fact-extractor sub-agent. Fetches by session ID so the full payload stays out of the main session's context window. |

### Prediction tools

| Tool | What it does |
|------|-------------|
| `thatch_prediction_query` | Query the user decision model for scored predictions matching a context. Returns predictions with confidence and evidence count. |
| `thatch_prediction_update` | Create, reinforce, or weaken a prediction. Takes a matcher (context description), a prediction (preference statement), and a signal (confirm/disconfirm/soft/create). |
| `thatch_prediction_list` | List all predictions in a store with matchers, confidence, and provenance. |
| `thatch_prediction_delete` | Delete a prediction by semantic match. Edges and provenance are cascade-deleted. |

### Behavior tools

| Tool | What it does |
|------|-------------|
| `thatch_behavior_codify` | Codify a self-discipline rule: when situation X arises, the agent should do Y. For the agent's own operational discipline, not user preferences. |
| `thatch_behavior_feedback` | Record ham/spam feedback on a surfaced behavior. `relevant: true` (ham) confirms the rule applies; `relevant: false` (spam) disconfirms. Trains the classifier. |
| `thatch_behavior_list` | List all codified behaviors with matchers, confidence, and provenance. |
| `thatch_behavior_delete` | Delete a behavior by semantic match. Edges and provenance are cascade-deleted. |

### Config tools

| Tool | What it does |
|------|-------------|
| `thatch_config_get` | Read the user config (`~/.config/thatch/config.json`), with defaults annotated. The agent manages config through these tools; you can also edit the file by hand. |
| `thatch_config_set` | Update config fields. Field-level merge: only fields you pass change. Returns the resulting section so the agent can verify. |

### Notification tools

| Tool | What it does |
|------|-------------|
| `thatch_notify_user` | Notify the user out-of-band: desktop banner and/or spoken voice. Use for long-running outcomes worth interrupting for (CI results, deploys, watcher events). macOS and Linux. |

See [notifications.md](notifications.md) for the full behavior and
configuration.

### Session tools (opencode only)

| Tool | What it does |
|------|-------------|
| `thatch_get_session_info` | Report the current session's ID and the agent name running this turn. opencode doesn't surface its session ID to the model; the agent needs it to fetch extraction payloads or look up past sessions. MCP hosts have no session concept, so this tool doesn't exist there. |
| `thatch_session_search` | Search past opencode conversations by substring or regex. Matches decoded message text, tool outputs, and reasoning across all sessions. Returns JSONL hits with ids for follow-up. |
| `thatch_session_get` | Retrieve the full content of one part or message found via `thatch_session_search`, including complete tool inputs and outputs. |

The same functionality is available on the command line as `thatch session
list`, `thatch session get`, `thatch session transcript`, and `thatch session
search` - JSONL output designed for piping to `jq` or `grep`.

### Watcher tools (opencode only)

| Tool | What it does |
|------|-------------|
| `thatch_watch_create` | Watch a GitHub PR for events (comments, review comments and replies, thread resolutions, commits, status changes, description edits, CI completions). The plugin polls in the background and prompts the session when a watched event happens. |
| `thatch_watch_branch_create` | Watch a GitHub branch (typically main) for commit landings, CI check-run completions, and workflow runs, with an optional workflow-name filter. |
| `thatch_watch_list` | List this session's active watchers. |
| `thatch_watch_cancel` | Cancel one of this session's watchers by id. |

See [watchers.md](watchers.md) for the full behavior, lifetime, and
requirements.

### Chat tools (opencode only)

| Tool | What it does |
|------|-------------|
| `thatch_chat_register` | Join the cross-session chat directory, so other opencode sessions on this machine can message you. Without a name, one is drawn from the built-in pool (recommended - cannot collide); with a name, it is claimed case-insensitively. Pass a topic (one line about what the session is working on) so the roster tells others who to talk to. Safe to call again - same name is a no-op, a new name renames, a new topic updates. |
| `thatch_chat_list` | List registered sessions with a liveness marker (fresh = its process is alive, stale = likely gone), each session's project and topic, and your unread count. |
| `thatch_chat_send` | Send a message to another registered session, by name or session id. The recipient is nudged when its session is idle. |
| `thatch_chat_read` | Drain your inbox: all unread messages oldest-first, marked read. Senders identified by display name. |
| `thatch_chat_unregister` | Leave the chat directory. |
| `thatch_chat_broadcast` | Send one message to every other live registered session at once. Stale sessions (dead host processes) are skipped and reported. Use sparingly: every live session pays a model turn for a broadcast. |

See [cross-session-chat.md](cross-session-chat.md) for the full behavior,
liveness model, and limitations.

## Automatic behaviors

Beyond the tools, thatch hooks into opencode itself:

- **System prompt.** Every session's system prompt gains a section describing
  the available stores and when to save/recall memories.
- **Session-start reminder.** New sessions receive a prompt nudging the agent
  to recall user preferences and project context before its first response.
- **Hygiene heartbeat.** The session-start reminder also reports store
  maintenance signals when there are any: duplicate candidates pending review,
  memories neither updated nor recalled in 90+ days, and memories scoped to
  git branches that no longer exist. The agent is asked to tend the store when
  convenient. Thatch never deletes memories on its own.
- **Write-time similarity warning.** Saving a memory that closely resembles an
  existing one succeeds, but the response warns the agent and lists the
  similar entries so it can merge them or record that they're distinct.
- **Fact extraction.** Thatch buffers the session's recent tool calls (up
  to 20, per session). When the session goes idle, the plugin creates a
  child session and prompts it to run the fact-extractor skill directly. No
  nudge text in your conversation. The child writes memories via
  `thatch_memory_remember` and is cleaned up when it finishes. A toast
  notification shows the results (`[thatch] new: 2, updated: 1`). If the
  direct path fails, a nudge is injected into the next message as a
  fallback. On Claude Code and Cursor, the nudge-and-acknowledge path is
  the only mechanism (no SDK client to create child sessions). The agent
  does the writing. Thatch never saves memories on its own.
- **Recall, prediction, and behavior toasts.** When your prompt matches stored
  memories, learned decision patterns, or codified behaviors, thatch injects a
  synthetic nudge (invisible to you, visible to the agent) and fires a toast
  notification (`[thatch] recalled 3 memories`, `[thatch] 2 predictions
  surfaced`, or `[thatch] 1 behavior surfaced`). The toast is ephemeral. It
  fades after a few seconds.
- **Compaction context.** When opencode compacts a long session, thatch injects
  a reminder so the summarized session still knows memory tools exist.
- **Prediction auto-fire.** When a prompt matches learned contexts, thatch
  injects a `User decision model` block alongside the recall nudge. The block
  lists scored predictions (confidence, evidence count) that the agent can
  follow silently (strong prediction), surface to the user (ambiguous), or
  use to update the model after the user responds. No extra model call. The
  prediction search reuses the same prompt embedding as the recall nudge.
- **Behavior auto-fire.** When a prompt matches codified behavior matchers,
  thatch injects a `Situational behaviors` block listing scored rules
  (confidence, evidence count). The agent evaluates each rule against the
  current situation: if relevant (ham), it follows the rule and calls
  `behavior_feedback` with `relevant: true`; if not relevant (spam), it calls
  `behavior_feedback` with `relevant: false`. This trains the classifier so
  future nudges are more accurate. No extra model call. It reuses the same
  embedding as recall and prediction.

### Setup detection (Claude Code and Cursor)

When the MCP server starts (Claude Code or Cursor), it checks whether
`thatch setup` was run for the current host by looking for the instruction
markers in `CLAUDE.md` (Claude Code) or `AGENTS.md` (Cursor). It checks local
first (in the project directory), then global (in the config directory). If
setup was never run, or if the instruction markers are broken (e.g. the file
was edited externally and the thatch block was partially modified), the server
emits a warning to stderr and prepends it to the first tool response so the
agent can tell the user to run `thatch setup`.

## Skills

On startup thatch installs [skills] into your global opencode config
(`~/.config/opencode/skills/`, or `$XDG_CONFIG_HOME/opencode/skills`).
With `thatch setup --claude`, skills follow the install scope: the
repo's `.claude/skills/` for project-local, `~/.claude/skills/` (or
`$CLAUDE_CONFIG_DIR/skills/`) for `--global`. `thatch setup --cursor`
works the same way with `.cursor/skills/` and `~/.cursor/skills/`.
Setup reports the skills directory and how many skills were added,
updated, removed, or already current.

### Memory skills

| Skill | Purpose |
|-------|---------|
| `thatch-fact-extractor` | Guides the agent through turning buffered tool interactions into memories. |
| `thatch-dedup-classifier` | Guides the agent through classifying and resolving duplicate-candidate pairs. |
| `thatch-project-primer` | Investigates a new project from multiple angles and writes foundational memories. |
| `thatch-session-reflection` | End-of-session skill for recording what was learned about the project, user, tools, and self. |
| `thatch-memory-verify` | Fact-checks a single memory against the current codebase and corrects stale claims. Uses git archaeology to preserve historical context when changes were intentional. |
| `thatch-knowledge-export` | Compiles everything thatch knows about a topic into a curated markdown file for knowledge transfer to another engineer. Searches across stores, curates out personal noise, fact-checks code-related memories. |

### Code review skills

Eight specialist review lenses, plus the synthesizer, context, followup,
response, walkthrough, and workflow skills that support the review pipeline:

| Skill | Focus |
|-------|-------|
| `thatch-review-pedantic` | Mechanical correctness: spelling, naming, doc accuracy, specs, guidelines, stale artifacts. |
| `thatch-review-acceptance` | Behavioral/product review: UX coherency, behavioral delta, integration effects, user assumptions. |
| `thatch-review-state-flow` | Data flow and contracts: module boundaries, implicit state machines, error propagation, separation of concerns. |
| `thatch-review-economy` | Design simplicity and maintainability: is the complexity earned? Evaluates both the overall change design (forest) and individual touch points (trees) for unnecessary complexity, redundancy, and simpler available alternatives. |
| `thatch-review-no-slop` | AI writing anti-patterns: change narration, fourth wall breaks, em dashes, hedging, filler. |
| `thatch-review-breadcrumbs` | Comment narrative: do comments form a coherent outline of the code's behavior? |
| `thatch-review-mark-and-sweep` | Mechanical change completeness: whole-repo sweep for stragglers after renames, flag removals, API substitutions. |
| `thatch-review-highlights` | Positive finding detection: notably clever solutions, cleanup done along the way, documentation that helps. Medium-high bar against generic praise. |
| `thatch-review-mentorship` | Peer-mentorship lens: teaching-grade notes on unseen helpers/internal packages, companion techniques, house patterns, test-craft, API-shape principles, next-reader discoverability. Informational only, never blocking. |
| `thatch-review-synthesizer` | Verifies and synthesizes findings from multiple specialists into a report that starts with workflow changes, then highlights, then deduplicated severity-grouped findings. |
| `thatch-review-context` | Gathers project context (PR descriptions, git archaeology, ticket references, linked docs/tickets, memory) before a review. Prevents false positives about intentionally deferred work. |
| `thatch-code-archaeology` | Investigates an existing feature, debugs an unfamiliar area, or begins a new ticket. Explores the code base from multiple angles (data model, state flow, git history, sibling features, skeletons) before proposing changes. Pairs with `thatch-coding-workflow`. |
| `thatch-review-followup` | Alternate entrypoint for follow-up review rounds. Verifies whether the author's responses and code changes since your last review adequately addressed your prior findings, offers to reply on resolved items, then optionally re-runs the full structured review. |
| `thatch-review-response` | Author-side review response: triage findings on your own PR, fix bugs one by one, reply on each thread, post a top-level summary comment. |
| `thatch-change-walkthrough` | Explains a change to the user as a teaching walkthrough: researches each affected workflow at the merge-base, teaches current behavior, then overlays the modifications with file:line citations. |
| `thatch-code-walkthrough` | Explains a feature, module, or workflow to the user as a teaching walkthrough with file:line citations. Also used to draft high-level docs for new or undocumented features. |
| `thatch-coding-workflow` | Plans and executes code changes with a task-list-driven workflow: complexity triage, milestone planning, research before coding, post-coding verification. Pairs with `thatch-code-archaeology` (research first, then plan). |

### Writing skills

| Skill | Purpose |
|-------|---------|
| `thatch-pr-description` | Drafts PR descriptions with SYNOPSIS / PURPOSE / DESCRIPTION / WALK-THROUGH / NOTES, project-context research, clarity checks, and bold/italic emphasis for scanning. |
| `thatch-ticket-description` | Drafts ticket or issue descriptions (Linear or Jira) with clear sections, project-context research, clarity checks, and bold/italic emphasis for scanning. |
| `thatch-split-overlarge-pr` | Splits already-completed work from an overlarge PR into human-reviewable, release-safe PRs targeting main. |

### opencode-only skills

| Skill | Purpose |
|-------|---------|
| `thatch-code-review` | Multi-agent review coordinator. Dispatches parallel sub-agents for triage, decomposition, specialist fan-out, and synthesis with a workflow-change preface. Not available in Claude Code (requires sub-agent support). |

### Host availability

| Skill | opencode | Claude Code | Cursor |
|-------|----------|-------------|--------|
| Memory skills | Yes | Yes | Yes |
| Review specialists | Yes | Yes | Yes |
| Review synthesizer | Yes | Yes | Yes |
| Review context + code archaeology | Yes | Yes | Yes |
| Review followup | Yes | Yes | Yes |
| Review response (author-side) | Yes | Yes | Yes |
| Walkthrough skills | Yes | Yes | Yes |
| Writing skills | Yes | Yes | Yes |
| Code review coordinator | Yes | No (requires sub-agents) | No (requires sub-agents) |

### Using review skills

For a **quick single-lens review**, load any specialist skill directly and
point it at a branch or commit range:

```text
Load thatch-review-pedantic and review the changes on this branch.
```

For a **full multi-specialist review on opencode**, load the coordinator:

```text
Load thatch-code-review and review branch feature-x.
```

The coordinator will triage the change, dispatch parallel sub-agents (one per
specialist lens), and synthesize a final report. The report starts with the
workflow-level changes so the findings have context.

For a **full review on Claude Code** (or without the coordinator), run each
specialist in sequence, then synthesize:

```text
1. Load thatch-review-pedantic, review branch feature-x, report findings.
2. Load thatch-review-acceptance, review the same branch.
3. ... repeat for state-flow, no-slop, breadcrumbs, mark-and-sweep ...
4. Load thatch-review-synthesizer, verify and aggregate all findings.
```

For a **follow-up round** (the author responded or pushed changes after your
review), load the re-check skill:

```text
Load thatch-review-followup and check whether my prior review comments
on this PR were adequately addressed.
```

It verifies whether each finding was resolved (by code change, proof, or
follow-up ticket with a risk explanation), offers to reply on the resolved
ones, then optionally hands off to the coordinator for a fresh full review.

For **responding to review on your own PR**, load the author-side skill:

```text
Load thatch-review-response and help me work through the review comments
on my PR.
```

It triages every finding (legitimate, intentional, false positive, unlikely
edge case), collapses comments sharing a root cause, works through each bug
with you, drafts replies on each thread, then posts a top-level summary
comment so reviewers can see what changed without re-reading the full diff.

These files are plugin-owned: local edits are overwritten the next time the
plugin initializes (this is how skill improvements ship with new versions).

[skills]: https://opencode.ai/docs/skills/

## CLI

Thatch ships with a command-line tool for reviewing memories outside opencode.
It requires Bun on your PATH:

```bash
# After npm publish: available globally
thatch stores
thatch list [store]
thatch show <label> [store]
thatch forget <label> [store]
thatch search <query> [store]

# Before publish: run from a git checkout or symlink
bun run bin/thatch stores
# or
ln -s ~/dev/thatch/bin/thatch ~/.local/bin/thatch
```

`search` uses the same cosine-similarity search as `thatch_memory_recall`.
Store defaults to your current git repo.

## Configuration

Most configuration needs none. Two layers exist:

- **Preferences the agent manages** live in
  `~/.config/thatch/config.json` (beside the database): notification mode,
  voice, and sound. Ask your agent ("set notifications to banner only") or
  edit the file by hand. See [notifications.md](notifications.md).
- **Environment variables** for infrastructure:

| Variable | Default | Description |
|----------|---------|-------------|
| `THATCH_DB_PATH` | `$XDG_CONFIG_HOME/thatch/thatch.db` | Override database location (the config file follows it) |
| `THATCH_MODEL` | `Xenova/bge-small-en-v1.5` | Override embedding model |
| `THATCH_EMBEDDING_BACKEND` | `wasm` | Set to `native` to run embeddings on onnxruntime-node (NAPI) instead of the wasm runtime |

Unchanged defaults: the database is created automatically, the embedding
model downloads once and is cached, the store name is auto-detected from
`git remote get-url origin`, and search always includes the project store
and `global`.

`$XDG_CONFIG_HOME` defaults to `~/.config` when unset.

**Changing `THATCH_MODEL` on an existing database:** memories embedded by a
model with a different vector dimension are skipped by search (not corrupted,
not deleted, just invisible) until re-saved. There is no automatic
re-embedding.

## Privacy

- All data stays on your machine. No network calls for embeddings or storage.
- The embedding model is downloaded once from Hugging Face Hub on first use, then cached locally.
- Your memories are stored in a local SQLite database. Nothing is sent to any service.
