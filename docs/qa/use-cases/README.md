# Use Cases

Manual end-to-end QA scenarios for thatch. Each use case has preconditions,
steps, and expected results. These cover behavior the automated suite can't:
real opencode sessions, the real embedding model, and the CLI.

Newer use cases carry an _Automatable_ note flagging which are pure
file/IPC/CLI contracts ready to graduate into `bun:test` integration tests.

| Use case | Covers |
|----------|--------|
| [UC-001](UC-001-memory-roundtrip.md) | Remember/recall across sessions, store naming, duplicate rejection |
| [UC-002](UC-002-dedup-cycle.md) | Full dedup review cycle: find, classify, resolve, mark checked |
| [UC-003](UC-003-extraction-nudge.md) | Tool buffering → extraction nudge → agent-driven fact saving |
| [UC-004](UC-004-cli-inspection.md) | CLI commands, arg validation, env overrides |
| [UC-005](UC-005-setup-install.md) | `thatch setup --claude`/`--cursor`, project-local + `--global`, idempotent re-run, legacy hook migration |
| [UC-006](UC-006-cursor-hook-lifecycle.md) | Cursor hook lifecycle: `buffer-tool` (`conversation_id`), `flush-tools --json`, queue drain |
| [UC-007](UC-007-recall-nudge.md) | Prompt-aware recall nudge — opencode in-process + Claude/Cursor sideband paths; no telemetry |
| [UC-008](UC-008-hygiene-heartbeat.md) | Hygiene heartbeat: stale 90d, orphaned branches, pending dedup; advisory, agent-driven |
| [UC-009](UC-009-flush-tools-tiers.md) | `flush-tools` three-tier priority (extraction > recall > write) + sideband degradation |
| [UC-010](UC-010-prime.md) | `thatch prime` CLI dispatch chain (opencode/Cursor/claude), child exit code |
| [UC-011](UC-011-write-time-similarity-warning.md) | Write-time warning never blocks; merge or mark-distinct reconciliation |
| [UC-012](UC-012-model-migration.md) | `THATCH_MODEL` change: old memories skipped (not corrupted) until re-saved |
| [UC-013](UC-013-compaction-context.md) | Compaction context re-familiarization (opencode-only) |
| [UC-014](UC-014-skill-install-drift.md) | Skill install: 18 shared vs 19 opencode; drift overwritten on re-setup |
| [UC-015](UC-015-env-override-matrix.md) | `THATCH_DB_PATH`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `THATCH_QUEUE_DIR`, `THATCH_RECALL_THRESHOLD`, `THATCH_MODEL` |
| [UC-016](UC-016-concurrent-session-isolation.md) | Per-session extraction isolation (in-memory + file queue); shared stateless sideband |
| [UC-017](UC-017-buffer-tool-vs-buffer-batch.md) | `buffer-batch` (Claude, `tool_calls[]`+`session_id`) vs `buffer-tool` (Cursor, single+`conversation_id`) |
| [UC-018](UC-018-mcp-startup-setup-detection.md) | MCP startup detects missing/broken setup instructions and warns the agent |

## Template

```markdown
# UC-NNN: Title

**Preconditions**
- State of the system before the test

**Steps**
1. Action
2. Action

**Expected**
- Observable outcome
```
