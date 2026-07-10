# Skills

Thatch installs SKILL.md files that give the agent task-specific workflows. All
skill content is defined in `src/skills.ts` and installed to a host-specific
directory. See `mcp-parity.md` for which skills each host gets.

## Skill file format

Each skill is a single `SKILL.md` with YAML frontmatter:

```markdown
---
name: thatch-fact-extractor
description: Extract durable project facts ... Use when ...
---

<role and instructions>
```

- `name` must match the directory name (`<skillsDir>/<name>/SKILL.md`).
- `description` drives when the agent loads the skill (both opencode and
  Cursor auto-discover skills and use the description for relevance).

## The 12 skills

**Shared (11)** — installed everywhere; no sub-agents required:

| Skill | Role |
|-------|------|
| `thatch-fact-extractor` | Turn buffered tool interactions into `thatch_memory_remember` calls. |
| `thatch-dedup-classifier` | Classify and resolve `find_duplicates` pairs/clusters. |
| `thatch-project-primer` | Investigate a new project and write foundational memories. |
| `thatch-review-pedantic` | Mechanical correctness: spelling, naming, doc accuracy, specs, stale artifacts. |
| `thatch-review-acceptance` | Behavioral/product review: UX, behavioral delta, integration effects. |
| `thatch-review-state-flow` | Data flow and contracts: module boundaries, implicit FSMs, error propagation. |
| `thatch-review-no-slop` | AI writing anti-patterns: change narration, fourth-wall breaks, em dashes, filler. |
| `thatch-review-breadcrumbs` | Comment narrative: do comments form a coherent outline of behavior? |
| `thatch-review-synthesizer` | Verify specialist findings against code, dedupe, classify, calibrate severity. |
| `thatch-review-context` | Gather project/feature context (PR descriptions, git archaeology, ticket references, memory) before fan-out. Prevents false positives about intentionally deferred work. |
| `thatch-session-reflection` | End-of-session memory recording (project, user, tools, self). |

**opencode-only (1)** — the coordinator needs sub-agent support:

| Skill | Role |
|-------|------|
| `thatch-code-review` | Resolve review target, gather context, estimate complexity, partition, dispatch the 5 specialists in parallel, synthesize. |

## REVIEW_COMMON

The five review specialists share a framework interpolated via `${REVIEW_COMMON}`:

- **Static analysis only** — no running tests/linters/compilers.
- **Scope gathering** — resolve the git range, `git diff --stat`, read changed
  files in full for context.
- **Runtime model** — CLI/long-lived server/library/batch — this determines
  which bug classes are realistic.
- **Reachability gate** — every finding must describe a concrete normal-usage
  trigger; "the code allows this" is not enough.
- **Intent verification** — trace callers, check git history, and `thatch_memory_recall`
  for design rationale before flagging a behavior as a bug.
- **Project context awareness** — if a context brief is provided (from the
  coordinator or from loading `thatch-review-context`), use it to avoid false
  positives about intentionally deferred work.
- **TODO ($ticket) markers** — recognize `TODO ($TICKET-ID): ...` as legitimate
  breadcrumbs for deferred work, not stale artifacts. Flag only if the referenced
  ticket is closed or merged.
- **Output format** — `[SEVERITY] [CATEGORY] file:line` with finding, evidence
  (quoted), trigger, reachability, source of truth, producer chain, provenance.

The synthesizer reuses the same verification rigor but has its own structure
(it does not interpolate `REVIEW_COMMON`).

## The two arrays

```ts
const SHARED_SKILLS: SkillDef[] = [ /* 11 skills above */ ];
const OPENCODE_ONLY_SKILLS: SkillDef[] = [ /* code-review coordinator */ ];
```

`installSkills(skillsDir, skills?)` defaults to `SHARED_SKILLS`. The opencode
plugin passes `[...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]`; `thatch setup --claude`
and `--cursor` pass only the shared set.

## Install mechanics

- **Location**: `$XDG_CONFIG_HOME/opencode/skills` (opencode),
  `$CLAUDE_CONFIG_DIR/skills` (Claude Code), `~/.cursor/skills` (Cursor).
  Always user-scoped — never into the worktree.
- **Trigger**: opencode installs at plugin init; Claude Code/Cursor install via
  `thatch setup`.
- **Drift detection**: `installSkills` only writes when the on-disk content
  differs from the definition. This is how skill improvements ship with new
  versions without users manually deleting files.
- **Idempotent**: re-running init or setup overwrites drifted content but leaves
  unrelated skill files alone.

## Adding a skill

1. Write the `SKILL.md` content as a template literal in `src/skills.ts`.
   Interpolate `${REVIEW_COMMON}` if it's a review specialist.
2. Add a `{ name, content }` entry to `SHARED_SKILLS` (or `OPENCODE_ONLY_SKILLS`
   if it needs sub-agents).
3. If the skill name appears in a tool's expected workflow (e.g. the extraction
   nudge references `thatch-fact-extractor`), update that prompt in `src/prompts.ts`.
4. The opencode plugin and `thatch setup` pick it up automatically on next init.

## Memory review skills in practice

- **Quick single lens**: load any specialist directly and point it at a branch.
- **Full review on opencode**: load `thatch-code-review` — it gathers project context, dispatches all 5
  specialists in parallel (with context injected into each briefing), then synthesizes.
- **Full review on Claude Code/Cursor**: run each specialist in sequence, then
  run `thatch-review-synthesizer` to verify and aggregate.

The coordinator is the only skill that can't be used without sub-agents; that's
why it lives in `OPENCODE_ONLY_SKILLS`.
