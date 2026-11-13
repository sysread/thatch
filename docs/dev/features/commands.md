# Slash commands: actions and wrap-ups

Thatch's `/thatch/*` commands come in two families:

- **Actions** (`defrag`, `extract`, `hygiene`, `peer-review`, `bug-intake`,
  `refine`, `reflect`, `self-review`, `whois`) — user-invoked commands. The
  nudge-backed ones (`defrag`, `extract`, `hygiene`, `reflect`) wrap
  behaviors the nudges otherwise run on their own schedule; the rest
  are self-contained, with no nudge counterpart.
- **Wrap-ups** (`compact`, `exit`) — greenlight-gated pre-compaction and
  pre-exit checklists. They need a plugin runtime to arm the greenlight and
  fire the host action: opencode's adapter and the Claude Code plugin
  regime's mod both provide one (Claude Code's exit reports it is safe to
  close instead of closing - no mod API can). The hooks regime and Cursor
  have no plugin host.

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
(Claude Code, Cursor) — and apply a mode overlay of mode rules. Mode rules
carry two kinds of content: a weighting for whose work is under review, and
mode-scoped pipeline phases. The weighting: `peer-review` weights org
velocity and walks the project's persistent memory (the one tool it
names, spelled through the `ToolNamer` so MCP renderings stay correct);
`self-review` weights the reputation lenses (no-slop, clarity,
technique, breadcrumbs) and iterates rounds until a round produces no meaningful
findings. The mode-scoped phase: `peer-review` continues after synthesis with
the `thatch-review-adjudicate` skill, walking the user through the findings
one at a time for verdicts and staging a draft review the user submits. That
handoff lives in the mode rules, not in the shared couching or the
coordinator/synthesizer skills, because those are shared with `self-review`,
which stays an automatic chat loop with no user adjudication by default. The
roster and count for the
inline sequence come from `REVIEW_SPECIALISTS` in src/prompts.ts, the
same source as the install list in src/skills.ts and both host
instruction skill lists. The couching also names the MCP `Focus:` line as a target
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
- `${CHECKLIST}` (own line) - the wrap-up persistence checklist. The
  wrap-ups greenlight with a zero-arg tool call (`thatch_compact` /
  `thatch_exit`), so there is no token placeholder.

An unresolved placeholder throws at load rather than passing through
(the REVIEW_COMMON lesson: a silent passthrough once corrupted skill
bodies). `tests/commands.test.ts` pins both directions: every template's
placeholders resolve, and the artifact set matches the command set (the
two wrap-up templates aside - they are consumed through
`wrapUpCommandContent`, not the install set).

- `actionDefs()` returns the action set with rendered bodies. Actions
  needing plugin-only capabilities are marked `opencodeOnly`
  (`extract` and `whois`: they need the invoking session's identity).
- `opencodeCommandDefs()` = all actions, wrap-ups NOT included (they
  register in code through the CommandEditor; a command FILE with the
  same name as a registered command would collide, and
  `removeWrapUpCommandFiles` cleans files left by pre-drop runs). Synced
  by the plugin at init into `$XDG_CONFIG_HOME/opencode/command/thatch/`
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
documented exclusions: opencode = Claude Code set + `extract`, `whois`;
MCP prompts = Claude Code's set.

## The extract action and session resolution

`/thatch/extract` runs the extraction flow on demand: dispatch the
extractor sub-agent, which fetches with `thatch_get_extraction_payload`
and acks with `thatch_extraction_done` — neither call carries a session
id. The command teaches no id to learn or copy (the 2026-11-13
corrupted-id fix): the dispatched sub-agent is session-linked, and the
host resolves the caller at the tool-call boundary.

`get_extraction_payload` resolves its target in this order: a supplied
`session_id` is tried first; one that resolves nothing falls back to the
host-owned resolution of the calling session (a linked child retargets to
its parent's queue through `childToParent`); with neither — standalone
MCP, whose tool calls carry no session context — the parameter is the
only key, and an omitted one returns a clear "pass the parent's
session_id" error. The zod arg shape is shared between hosts, so the
per-host behavior lives in the tool's `execute`, never in the schema.
