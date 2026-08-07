---
name: thatch-qa
description: Run manual QA use-case scenarios for the thatch project in isolated temp environments. Use when asked to do QA testing, run use cases, or verify thatch features end-to-end.
---

# Thatch QA: Use-Case Runner

You are running manual QA for the thatch project. Each use case in
`docs/qa/use-cases/UC-NNN-*.md` describes a scenario with preconditions,
steps, and expected results. You execute them in isolated temp environments
that never touch the developer's real config, database, or skill installs.

## Environment setup

Every use case runs inside a throwaway directory under `/tmp`. Using `/tmp`
explicitly (instead of `$TMPDIR`) avoids permission prompts: the global
opencode config already allows `/tmp/**` for external directory access, and
sub-agents inherit that permission. On macOS, `$TMPDIR` resolves to a
`/var/folders/` path that may not match the existing allow rule.

### Creating the environment

Run this before any use case. Each sub-agent creates its own environment
so parallel use cases never share state.

```bash
QA_ROOT=$(mktemp -d /tmp/thatch-qa-XXXXXX)

# Opencode config: temp dir so no real ~/.config/opencode is read or written
mkdir -p "$QA_ROOT/config/opencode/plugins"
mkdir -p "$QA_ROOT/home"

# Thatch data: temp DB and queue so the real store is never touched
# (THATCH_DB_PATH and THATCH_QUEUE_DIR are read at process start, not
# module load, so exporting them before spawning processes works.)

# Claude Code config: temp dir so setup tests don't write to ~/.claude
mkdir -p "$QA_ROOT/claude"

# Minimal opencode config that loads the thatch plugin from the dev checkout
cat > "$QA_ROOT/config/opencode/opencode.json" << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "snapshot": false
}
EOF

# Plugin loader: imports from the dev source, not an npm package
cat > "$QA_ROOT/config/opencode/plugins/thatch.ts" << 'EOF'
export { server } from "/Users/jeff.ober/dev/thatch/src/index";
EOF
```

### Environment variables

Export these before running any thatch CLI command or opencode session.
They redirect every config path to the temp tree and disable all external
config discovery.

| Variable | Value | Why |
|----------|-------|-----|
| `XDG_CONFIG_HOME` | `$QA_ROOT/config` | Opencode reads `$XDG_CONFIG_HOME/opencode/` for config and skills. Redirecting here prevents reading or writing `~/.config/opencode`. |
| `HOME` | `$QA_ROOT/home` | Git, SSH, and other tools resolve `~` from `HOME`. A temp home prevents them from finding real config files. |
| `THATCH_DB_PATH` | `$QA_ROOT/thatch.db` | Thatch's SQLite database. Default is `~/.config/thatch/thatch.db`. Redirecting prevents cross-contamination with the real store. |
| `THATCH_QUEUE_DIR` | `$QA_ROOT/queue` | File-backed extraction queue for Claude Code/Cursor hooks. Default is `~/.cache/thatch/queue/`. |
| `CLAUDE_CONFIG_DIR` | `$QA_ROOT/claude` | Claude Code config root. `thatch setup --claude` writes here. Default is `~/.claude`. |
| `OPENCODE_DISABLE_CLAUDE_CODE` | `1` | Stops opencode from reading `~/.claude/CLAUDE.md` and scanning `~/.claude/skills/`. |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | `1` | Stops opencode from scanning `~/.claude/skills/` and `~/.agents/skills/` for skill definitions. |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | `1` | Stops the upward directory walk for `opencode.json`, `.opencode/`, and `AGENTS.md`/`CLAUDE.md` files. The test runs from the repo, but we do not want project config to merge in. |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | `1` | Skips loading built-in opencode plugins. The thatch plugin loads from the temp config's `plugins/` dir, which is not affected by this flag. |
| `CURSOR_PROJECT_DIR` | unset | Prevents the MCP server from detecting Cursor as the host. |
| `CLAUDE_PROJECT_DIR` | unset | Prevents the MCP server from detecting Claude Code as the host. |

Do NOT set `OPENCODE_PURE=1`. That flag empties plugin origins and would
prevent the thatch plugin from loading. The thatch plugin lives in the
temp config's `plugins/` directory, which is separate from npm plugin
discovery.

Do NOT set `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT`. The temp
`opencode.json` in `$XDG_CONFIG_HOME/opencode/` is the config. Setting
either of these would layer additional config on top, which is
unnecessary and could mask issues.

### Exporting the variables

```bash
export XDG_CONFIG_HOME="$QA_ROOT/config"
export HOME="$QA_ROOT/home"
export THATCH_DB_PATH="$QA_ROOT/thatch.db"
export THATCH_QUEUE_DIR="$QA_ROOT/queue"
export CLAUDE_CONFIG_DIR="$QA_ROOT/claude"
export OPENCODE_DISABLE_CLAUDE_CODE=1
export OPENCODE_DISABLE_EXTERNAL_SKILLS=1
export OPENCODE_DISABLE_PROJECT_CONFIG=1
export OPENCODE_DISABLE_DEFAULT_PLUGINS=1
unset CURSOR_PROJECT_DIR CLAUDE_PROJECT_DIR
```

### Cleanup

Remove the temp directory when the use case is done:

```bash
rm -rf "$QA_ROOT"
```

## Use case discovery

Read every `UC-NNN-*.md` file from `docs/qa/use-cases/`. Each file has:

- **Preconditions**: what state the system must be in
- **Steps**: numbered actions to perform
- **Expected**: observable outcomes to verify

Some use cases carry an _Automatable_ note flagging which are pure
file/IPC/CLI contracts that can be verified without a live LLM session.
Use cases without that note need a live opencode session or real
embedding model and are harder to automate.

## Batching strategy

Dispatch use cases to sub-agents in batches of 3. Each sub-agent:

1. Creates its own isolated environment (the setup above)
2. Reads the use case file
3. Executes the steps
4. Verifies the expected outcomes
5. Reports a structured result
6. Cleans up its temp directory

Wait for each batch to complete before dispatching the next. This keeps
the parallelism bounded and makes result collection manageable.

### Sub-agent prompt template

Give each sub-agent:

- The full use case file content (preconditions, steps, expected)
- The repo path: `/Users/jeff.ober/dev/thatch`
- The environment setup instructions (the env vars and directory
  structure above)
- The bun and mise binary paths (they are on PATH; no special setup
  needed)
- Instructions to report results in this format:

```
UC-NNN: <title>
Result: PASS | FAIL | PARTIAL | MANUAL-ONLY
Evidence:
  - What was run
  - What was observed
  - What matched or didn't match the expected outcome
```

### What each sub-agent can do

- **Run bun tests**: `bun test tests/<module>.test.ts` from the repo
  root. The test suite uses mock embeddings and temp DBs, so it needs
  no environment setup beyond the repo itself.
- **Run the CLI**: `bun run bin/thatch <subcommand>` with the env vars
  exported. The CLI uses the temp DB and temp config.
- **Run setup commands**: `bun run bin/thatch setup --claude` and
  `--cursor` write to the temp config dirs.
- **Inspect files**: read the temp config dirs to verify artifacts were
  written (`.mcp.json`, `CLAUDE.md`, `hooks.json`, skill files).
- **Run opencode sessions**: `opencode run "<prompt>"` with the env
  vars exported. This starts a real session with the thatch plugin
  loaded from the dev source. Needs the real embedding model (downloads
  on first use, ~34 MB, cached after that). Use sparingly — it costs
  model tokens.

### What sub-agents cannot do

- **Visual TUI verification**: no way to see toast notifications, TUI
  layout, or interactive prompts. Use cases that require visual
  verification should be marked MANUAL-ONLY.
- **Real Claude Code or Cursor sessions**: those hosts have their own
  process models that sub-agents cannot drive. Use cases specific to
  those hosts should verify the file artifacts (setup output, hook
  commands) rather than running the hosts.
- **Compaction**: opencode compaction is triggered by context window
  limits, which cannot be reliably forced in a short session. UC-013
  is MANUAL-ONLY.

## Result aggregation

After all batches complete, present a summary table:

```
| UC | Title | Result | Notes |
|----|-------|--------|-------|
| 001 | Remember and recall across sessions | PASS | ... |
| 002 | Deduplication review cycle | PASS | ... |
| ... | ... | ... | ... |
```

Count PASS, FAIL, PARTIAL, and MANUAL-ONLY results. Flag any FAIL or
PARTIAL for follow-up.

## Before starting

1. Run `mise run check` from the repo root to confirm the automated
   suite passes. If it fails, fix the failures before running manual
   QA — there is no point testing use cases on top of a broken build.
2. Confirm `bun` and `opencode` are on PATH.
3. Read all UC files to plan the batches.
