# Slash commands: actions and wrap-ups

Thatch's `/thatch/*` commands come in two families:

- **Actions** (`defrag`, `extract`, `hygiene`, `reflect`) — user-invoked
  wrappers around behaviors the nudges otherwise run on their own schedule.
- **Wrap-ups** (`compact`, `exit`) — greenlight-gated pre-compaction and
  pre-exit checklists. opencode only: the greenlight check needs the
  plugin's `command.execute.before` arming and TUI control routes.

User-facing guide: [../../user/commands.md](../../user/commands.md).

## Prompt cores

Action bodies are **prompt cores**: constants in `src/prompts.ts`
(`defragCore`, `hygieneCore`, `reflectCore`, `extractionCore`) that hold the
host-agnostic instruction text for one behavior. The nudge envelopes wrap
the same cores with escalation tiers and the stop-and-wait ending; command
and prompt renderers wrap them with frontmatter and a user-message section.
The point is drift-proofing: a wording change lands in the nudge and the
command at once, and a test asserts each rendered file contains its core
verbatim.

The stop-and-wait ending ("do not advance pending work on this nudge's
account") is nudge-only by design. A `/thatch` command IS user input, so
the command envelope must not inherit it.

Cores that name memory tools take a `ToolNamer` because spellings differ
per host: `thatch_find_duplicates` on opencode, `mcp__thatch__find_duplicates`
on MCP hosts. Each host's renderer passes its own namer
(`opencodeToolName` / `mcpToolName`).

## Rendering and sync

`src/commands.ts` is the single registry:

- `actionDefs(tool)` returns the action set with bodies rendered for one
  host. Actions needing plugin-only capabilities are marked `opencodeOnly`
  (`extract`: needs session identity via `get_session_info`).
- `opencodeCommandDefs()` = wrap-up templates + all actions. Synced by the
  plugin at init into `$XDG_CONFIG_HOME/opencode/command/thatch/`
  (`installOpencodeCommands`), content-compare, self-healing.
- `claudeCommandDefs()` = actions minus `opencodeOnly`. Synced by
  `thatch setup --claude` (`installClaudeCommands`) into
  `<claudeDir>/commands/thatch/`, reported in the setup output. There is no
  plugin on this host to sync on load, so setup is the sync point.
- MCP prompts: `compilePrompts()` in `src/mcp.ts` exposes the same
  non-opencodeOnly actions through `prompts/list` / `prompts/get`, which
  Cursor surfaces as slash commands. The optional `focus` argument is
  appended to the body as a `Focus:` line, standing in for the file
  commands' `$ARGUMENTS`.

A parity-guard test asserts the three sets are the same actions minus the
documented exclusions: opencode = Claude Code set + `compact`, `exit`,
`extract`; MCP prompts = Claude Code's set.

## The extract action and session IDs

`/thatch/extract` runs the extraction flow on demand: learn the session ID
from `thatch_get_session_info`, dispatch the extractor sub-agent with an
explicit `session_id`, acknowledge with `thatch_extraction_done`. The
explicit ID matters because the sub-agent's session differs from the
parent's — the same reason the extraction nudge passes it.

`get_extraction_payload` accepts an omitted `session_id`: on the opencode
path the wrapper supplies the invoking session's `HostToolContext.sessionID`.
The zod arg shape is shared between hosts, so optionality cannot be
per-host at the schema level; on MCP hosts (no session context) an omitted
`session_id` returns a clear "pass the parent's session_id" error. The rule
the model applies, stated in the arg descriptions and the dev docs:

> Omit `session_id` when acting on the session you are running in. Pass the
> parent session's `session_id` when running inside a sub-agent dispatched
> to process another session's extraction queue.
