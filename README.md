# Thatch

[![CI](https://github.com/sysread/thatch/actions/workflows/ci.yml/badge.svg)](https://github.com/sysread/thatch/actions/workflows/ci.yml) [![Ask DeepWiki](https://raw.githubusercontent.com/sysread/thatch/main/docs/assets/deepwiki-badge.svg)](https://deepwiki.com/sysread/thatch)

<!-- DeepWiki badge is vendored (see git history for the experiment note). -->

Persistent memory and operational methodology for AI coding agents. Each
session inherits the accumulated knowledge of every session before it:
project architecture, conventions, gotchas, user preferences. Your agent
starts with context instead of a blank slate. No API keys, no cloud
services; everything runs on your machine. Thatch is an opencode v2
plugin, and also runs on Claude Code, Cursor, and any other MCP harness.

## Install

**OpenCode** - add the plugin to `opencode.jsonc`; it installs on next start.
Requires opencode 2.1 or newer; opencode v1 is not supported:

```jsonc
{ "plugin": ["@jeffober/thatch"] }
```

Upgrading from a pre-2.x-only release: any hand-written plugin shim that
re-exports the plugin's old named `server` export fails to load after this
version - replace it with a plain re-export of the default export (see the
[setup guide](https://github.com/sysread/thatch/wiki/Guide%3A-Setup)) or
delete the shim and let the package install above do the work.

A caveat for OpenCode users: a session whose tab is open but not
currently viewed can go quiet after about 60 minutes with no activity in
its project directory, because opencode unloads an idle location's
services. Until that location reloads, chat mail is not delivered to its
sessions and they cannot be woken. If you keep tabs open across long
idle periods, set `experimental.location_idle_timeout` to a longer
duration or `false`.

**Claude Code** - paste into a session (requires [Bun](https://bun.sh) on
PATH - the plugin's bundled server runs under it):

```text
/plugin marketplace add sysread/thatch
/plugin install thatch
```

Older Claude Code versions or enterprise policies that disable mods:
`npm install -g @jeffober/thatch && thatch setup --claude --hooks`.

**Cursor**:

```bash
npm install -g @jeffober/thatch
thatch setup --cursor            # or --global
```

**NixOS / Nix** - the flake bundles Bun and the embedding runtime (no global
install, no bun on PATH):

```bash
nix run github:sysread/thatch -- --version   # try it
```

Then either import `inputs.thatch.nixosModules.default` and set
`programs.thatch.enable = true`, add the overlay and `pkgs.thatch`, or add
`inputs.thatch.packages.${system}.default` to your packages. Wire it into
your editor with the setup commands above.

**Any other MCP harness**:

```bash
thatch setup --mcp-json               # print the server config as JSON
thatch setup --skills-only <dir>      # install skills into any directory
```

Then **prime your project memory**: run `thatch prime` in your project
directory to build an initial map of the code base and seed the memory.
The embedding model downloads once at first use and is cached per user
(see the [user guide](https://github.com/sysread/thatch/wiki/Guide%3A-Overview)).

## What you get

- **Memory** -- save, search, and recall knowledge across sessions with local embeddings and SQLite; one store per project plus a shared global store. Deleting is guarded: a tombstone holds any re-save of deleted content until you clear it (`thatch tombstones`).
- **Prediction engine** -- a statistical model of your decision-making preferences; strong predictions apply silently, ambiguous ones surface.
- **Behavior engine** -- the agent codifies its own operational rules ("when X, I do Y") that auto-fire in similar situations.
- **Extraction** -- durable facts are pulled from the session's tool activity automatically; nobody has to remember to save.
- **Conversation search** -- search past opencode conversations by substring or regex and retrieve full messages, including complete tool inputs and outputs; also available as CLI subcommands (`thatch session list/get/transcript/search`) with JSONL output built for `jq`.
- **Doctor** -- `thatch doctor` checks every host's install in one read-only sweep (the database, the opencode plugin and dev shim, the Claude Code plugin or hooks regime, Cursor's config) and prints a verdict plus a fix line for anything that needs action.
- **Cross-session chat** -- your agent sessions message each other under assigned, never-reused names; idle sessions get woken by agent mail, while a terminal broadcast (`thatch chat broadcast`) wakes only sessions with an open tab and leaves the rest to read at their next prompt; mail is framed as untrusted content.
- **Watchers** -- the agent watches a GitHub PR, a branch, or a local command and gets prompted when something happens; notifications carry pointers, never external content.
- **Slash commands** -- `/thatch/defrag`, `/thatch/extract`, `/thatch/hygiene`, `/thatch/reflect`, `/thatch/refine`, `/thatch/self-review`, `/thatch/peer-review`, `/thatch/whois`, `/thatch/bug-intake`, and the wrap-ups `/thatch/compact` and `/thatch/exit` (a pre-flight checklist before compaction or exit); see the [user guide](https://github.com/sysread/thatch/wiki/Guide%3A-Overview).
- **Notifications** -- desktop banner and spoken voice on macOS and Linux, plus automatic alerts when the LLM pauses for your input or finishes real work; tune it all in a hand-editable config file the agent manages for you.
- **Skills** -- memory workflows, multi-specialist code review, plan refinement with evidence and consistency audits, bug-report intake, walkthroughs, knowledge export, and writing tasks.

Feature differences by host are tracked in the
[MCP parity doc](https://github.com/sysread/thatch/wiki/Mcp-Parity).

## Privacy

Everything is local. The embedding model downloads once from Hugging Face
Hub and is cached; no data leaves your machine. One exception: PR and
branch watchers call the GitHub API through your existing `gh`
authentication to poll targets you explicitly asked to watch; notifications
carry pointer data and machine status, never external content.

## Development

```bash
bun install
mise run check     # typecheck + bun test + markdownlint (the CI gate)
```

On Nix, `nix develop` drops you into a shell with bun, mise, and node
already on PATH. Tests never reach outside the sandbox: temp-directory
SQLite files, mock embeddings, no network.

## Docs

- [User guide](https://github.com/sysread/thatch/wiki/Guide%3A-Overview) -- setup, tools, configuration, CLI
- [Development](https://github.com/sysread/thatch/wiki/Developer-Guide) -- architecture, module responsibilities
- [MCP parity](https://github.com/sysread/thatch/wiki/Mcp-Parity) -- feature differences by host
- [QA tests](https://github.com/sysread/thatch/tree/main/tests/qa) -- executable use cases (auto/ and live/ legs)
- [Design docs](https://github.com/sysread/thatch/tree/main/docs/plans) -- design-decision snapshots and in-progress plans

## License

[MIT](LICENSE)
