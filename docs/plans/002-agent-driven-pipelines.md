# Plan 002 — Agent-Driven Pipelines

## Synopsis

Fact extraction and deduplication run through the agent, not through plugin
background machinery. The plugin observes, buffers, and nudges; the agent does
all memory writes via the ordinary tools. Supersedes plan 001's "no standalone
CLI" (a CLI now ships in `bin/thatch`) and codifies decisions made during the
2026-07 repair of the dead extraction/dedup wiring.

## Background

The original implementation contained half-wired background machinery:
`applyClassification`/`applyActions` pipelines that were never called, an
advisory-locks table for coordinating background work across sessions, and
event handlers listening for events that don't exist. Rather than finish that
design, it was amputated in favor of the agent-driven flow the tool + skill
surface already implied.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Plugin never writes memories autonomously | The agent has context the plugin lacks (what's durable vs ephemeral); background writes would need their own LLM calls, cost controls, and conflict handling. Nudge-the-agent gets classification for free. |
| No locks table | Only agents write, through single-shot tool calls; SQLite WAL + busy_timeout covers concurrent tool execution. Advisory locks existed to serialize background jobs that no longer exist. |
| Dedup verdicts in `dedup_pairs`, recorded via `thatch_dedup_mark_checked` | `find_duplicates` must converge: reviewed-and-kept pairs (supplement/contradiction/unrelated) would otherwise re-report forever. |
| Overwrite/forget invalidates verdicts for that slug | A verdict describes content that no longer exists; stale verdicts would suppress genuinely new duplicates. |
| Embedding spaces discriminated by vector dimension, not model tag | Zero-migration safety for `THATCH_MODEL` changes: mismatched entries are skipped, never NaN-ranked. Model tags are unreliable (historical rows carry a short tag, new rows the full HF name). |
| Extraction buffers are per-session, thatch tools excluded | Concurrent sessions must not claim each other's interactions; buffering thatch's own writes would echo the store back into itself. |
| Nudge carries the serialized payload inline | The skill contract is "you will be given a JSON payload"; a nudge that flushes the buffer without delivering it destroys the data it advertises. |
| Skills installed to `$XDG_CONFIG_HOME/opencode/skills`, plugin-owned | Installing into the worktree dirties user repos. Overwrite-on-drift lets skill updates ship with plugin versions; the cost (clobbering local edits) is accepted. |
| Hook failures logged, never swallowed | Two integration points were dead for weeks behind bare `catch {}`. |

## Hook wiring (hard-won specifics)

- `tool.execute.after` is a **top-level plugin hook**; it does not exist on
  the event bus. Registering it inside the `event` handler compiles and never
  fires.
- `session.created`'s payload is `{ properties: { info: Session } }` — the id
  is `properties.info.id`, not `properties.id`.
- Repo detection must use the `worktree` the plugin receives; `process.cwd()`
  is the opencode server's cwd and misfiles every store when the server isn't
  started from the project directory.

## Architecture

```
observe:  tool.execute.after → ExtractionPipeline (per-session ring buffer, 20)
nudge:    chat.message → flush buffer → synthetic text part with JSON payload
act:      agent + thatch-fact-extractor skill → thatch_memory_remember

surface:  thatch_find_duplicates → candidates minus checked pairs
act:      agent + thatch-dedup-classifier skill → remember/forget
settle:   thatch_dedup_mark_checked → dedup_pairs verdict
```

## Dependencies

Unchanged from plan 001. The amputation removed code, not dependencies.
