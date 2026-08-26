# Skills

Thatch ships skills that guide the agent through structured workflows:
code review, project investigation, memory management, PR and ticket
writing, and code change planning. Skills are markdown files with
frontmatter (name, description) that opencode auto-discovers.

## How they work

On startup, thatch installs skill files into your global config
(`~/.config/opencode/skills/` for opencode, `~/.claude/skills/` for
Claude Code, `~/.cursor/skills/` for Cursor). The host's skill
discovery scans these directories and presents them to the agent as
available skills.

The agent loads a skill when the user's request matches the skill's
description, or when another skill or the system prompt directs the
agent to load it. Once loaded, the skill body (the markdown content)
becomes part of the agent's context.

## What ships

26 skills total (25 shared, 1 opencode-only):

### Memory skills

| Skill | Purpose |
|-------|---------|
| `thatch-fact-extractor` | Guides the agent through turning buffered tool interactions into memories. Auto-triggered by the extraction pipeline. |
| `thatch-dedup-classifier` | Guides the agent through classifying and resolving duplicate-candidate pairs. |
| `thatch-project-primer` | Investigates a new project from multiple angles and writes foundational memories. |
| `thatch-session-reflection` | End-of-session skill for recording what was learned about the project, user, tools, and self. |
| `thatch-memory-verify` | Fact-checks a single memory against the current codebase and corrects stale claims. Uses git archaeology to preserve historical context when changes were intentional. |
| `thatch-knowledge-export` | Compiles everything thatch knows about a topic into a curated markdown file for knowledge transfer to another engineer. Searches across stores, curates out personal noise, fact-checks code-related memories. |

### Code review skills

| Skill | Focus |
|-------|-------|
| `thatch-review-pedantic` | Mechanical correctness: spelling, naming, doc accuracy, specs, guidelines, stale artifacts. |
| `thatch-review-acceptance` | Behavioral/product review: UX coherency, behavioral delta, integration effects, user assumptions. |
| `thatch-review-state-flow` | Data flow and contracts: module boundaries, implicit state machines, error propagation, separation of concerns. |
| `thatch-review-economy` | Design simplicity and maintainability: is the complexity earned? Evaluates both the overall change design (forest) and individual touch points (trees) for unnecessary complexity, redundancy, and simpler available alternatives. |
| `thatch-review-no-slop` | AI writing anti-patterns: change narration, fourth wall breaks, em dashes, hedging, filler. |
| `thatch-review-breadcrumbs` | Comment narrative: do comments form a coherent outline of the code's behavior? |
| `thatch-review-mark-and-sweep` | Mechanical change completeness: whole-repo sweep for stragglers after renames, flag removals, API substitutions. |
| `thatch-review-highlights` | Positive finding detection: notably clever solutions, cleanup done along the way, documentation that helps. Medium-high bar. |
| `thatch-review-synthesizer` | Verifies and synthesizes findings from multiple specialists into a deduplicated, severity-grouped report. |
| `thatch-review-context` | Gathers project context (PRs, tickets, TODOs, deferred work) before a review. Prevents false positives about intentionally deferred work. |
| `thatch-code-archaeology` | Investigates an existing feature, debugs an unfamiliar area, or begins a new ticket. The research skill; pair with `thatch-coding-workflow`. |
| `thatch-review-followup` | Verifies whether the author's responses and code changes since your last review adequately addressed your prior findings. |
| `thatch-review-response` | Author-side review response: triage findings on your own PR, fix bugs one by one, reply on each thread, post a top-level summary comment. |
| `thatch-code-review` | Multi-agent review coordinator (opencode-only). Dispatches parallel sub-agents for specialist fan-out and synthesis. |

### Walkthrough skills

| Skill | Purpose |
|-------|---------|
| `thatch-change-walkthrough` | Explains a change to you as a teaching walkthrough: researches each affected workflow at the merge-base, teaches current behavior, then overlays the modifications with file:line citations. |
| `thatch-code-walkthrough` | Explains a feature, module, or workflow as a teaching walkthrough with file:line citations. Also used to draft high-level docs for new or undocumented features. |

### Writing skills

| Skill | Purpose |
|-------|---------|
| `thatch-pr-description` | Drafts PR descriptions with SYNOPSIS / PURPOSE / DESCRIPTION / WALK-THROUGH / NOTES, using bold and italic emphasis for scanning. |
| `thatch-ticket-description` | Drafts ticket or issue descriptions (Linear or Jira) with clear sections and bold/italic emphasis for scanning. |
| `thatch-split-overlarge-pr` | Splits already-completed work from an overlarge PR into human-reviewable, release-safe PRs targeting main. |

### Workflow skills

| Skill | Purpose |
|-------|---------|
| `thatch-coding-workflow` | Plans and executes code changes with a task-list-driven workflow: complexity triage, milestone planning, research before coding, post-coding verification. Pairs with `thatch-code-archaeology` (research first, then plan). |

## Stale skill cleanup

When skills are renamed or removed in a new release, thatch automatically
deletes the old skill directories from your config on next startup.
Prefixed skills (`thatch-*`) are always cleaned up. Non-prefixed
skills (from early releases) are cleaned up through a version-gated
window.

## Limitations

- Skills are installed as copies, not symlinks. If you manually edit
  an installed copy, your changes are lost on next startup (thatch
  re-installs from its canonical source). Edit the canonical source
  in the thatch repo instead.
- The opencode-only coordinator (`thatch-code-review`) requires
  sub-agent support. It is not available on Claude Code or Cursor.
- Skill content is markdown read at runtime, not compiled into the
  binary. If the skill file is missing or corrupted, the skill will
  not load (silent failure).

See [code-review.md](code-review.md) for the review pipeline,
[extraction.md](extraction.md) for the fact-extractor skill,
[memory.md](memory.md) for the memory skills, and
[setup.md](setup.md) for installation.
