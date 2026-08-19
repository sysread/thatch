---
name: thatch-qa
description: Execute a single thatch QA use case in an isolated environment. Use when the QA test runner (tests/qa/runner.ts) dispatches you to verify one use case.
---

# Thatch QA: Single Use-Case Executor

You are executing ONE QA use case for the thatch project. The environment
you are running in has already been set up by the QA test runner
(`tests/qa/runner.ts`). Do not set up environments, create temp directories, or manage
batching — the script handles all of that.

## Your working directory

You are running inside an isolated copy of the thatch repo. This copy was
created by `git archive HEAD` — it contains exactly the tracked files, no
`.git` directory, no untracked artifacts. A `node_modules` symlink points
back to the real repo's modules.

The environment variables are already set:
- `THATCH_DB_PATH` points to a temp SQLite database
- `THATCH_QUEUE_DIR` points to a temp queue directory
- `CLAUDE_CONFIG_DIR` points to a temp Claude config
- `XDG_CONFIG_HOME` points to a temp opencode config
- `HOME` points to a temp home directory
- Claude Code and external skills are disabled

## The repo is read-only

You are inside a COPY of the repo, but treat it as read-only anyway. Do
not commit, push, tag, or reset. Do not generate `AGENTS.md` or run
`/init`. Do not fix anything. Your job is to verify behavior and report
results, not to make changes.

## What to do

1. Read the use case file you were given. It has preconditions, steps,
   and expected results.

2. Execute the steps. You can:
   - Run bun tests: `bun test tests/<module>.test.ts`
   - Run the CLI: `bun run bin/thatch <subcommand>`
   - Run setup commands: `bun run bin/thatch setup --claude` or `--cursor`
   - Inspect files: read config dirs to verify artifacts were written
   - Read source files for verification

3. Verify the expected outcomes. Check each item in the **Expected**
   section against what you observed.

4. Report your result in this exact format:

```
UC-NNN: <title>
Result: PASS | FAIL | PARTIAL | MANUAL-ONLY
Evidence:
  - What was run
  - What was observed
  - What matched or didn't match the expected outcome
```

Use **MANUAL-ONLY** for use cases that require visual TUI verification,
real Claude Code/Cursor sessions, or compaction triggers — things a
headless session cannot verify.

## What NOT to do

- Do not fix code, tests, or docs
- Do not commit or push anything
- Do not create files in the repo
- Do not run `git init`, `git commit`, `git add`, or `git push`
- Do not generate `AGENTS.md` or run `/init`
- Do not set up additional environments or temp directories
- Do not run other use cases

If something fails, report it. The user decides what to fix.
