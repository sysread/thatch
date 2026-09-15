# Thatch Actions: Prompt Cores Shared by Nudges and /thatch Commands

## Synopsis

Extract the behavior instructions currently embedded in nudge text into
prompt-core constants in `src/prompts.ts`, then build `/thatch/*` user-facing
commands on top of the same constants. The nudge and the command become two
envelopes around one instruction body: the nudge adds escalation tiers and
stop-and-wait framing, the command adds user-invocation framing. First
payoff is `/thatch/defrag`, but the structure covers any behavior the nudges
currently ask the agent to perform on demand.

## Background

Nudges are instruction-carrying messages injected by hooks. Several encode a
multi-step behavior the agent must execute (dispatch a sub-agent, fetch the
extraction payload, run a skill, ack). The same behaviors have no user-facing
invocation path: the user cannot say "drain the extraction queue now" or
"consolidate duplicate memories now" -- they can only wait for a nudge or
describe the desired behavior in prose and hope the agent maps it to the right
skill + tool sequence.

Two existing pieces make this cheap to add:

- `src/commands.ts` already ships `/thatch/compact` and `/thatch/exit` as
  markdown command files synced into the opencode config dir, and already
  composes them from shared fragments (`sharedChecklist`,
  `userMessageSection`).
- The "Shared prose sync across prompt variants" problem is documented:
  prompt prose lives in parallel functions with no single source of truth,
  and drift in unasserted sections passes tests. This plan makes the shared
  behavior text a true constant.

## Design: prompt cores and envelopes

A **prompt core** is a constant string in `src/prompts.ts` holding the
host-agnostic instruction body for one behavior: which tools to call, in what
order, with what arguments, and what "done" looks like.

An **envelope** wraps a core with delivery-specific framing:

- The nudge envelope adds: escalation tier wording, the load-bearing
  stop-and-wait ending (see "Extraction nudge stop-and-wait wording is
  load-bearing" -- the stop-and-wait text is nudge-only and must NOT leak
  into action envelopes, because an action IS user input), and the
  "system nudge, not user input" disclaimer.
- The action envelope adds: frontmatter description, the `# User Message`
  section with `$ARGUMENTS`, and any greenlight-token mechanics (wrap-up
  commands only).

Cores are plain string constants, not template functions, so both envelopes
interpolate them identically. Where a core needs host-specific tool names
(`thatch_memory_remember` vs `mcp__thatch__memory_remember`), the core takes
the opencode spelling and MCP consumers apply the documented token
substitution, matching the existing systemPrompt/mcpInstructions convention.

## Actions v1

| Command | Core behavior | Existing machinery |
|---|---|---|
| `/thatch/defrag` | Run `thatch_find_duplicates`, classify each pair with the thatch-dedup-classifier skill, consolidate (remember/overwrite or forget), mark pairs checked | find_duplicates + dedup classifier skill |
| `/thatch/extract` | Fetch the extraction payload, run the fact-extractor skill, call `extraction_done` | get_extraction_payload + fact-extractor skill |
| `/thatch/hygiene` | Run the hygiene report, act on stale and orphaned branch-scoped memories | `hygieneReport()` + `/thatch hygiene` CLI |
| `/thatch/reflect` | Run the session-reflection skill over the current session | thatch-session-reflection skill |

The wrap-up commands (`compact`, `exit`) stay as-is; their checklist text
becomes a core reused by both templates (already true via `sharedChecklist`).

## Host parity

Commands are markdown or MCP prompts, synced per host. Behavior parity is the
goal; format differences are documented, not hidden.

- **opencode** (existing): `installOpencodeCommands` syncs markdown to
  `~/.config/opencode/command/thatch/` on every plugin load.
- **Claude Code**: native user-level slash commands read markdown from
  `~/.claude/commands/thatch/` with the same `$ARGUMENTS` substitution.
  `thatch setup --claude` gains a sync step (idempotent content-compare, same
  as the opencode installer). Differences: no plugin, so no
  `command.execute.before` arming -- greenlight-token wrap-up commands do not
  ship to Claude Code; and tool names use the `mcp__thatch__` prefix.
- **Cursor**: no file-based commands. The stdio MCP server (`mcp.ts`) gains
  MCP Prompts support (`prompts/list`, `prompts/get`), which Cursor surfaces
  as slash commands. Prompt arguments use MCP's
  `{{argument}}`-style templating, so each action core gets an MCP-prompt
  rendering alongside the markdown rendering.

README gains "What works in Claude Code" and "What works in Cursor" sections
listing per-host support without restating the shared docs.

## Session ID plumbing

`get_extraction_payload` and `extraction_done` take `session_id`. Today the
nudge carries the ID; an action has no way to know it.

- opencode path: the thin wrappers in `tools.ts` receive the invoking
  session's ID from the host. `session_id` becomes optional there; omitted
  means "the current session."
- MCP path: there is no session context in a tool call, so `session_id`
  stays required. The tool description and docs state this plainly.

The rule the LLM must apply, stated everywhere the tools are described:

> Omit `session_id` when acting on the session you are running in. Pass the
> parent session's `session_id` when running inside a sub-agent that was
> dispatched to process another session's extraction queue.

This rule appears in: the tool descriptions in `tool-defs.ts`, the extraction
prompt core (used by both nudge and action envelopes), the fact-extractor
skill, and the dev docs. Tests cover both paths: omit-resolves-to-current and
explicit-parent-ID (the existing sub-agent drain bug's regression path).

## Decisions

- Prompt cores live in `src/prompts.ts`, not a new module; `commands.ts`
  imports them. One prompt module, consistent with the existing module map.
- Actions are generated, not hand-written: each action has one core and a
  per-host renderer, so a wording change cannot drift between nudge and
  command.
- No `--dry-run` flag for defrag in v1; the dedup classifier skill already
  asks for pair-by-pair verdicts, which is the interactive safety net.
- MCP Prompts for Cursor are additive to `mcp.ts` and do not change the
  tools/list contract.

## Testing

- `tests/commands.test.ts` (or the existing plugin tests): command-file
  content assertions per host, including that each action's markdown contains
  its core text verbatim.
- MCP tests: `prompts/list` returns every action; `prompts/get` interpolates
  arguments.
- Plugin tests: `get_extraction_payload` without `session_id` resolves to the
  invoking session; with an explicit parent ID, drains the parent's queue.
- Parity guard: a test asserts every opencode command def has a
  corresponding MCP prompt (and vice versa) except the documented exclusions
  (wrap-up greenlight commands on non-opencode hosts).

## Docs

- `docs/dev/commands.md` (two-tier: dev doc + user-facing README section):
  action list, host parity matrix, session ID rule.
- README: "What works in Claude Code" / "What works in Cursor" sections.
- QA use cases: one auto use case for `/thatch/defrag` end-to-end, one for
  `/thatch/extract` with omitted session ID.
