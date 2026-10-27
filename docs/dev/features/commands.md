# Slash commands: actions and wrap-ups

Thatch's `/thatch/*` commands come in two families:

- **Actions** (`defrag`, `extract`, `hygiene`, `peer-review`, `refine`,
  `reflect`, `self-review`, `whois`) — user-invoked commands. The
  nudge-backed ones (`defrag`, `extract`, `hygiene`, `reflect`) wrap
  behaviors the nudges otherwise run on their own schedule; the rest
  are self-contained, with no nudge counterpart.
- **Wrap-ups** (`compact`, `exit`) — greenlight-gated pre-compaction and
  pre-exit checklists. opencode only: the greenlight check needs the
  plugin's `command.execute.before` arming and TUI control routes.

User-facing guide: [../../user/commands.md](../../user/commands.md).

## Prompt cores

The nudge-backed action bodies are **prompt cores**: constants in
`src/prompts.ts` (`defragCore`, `hygieneCore`, `reflectCore`,
`extractionCore`) that hold the host-agnostic instruction text for one
behavior. The nudge envelopes wrap the same cores with escalation tiers
and the stop-and-wait ending; command and prompt renderers wrap them with
frontmatter and a user-message section.
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

## Skill-couching actions

A command body can **couch** a skill: wrap the skill's procedure with the
additional instructions the command needs. `refine`, `peer-review`,
`self-review`, and `whois` are not prompt cores: they have no nudge
counterpart to stay in sync with, so their bodies live directly in
`actionDefs` (src/commands.ts). `refine` triggers the `thatch-refine`
router skill and `whois` prints the chat identity; neither applies an
overlay.

`peer-review` and `self-review` share one pipeline couching
(`reviewPipelineCouching` in src/commands.ts): run the code review
machinery — the `thatch-code-review` coordinator where that skill is
installed (opencode), the inline specialist sequence where it is not
(Claude Code, Cursor) — and apply a mode overlay that reweights the
findings for whose work is under review. The roster and count for the
inline sequence come from `REVIEW_SPECIALISTS` in src/prompts.ts, the
same source as the install list in src/skills.ts and both host
instruction skill lists. `peer-review` weights org
velocity and walks the project's persistent memory (the one tool it
names, spelled through the `ToolNamer` so MCP renderings stay correct);
`self-review` weights the reputation lenses (no-slop, clarity,
technique, breadcrumbs) and iterates rounds until a round produces no meaningful
findings. The couching also names the MCP `Focus:` line as a target
source, because MCP prompts replace the file commands' `$ARGUMENTS`
section with a `Focus:` line.

## Rendering and sync

`src/commands.ts` is the single registry. Command body text lives in
`artifacts/commands/<name>.md` (the same artifacts layout as skills, shipped
in the package), as templates with `${...}` placeholders:

- `${TOOL:name}` (inline) - the named tool in the host's spelling
  (`thatch_memory_recall` on opencode, `mcp__thatch__memory_recall` on
  Claude Code and Cursor).
- `${CORE:name}` (own line) - splices the prompt core from src/prompts.ts
  for the nudge-backed actions (defrag, extract, hygiene, reflect), so a
  wording change lands in the nudge and the command at once.
- `${COUCHING:target|pipeline}` (own line) - splices the text shared by the
  two review-mode commands, so their procedure cannot drift apart.
- `${CHECKLIST}` (own line) and `${TOKEN:name}` (inline) - the wrap-up
  persistence checklist and greenlight tokens. Only compact uses
  `${TOKEN:...}` now: exit's greenlight is the zero-arg `thatch_exit` tool
  call, so its template names the tool instead.

An unresolved placeholder throws at load rather than passing through
(the REVIEW_COMMON lesson: a silent passthrough once corrupted skill
bodies). `tests/commands.test.ts` pins both directions: every template's
placeholders resolve, and the artifact set matches the command set exactly.

- `actionDefs(tool)` returns the action set with bodies rendered for one
  host. Actions needing plugin-only capabilities are marked `opencodeOnly`
  (`extract` and `whois`: they need the invoking session's identity).
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
`extract`, `whois`; MCP prompts = Claude Code's set.

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
