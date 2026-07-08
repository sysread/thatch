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
