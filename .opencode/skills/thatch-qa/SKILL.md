---
name: thatch-qa
description: Run manual QA use-case scenarios for the thatch project in isolated temp environments. Use when asked to do QA testing, run use cases, or verify thatch features end-to-end.
---

# Thatch QA: Use-Case Runner

You are running manual QA for the thatch project. Each use case in
`docs/qa/use-cases/UC-NNN-*.md` describes a scenario with preconditions,
steps, and expected results. You execute them in isolated temp environments
that never touch the developer's real config, database, or skill installs.

## The repo is read-only

The thatch repo at `/Users/jeff.ober/dev/thatch` is READ-ONLY during QA.
Sub-agents may read files from it and run commands in it, but must never
write to it, commit to it, or generate files in it. This is not a
suggestion. Previous QA runs have clobbered README.md, created stray
AGENTS.md files, and committed "init" to main. These are destructive
failures caused by sub-agents that treated the repo as writable.

The rules below are mechanical. Follow them exactly.

## Environment setup

Every use case runs inside a throwaway directory under `/tmp`. Using `/tmp`
explicitly (instead of `$TMPDIR`) avoids permission prompts: the global
opencode config already allows `/tmp/**` for external directory access, and
sub-agents inherit that permission. On macOS, `$TMPDIR` resolves to a
`/var/folders/` path that may not match the existing allow rule.

### Creating the environment

Each sub-agent creates its own environment so parallel use cases never
share state. The sub-agent's working directory is `$QA_ROOT`, NOT the
repo.

```bash
REPO=/Users/jeff.ober/dev/thatch
QA_ROOT=$(mktemp -d /tmp/thatch-qa-XXXXXX)

# Opencode config: temp dir so no real ~/.config/opencode is read or written
mkdir -p "$QA_ROOT/config/opencode/plugins"
mkdir -p "$QA_ROOT/home"
mkdir -p "$QA_ROOT/claude"
mkdir -p "$QA_ROOT/queue"

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

# All work happens inside QA_ROOT. cd there now.
cd "$QA_ROOT"
```

### Environment variables

Export these before running any thatch CLI command or opencode session.
They redirect every config path to the temp tree and disable all external
config discovery.

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

| Variable | Value | Why |
|----------|-------|-----|
| `XDG_CONFIG_HOME` | `$QA_ROOT/config` | Opencode reads `$XDG_CONFIG_HOME/opencode/` for config and skills. Redirecting here prevents reading or writing `~/.config/opencode`. |
| `HOME` | `$QA_ROOT/home` | Git, SSH, and other tools resolve `~` from `HOME`. A temp home prevents them from finding real config files. |
| `THATCH_DB_PATH` | `$QA_ROOT/thatch.db` | Thatch's SQLite database. Default is `~/.config/thatch/thatch.db`. Redirecting prevents cross-contamination with the real store. |
| `THATCH_QUEUE_DIR` | `$QA_ROOT/queue` | File-backed extraction queue for Claude Code/Cursor hooks. Default is `~/.cache/thatch/queue/`. |
| `CLAUDE_CONFIG_DIR` | `$QA_ROOT/claude` | Claude Code config root. `thatch setup --claude` writes here. Default is `~/.claude`. |
| `OPENCODE_DISABLE_CLAUDE_CODE` | `1` | Stops opencode from reading `~/.claude/CLAUDE.md` and scanning `~/.claude/skills/`. |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | `1` | Stops opencode from scanning `~/.claude/skills/` and `~/.agents/skills/` for skill definitions. |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | `1` | Stops the upward directory walk for `opencode.json`, `.opencode/`, and `AGENTS.md`/`CLAUDE.md` files. |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | `1` | Skips loading built-in opencode plugins. The thatch plugin loads from the temp config's `plugins/` dir, which is not affected by this flag. |
| `CURSOR_PROJECT_DIR` | unset | Prevents the MCP server from detecting Cursor as the host. |
| `CLAUDE_PROJECT_DIR` | unset | Prevents the MCP server from detecting Claude Code as the host. |

Do NOT set `OPENCODE_PURE=1`. That flag empties plugin origins and would
prevent the thatch plugin from loading.

Do NOT set `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT`. The temp
`opencode.json` in `$XDG_CONFIG_HOME/opencode/` is the config.

### Cleanup

```bash
rm -rf "$QA_ROOT"
```

## Use case discovery

Read every `UC-NNN-*.md` file from `/Users/jeff.ober/dev/thatch/docs/qa/use-cases/`.
Each file has:

- **Preconditions**: what state the system must be in
- **Steps**: numbered actions to perform
- **Expected**: observable outcomes to verify

Some use cases carry an _Automatable_ note flagging which are pure
file/IPC/CLI contracts that can be verified without a live LLM session.
Use cases without that note need a live opencode session or real
embedding model and are harder to automate.

## Batching strategy

Dispatch use cases to sub-agents in batches of 5. Each sub-agent:

1. Creates its own isolated environment (the setup above)
2. Reads the use case file from the repo (read-only)
3. Executes the steps inside its temp environment
4. Verifies the expected outcomes
5. Reports a structured result
6. Cleans up its temp directory

Wait for each batch to complete before dispatching the next.

## Sub-agent safety contract

Include this contract VERBATIM in every sub-agent prompt. These are
hard constraints, not guidelines.

```
SAFETY CONTRACT — READ THIS BEFORE DOING ANYTHING

The repo at /Users/jeff.ober/dev/thatch is READ-ONLY.

NEVER do any of these in the repo:
- git commit, git push, git tag, git reset, git add, git rm
- Write, edit, or create any file in the repo directory
- Run /init or generate AGENTS.md
- Run any command that modifies files in the repo

The ONLY git commands allowed in the repo are read-only:
  git log, git show, git diff, git status, git branch

ALL writes go to your temp directory ($QA_ROOT). If a use case step
says to edit a file, copy it to $QA_ROOT first and edit the copy.

Do NOT fix anything. QA is verification only. If a use case fails,
report it. Do not edit code, fix tests, update docs, or make any
changes. The user decides what to fix after reviewing findings.

Your working directory is $QA_ROOT, not the repo. Commands that need
the repo (bun test, bin/thatch, reading source files) reference it by
absolute path: /Users/jeff.ober/dev/thatch
```

## Sub-agent prompt template

Give each sub-agent:

- The safety contract above, verbatim
- The full use case file content (preconditions, steps, expected)
- The repo path: `/Users/jeff.ober/dev/thatch`
- The environment setup instructions (the env vars and directory
  structure above)
- Instructions to report results in this format:

```
UC-NNN: <title>
Result: PASS | FAIL | PARTIAL | MANUAL-ONLY
Evidence:
  - What was run
  - What was observed
  - What matched or didn't match the expected outcome
```

## What each sub-agent can do

- **Run bun tests**: `cd /Users/jeff.ober/dev/thatch && bun test tests/<module>.test.ts`
  (read-only — tests use mock embeddings and temp DBs internally)
- **Run the CLI**: `cd /Users/jeff.ober/dev/thatch && bun run bin/thatch <subcommand>`
  with the env vars exported. The CLI writes to the temp DB and temp config.
- **Run setup commands**: `bun run bin/thatch setup --claude` and
  `--cursor` write to `$CLAUDE_CONFIG_DIR` (the temp dir).
- **Inspect files**: read the temp config dirs to verify artifacts were
  written (`.mcp.json`, `CLAUDE.md`, `hooks.json`, skill files).
- **Run opencode sessions**: `opencode run "<prompt>"` with the env vars
  exported. This starts a real session with the thatch plugin loaded from
  the dev source. Needs the real embedding model (downloads on first use,
  ~34 MB, cached after that). Use sparingly — it costs model tokens.

## What sub-agents cannot do

- **Visual TUI verification**: no way to see toast notifications, TUI
  layout, or interactive prompts. Mark as MANUAL-ONLY.
- **Real Claude Code or Cursor sessions**: those hosts have their own
  process models that sub-agents cannot drive. Verify file artifacts
  instead.
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
PARTIAL for follow-up. Do NOT fix anything — present findings only.

## Before starting

1. Run `mise run check` from the repo root to confirm the automated
   suite passes. If it fails, fix the failures before running manual
   QA — there is no point testing use cases on top of a broken build.
2. Confirm `bun` and `opencode` are on PATH.
3. Read all UC files to plan the batches.
