# Feature Architecture

Per-feature architecture docs for thatch. Each doc covers what the feature
does, how it works, how it interacts with other features, and the source
files that implement it.

For the monolithic architecture overview, see
[../README.md](../README.md). For hook configuration and concrete artifact
paths, see [../setup-and-hooks.md](../setup-and-hooks.md). For feature
parity across hosts, see [../mcp-parity.md](../mcp-parity.md). For the skill
system, see [../skills.md](../skills.md). For non-obvious invariants, see
[../gotchas.md](../gotchas.md).

## Docs

| Doc | Feature |
|-----|---------|
| [memory-store.md](memory-store.md) | Persistent memory store (CRUD, search, embeddings, stores, branches) |
| [multi-host.md](multi-host.md) | Three-host architecture (opencode, Claude Code, Cursor) |
| [extraction.md](extraction.md) | Extraction pipeline (buffering, child sessions, nudge escalation, file-backed queue) |
| [nudge-pipeline.md](nudge-pipeline.md) | Per-message nudge pipeline (extraction, recall, prediction, behavior tiers) |
| [prediction-engine.md](prediction-engine.md) | Prediction engine (user decision model, Bayesian confidence, auto-fire) |
| [behavior-engine.md](behavior-engine.md) | Behavior engine (LLM self-discipline rules, ham/spam, auto-fire) |
| [hygiene.md](hygiene.md) | Hygiene system (duplicate, stale, orphaned branch signals) |
| [deduplication.md](deduplication.md) | Deduplication system (find pairs, verdict lifecycle) |
| [sideband.md](sideband.md) | Sideband IPC (Unix socket for MCP host hook processes) |
| [compaction-recovery.md](compaction-recovery.md) | Compaction recovery (opencode compaction hooks) |
| [session-lifecycle.md](session-lifecycle.md) | Session lifecycle management (opencode events, child tracking) |
| [setup.md](setup.md) | Setup system (markers, checkSetup, auto-refresh, binary resolution) |
| [cli.md](cli.md) | CLI (subcommands, environment variables) |
| [database.md](database.md) | Database (schema, migrations, WAL, 11 tables) |
| [qa-system.md](qa-system.md) | QA system (93 use cases, automatable vs live, mise tasks) |
| [cicd.md](cicd.md) | CI/CD (CI pipeline, OIDC publishing, release helper) |
