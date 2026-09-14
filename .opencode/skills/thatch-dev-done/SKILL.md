---
name: thatch-dev-done
description: Definition-of-done checklist for coding tasks in the thatch repo. Use when starting a coding task in this repo, so the checklist shapes the work, and again when you believe the task is complete, before committing or claiming done. Covers the quality gate, QA use case coverage and maintenance, unit tests, and the two-tier docs.
---

# Thatch dev definition of done

Load this checklist twice: when the task starts, and at the finish line.
Most items are cheap to satisfy while you work and expensive to retrofit.
Before you say the task is done or commit, work the whole checklist. Every
item here exists because skipping it let something drift silently.

## The gate

- Run `mise run check` (typecheck + unit tests + markdownlint). It must pass
  before you claim done or commit. Never commit red.
- If a pre-existing failure fails the gate and is unrelated to your change,
  flag it to Jeff instead of working around it.
- If a failure looks like a flake, rerun once before blaming your change,
  then investigate for real if it reproduces.

## QA use cases

`mise run check` does NOT execute `tests/qa/`. Run `mise run qa-auto`
yourself; it is fast and catches what the gate cannot.

- New or changed user-visible behavior gets a use case in `tests/qa/auto/`
  (custom `run(ctx)`, direct assertions, no model tokens). Live-session use
  cases in `tests/qa/live/` are for behavior only a real opencode session
  can exercise.
- Every use case file must be imported from its suite's `index.test.ts`
  barrel. Without the import, bun never discovers it and it silently never
  runs.
- Count assertions in use cases are the enforcement layer for drift:
  uc-005/uc-014/uc-060 assert skill counts, uc-059 asserts the tool list.
  If you add or remove a tool or skill, update them -- they fail qa-auto,
  not check, so the gate will not remind you.
- If count assertions fail for no obvious reason, the QA master cache may be
  a stale snapshot: `rm -rf "$TMPDIR/thatch-qa-master"` and rerun.

## Unit tests

- Coverage comes first: if the area you are changing is undertested, add
  tests before changing code.
- Tests never reach outside the sandbox: temp-dir SQLite, `MockEmbeddingModel`
  from `tests/mocks/embeddings.ts`, no network. Take dependencies by
  injection (factory pattern) so tests can substitute.
- Count assertions as literals belong in test files -- that is where counts
  are allowed to live, because a mismatch fails the build. See "No
  hardcoded counts" below for the docs side.

## Docs

Doc-code drift is part of the changeset, not scope creep. A doc describing
removed symbols or old behavior is actively misleading. Follow the
thatch-docs skill for style; the surface checklist:

- Features change the **two tiers together**: `docs/user/<feature>.md`
  (product guide) and `docs/dev/features/<feature>.md` (architecture).
- New or removed tools touch `docs/dev/README.md` (module table) and
  `docs/user/README.md` (tool reference) plus both feature tiers.
- New plugin hooks go in the hook table in `docs/dev/README.md`. New
  opencode-only surfaces get a row in `docs/dev/mcp-parity.md`. Host hook
  file changes go in `docs/dev/setup-and-hooks.md`.
- New built-in skills touch many sites that fail no test when missed --
  follow the procedure in `docs/dev/skills.md` and run `mise run qa-auto`.
- A footgun that cost you debugging time and is not obvious from the code
  gets a `docs/dev/gotchas.md` entry.
- **No hardcoded counts in prose docs** -- not skills, tools, use cases, or
  tables. Reference the source of truth (the array, the table, `mise run
  qa-dry-run` output) instead. Counts live only in test assertions.

## Scope and commit hygiene

- Check `git status --porcelain` before staging. Stage only your change's
  files; surface unrelated dirty state to Jeff rather than sweeping it in.
- One commit per logical change. Titles are terse fragments in the
  "Topic: detail" style (`git log --oneline` for examples). No AI
  attribution, no Co-Authored-By lines.
- Verify claims by running the thing, not by reasoning about it. A check
  that reports success without having run is worse than no check.
