# UC-010: thatch prime

**Preconditions**
- Thatch installed and `bun` on PATH
- At least one of: opencode (for `opencode run`), Cursor (`agent` CLI), or Claude Code
  (`claude`) on PATH

**Steps**
1. From a project root, run `thatch prime`
2. Let the selected child CLI run the `thatch-project-primer` skill to completion
3. After it finishes, inspect the project store (`thatch list`)

**Expected**
- `prime` resolves the first available CLI in order — `opencode run`, then
  `agent -p --approve-mcps` (Cursor), then `claude` — and spawns it with the project-primer
  prompt.
- The primer skill recalls existing memories first, investigates the codebase from multiple
  angles, and writes foundational memories via `thatch_memory_remember` (project vs global
  assignment per its own rules), then runs dedup afterward.
- `prime` exits with the **child process's exit code** (0 on success).
- If no supported CLI is on PATH, `prime` fails fast with a clear error rather than spawning
  nothing.

_Automatable: partial — the CLI dispatch selection (which child, which flags, exit-code
pass-through) is automatable; the LLM's real investigation and memory writing are manual._