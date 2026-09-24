# Thatch

[![CI](https://github.com/sysread/thatch/actions/workflows/ci.yml/badge.svg)](https://github.com/sysread/thatch/actions/workflows/ci.yml)

Persistent memory and operational methodology for AI coding agents. Works with
**OpenCode** (as a plugin), **Claude Code** (as a local MCP server), and
**Cursor** (as a local MCP server).

Each session inherits the accumulated knowledge of every session before it:
project architecture, conventions, gotchas, user preferences. Your agent
starts with context instead of a blank slate. No API keys, no cloud services;
everything runs on your machine.

## Quick start

### OpenCode

```jsonc
// opencode.jsonc
{ "plugin": ["@jeffober/thatch"] }
```

On next start, OpenCode npm-installs thatch and its tools are available
immediately. Works with both opencode 1.x and 2.x (the same package supports
both plugin APIs). Until the next release ships, npm's `latest` still
targets 1.x only. For async extraction (child sessions run in the
background):

```bash
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

Without this env var, extraction still works - the child session runs
synchronously (fire-and-forget) instead of asynchronously.

### What works in opencode 2.x

The v2 plugin API is missing a few surfaces the v1 API had. On 2.x:

- **No toasts.** Notifications (extraction results, watcher events) land in
  the conversation instead of the TUI's toast area.
- **Extraction children are visible.** The fact-extractor child sessions are
  top-level sessions the host cannot delete, so they accumulate in the
  session picker, and "continue last session" (`-c`) can land in one after
  any session that triggered extraction.
- **`/thatch/compact` does not auto-compact.** The checklist and memory
  flush run, but the compaction itself cannot be triggered from the plugin
  API - run `/compact` yourself after the wrap-up completes. `/thatch/exit`
  cannot auto-exit for the same reason.
- **No `-c` session listing.** The chat resume listing degrades.

Everything else - tools, memory, nudges, chat, watchers - behaves the same
on both versions.

Then **prime your project memory** by running `thatch prime` in your project directory.
This launches an `opencode` session to build an initial map of the code base
and seed the memory.

### Claude Code and Cursor

Install globally, then run setup in your project:

```bash
npm install -g @jeffober/thatch
cd /path/to/your/project
thatch setup --claude    # or --cursor

# set up in your global config for all projects
thatch setup --claude --global  # or --cursor --global
```

`setup` installs the MCP server config, hooks, instructions, and skills.
Restart your editor and thatch's tools are available as `mcp__thatch__*`.
Requires [Bun] on PATH.

The embedding model downloads once at first use. It is cached in the
platform's per-user cache dir: `~/Library/Caches/thatch/models` on macOS (or
`$XDG_CACHE_HOME/thatch/models` when `XDG_CACHE_HOME` is set),
`$XDG_CACHE_HOME/thatch/models` (default `~/.cache/thatch/models`) elsewhere.
Set `THATCH_MODEL_CACHE` to override the location. The cache survives
upgrades and works from read-only installs.

### NixOS / Nix

This repo is a flake. The package bundles Bun and the native embedding
runtime, so you need no global `npm install` and no `bun` on PATH.

Try it without installing:

```bash
nix run github:sysread/thatch -- --version
```

Install options:

- **NixOS module** (system-wide, all users):

  ```nix
  {
    inputs.thatch.url = "github:sysread/thatch";

    # in your NixOS system's modules:
    imports = [ inputs.thatch.nixosModules.default ];
    programs.thatch.enable = true;   # puts `thatch` on PATH for every user
  }
  ```

- **Overlay**: add `nixpkgs.overlays = [ inputs.thatch.overlays.default ];`,
  then `environment.systemPackages = [ pkgs.thatch ];`
- **Package directly**: add `inputs.thatch.packages.${system}.default` to a
  `home.packages` or `environment.systemPackages` list

Once `thatch` is on PATH, wire it into your editor as usual:

```bash
cd /path/to/your/project
thatch setup --claude --global   # or --cursor
```

The embedding model still downloads once at first use. Its cache lives in the
per-user cache dir described above, outside the read-only Nix store, so it
survives upgrades. `THATCH_MODEL_CACHE` overrides the location.

### Other MCP-compatible harnesses

```json
{
  "mcpServers": {
    "thatch": { "command": "thatch", "args": ["mcp"] }
  }
}
```

Include thatch's instructions in your agent's system prompt manually; see
[MCP parity](https://github.com/sysread/thatch/wiki/Mcp-Parity) for the prompt text.

## What's inside

Thatch gives your agent:

- **Memory** -- save, search, and recall knowledge across sessions with
  local embeddings (bge-small-en-v1.5) and SQLite. Every project gets its
  own store; a shared global store holds cross-project knowledge. The agent
  writes and reads memories through tools -- thatch never saves anything on
  its own.
- **Prediction engine** -- a statistical model of the user's decision-making
  preferences. When a prompt matches learned contexts, predictions fire
  alongside the recall nudge. Confidence is graded (Bayesian posterior) and
  reinforced or weakened by user feedback. The agent follows strong
  predictions silently and surfaces ambiguous ones to the user.
- **Behavior engine** -- a self-discipline model where the agent codifies
  its own operational rules ("when X, I do Y"). Rules auto-fire when similar
  situations arise. The agent ham/spams each surfaced rule to train the
  classifier. Confidence adjusts the same way as predictions. An anti-laziness
  guard in the prompt prevents the agent from codifying shortcuts.
- **Conversation search** -- the agent can search its own past opencode
  conversations by substring or regex and retrieve full messages, including
  complete tool inputs and outputs. Available as tools (`session_search`,
  `session_get`, opencode only) and as CLI subcommands (`thatch session
  list/get/transcript/search`, JSONL output designed for piping to `jq`).
- **Watchers** -- event-driven notifications from external sources (opencode
  only). The agent registers a watch on a GitHub PR, a branch (main), or a
  local shell command; thatch polls it in the
  background and prompts the session when comments, commits, CI results, status changes, or a
  watched command's exit-0 condition arrive. Notifications carry pointer
  data plus machine status (check conclusions, exit codes), never external
  content.
- **Cross-session chat** -- your agent sessions can message each other
  (opencode, Claude Code, and Cursor; same machine). opencode sessions
  join the directory automatically under an assigned, never-reused name
  (a slug of the session title plus a counter); others see the roster, and
  messages land in inboxes -- idle opencode sessions get woken with a
  prompt, and Cursor and Claude Code wake when a turn ends with unread
  mail (Cursor also at prompt time; Claude Code also at startup and
  resume). Loop-safe:
  messages are informational to the receiving agent, and wake prompts are
  rate-capped. Delivered messages are framed as untrusted content so a
  hostile message cannot impersonate your instructions. Disable the whole
  feature with `chat.enabled: false` in the thatch config (or just the
  auto-joining with `chat.autoRegister: false`).
- **Slash commands** -- `/thatch/defrag` (consolidate duplicate memories),
  `/thatch/extract` (drain the extraction queue now), `/thatch/hygiene`
  (tend stale and orphaned memories), and `/thatch/reflect` (persist what
  the session learned) run on demand the same behaviors the nudges run on
  their own schedule. Plus the opencode-only wrap-ups: `/thatch/compact` and
  `/thatch/exit` run a pre-flight checklist before a compaction or an exit:
  the agent flushes pending fact extraction, finishes promised memory
  writes, and surfaces todos or follow-ups it never addressed. It ends its
  response with a greenlight token only when the checklist is clean; thatch
  then triggers the compaction or quits opencode. With items outstanding,
  the agent lists them and nothing fires -- you decide when to retry.
- **Notifications + user config** -- the agent can ping you out-of-band when a
  long-running outcome lands: a desktop banner, a spoken voice
  announcement, or both (macOS and Linux). Preferences live in a
  hand-editable config file (`~/.config/thatch/config.json`) that the agent
  manages through `config_get`/`config_set` -- ask it to change your voice
  or quiet notifications entirely.

Plus **skills** for memory workflows, structured multi-specialist code
review, review response, plan refinement, change and feature walkthroughs,
memory verification, knowledge export, and writing tasks
(PR descriptions, tickets, PR splitting).

See the [user guide](https://github.com/sysread/thatch/wiki/Guide%3A-Overview) for the full tool list, CLI
commands, configuration, environment variables, and detailed setup for each
host.

## What works in Claude Code

The memory tools, prediction and behavior engines, conversation search via
the `thatch session` CLI, cross-session chat (with stop-hook wake), skills,
and the on-demand actions `/thatch/defrag`, `/thatch/hygiene`, and
`/thatch/reflect` (synced by `thatch setup --claude`). Not available: the
wrap-up commands and `/thatch/extract` (they need the opencode plugin's
session identity and TUI control routes), live recall/prediction nudges
beyond the hook-based flow, and toast notifications.

## What works in Cursor

The same core set as Claude Code (memory, predictions, behaviors, chat with
stop-hook wake, skills, and the `defrag`/`hygiene`/`reflect` actions). Cursor
has no file-based slash commands, so the actions surface through MCP prompts
instead. Not available: the wrap-up commands, `/thatch/extract`, and toast
notifications.

## Privacy

Everything is local. The embedding model downloads once from Hugging Face Hub
and is cached. No data leaves your machine.

One exception: PR and branch watchers (opencode only) call the GitHub API
through the `gh` CLI to poll targets you explicitly asked to watch, using
your existing gh authentication; command watchers run local shell commands
in the project directory, reading only their exit codes. Thatch never sees
or stores the gh token, and notifications
carry pointer data plus machine status (check conclusions, exit codes),
never external content - GitHub comment text never enters your context
unless the agent fetches it.

## Development

```bash
bun install
mise run check     # typecheck + bun test + markdownlint (the CI gate)
```

On Nix, `nix develop` drops you into a shell with bun, mise, and node already
on PATH -- no system install needed.

Tests never reach outside the sandbox: temp-directory SQLite files, mock
embeddings, no network.

## Docs

- [User guide](https://github.com/sysread/thatch/wiki/Guide%3A-Overview) -- setup, tools, configuration, CLI
- [Development](https://github.com/sysread/thatch/wiki/Developer-Guide) -- architecture, module responsibilities
- [MCP parity](https://github.com/sysread/thatch/wiki/Mcp-Parity) -- OpenCode plugin vs MCP feature comparison
- [QA tests](https://github.com/sysread/thatch/tree/main/tests/qa) -- executable use cases (auto/ and live/ subdirs)
- [Design docs](https://github.com/sysread/thatch/tree/main/docs/plans) -- design-decision snapshots and in-progress plans

## License

[MIT](LICENSE)

[Bun]: https://bun.sh
