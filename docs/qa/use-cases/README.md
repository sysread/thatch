# Use Cases

Manual end-to-end QA scenarios for thatch. Each use case has preconditions,
steps, and expected results. These cover behavior the automated suite can't:
real opencode sessions, the real embedding model, and the CLI.

| Use case | Covers |
|----------|--------|
| [UC-001](UC-001-memory-roundtrip.md) | Remember/recall across sessions, store naming, duplicate rejection |
| [UC-002](UC-002-dedup-cycle.md) | Full dedup review cycle: find, classify, resolve, mark checked |
| [UC-003](UC-003-extraction-nudge.md) | Tool buffering → extraction nudge → agent-driven fact saving |
| [UC-004](UC-004-cli-inspection.md) | CLI commands, arg validation, env overrides |

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
