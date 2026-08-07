# Plans

Numbered plan documents capture design decisions that span multiple sessions.
Each plan is a snapshot of the reasoning at the time — subsequent plans may
supersede earlier ones as the project evolves.

## Active plans

| Plan | Description |
|------|-------------|
| [001 — Memory Store](001-memory-store.md) | Initial memory feature: stores, embeddings, tools |
| [002 — Agent-Driven Pipelines](002-agent-driven-pipelines.md) | Extraction/dedup through the agent; hook wiring specifics; supersedes 001's "no CLI" |
| [003 — Memory Hygiene](003-memory-hygiene.md) | Write-time collision warning, recall telemetry, session heartbeat, cluster dedup |
| [004 — Intuition Drives](004-intuition-drives.md) | Pre-response deliberation layer: perception, parallel drives, synthesis; first-message-only; opencode-only |
| [005 — Nomenclater](005-nomenclater.md) | Per-session agent naming; geeky/sci-fi names generated on first message of new sessions; opencode-only |

## Plan format

Each plan should cover:

1. **Synopsis** — 1-2 line summary
2. **Decisions** — table of choices made, with rationale where non-obvious
3. **Architecture** — module layout and data flow
4. **Dependencies** — runtime, built-in, and dev deps
