---
name: thatch-docs
description: Documentation conventions for the thatch project. Use when writing or updating docs in docs/dev, docs/qa, docs/user, docs/plans, or the root README.
---

# Thatch Documentation Conventions

You are editing documentation for the thatch project. Follow these conventions
exactly so the docs stay consistent, the markdownlint gate passes, and future
contributors can find what they need.

## Directory structure

```
docs/dev/           Architecture and internals for contributors
docs/qa/            Test plan (automated suite coverage, known gaps)
docs/user/          User-facing install and usage guide
docs/plans/         Design-decision snapshots (temporary, see graduation below)
docs/in-progress/   Work-in-progress docs for features being built (ignored by markdownlint)
tests/qa/           QA use-case suite (auto/ and live/ subdirs, uc-NNN-*.ts, run via mise run qa)
```

When a feature in `docs/in-progress/` is complete, graduate it: move
durable architecture into `docs/dev/`, add a use-case test to
`tests/qa/`, then delete the in-progress file. An empty
`docs/in-progress/` directory can be removed; it will be recreated when
needed.

## What goes where

- **docs/dev/README.md** is the main architecture doc. It holds the module
  map, hook table, design invariants, data-flow diagrams, database schema, and
  local development instructions. Update it when module responsibilities,
  hooks, or data flows change.
- **docs/dev/gotchas.md** holds non-obvious invariants and footguns. Add an
  entry when something costs debugging time and the fix is not obvious from
  the code.
- **docs/dev/setup-and-hooks.md** documents the concrete files and hook
  events each host writes (opencode, Claude Code, Cursor). Update when hook
  commands or artifact paths change.
- **docs/dev/mcp-parity.md** tracks feature parity across the three hosts.
  Update the parity matrix when a gap closes or a new feature ships.
- **docs/dev/skills.md** documents the skill system: the two arrays
  (SHARED_SKILLS, OPENCODE_ONLY_SKILLS), REVIEW_COMMON interpolation, install
  mechanics, and the procedure for adding a skill. Update the skill count and
  table when skills are added or removed.
- **tests/qa/** holds end-to-end QA use-case scenarios as bun test files.
  Each file is `uc-NNN-name.ts` in `tests/qa/auto/` or `tests/qa/live/`
  following the pattern in `tests/qa/runner.ts`. Run with `mise run qa`.
- **docs/user/README.md** is the user-facing guide: installation, tool
  reference, skill list. Write for someone who has never seen the codebase.

## Adding a QA use case

Create `tests/qa/auto/uc-NNN-name.ts` (or `tests/qa/live/` for live tests)
following the pattern of existing use case files. Import `registerUseCase`
and `UseCase` from `../runner`,
define the scenario with `preconditions`, `steps`, and `expected` as
string arrays joined by `\n`, then call `registerUseCase(useCase)`.

Most use cases use the default `runViaOpencode` (no custom `run`).
Automatable use cases override `run` with direct CLI/bun assertions.
Manual-only use cases set `manualOnly: true`.

## Plan and in-progress graduation

Plans in `docs/plans/` and work-in-progress docs in `docs/in-progress/`
are temporary. When a plan or in-progress feature is fully implemented:

1. Remove the plan or in-progress file.
2. Ensure the final architecture is documented in `docs/dev/` (update
   existing docs or create a new one).
3. Ensure a use-case test exists in `tests/qa/`.
4. The dev docs and use-case docs are the permanent record. Git history
   preserves the original file if someone needs the design reasoning.

Do NOT maintain a plan index in the README. Plans are temporary and the
README describes the graduation process, not a list of active plans.

## Markdownlint gate

The quality gate (`mise run check`) runs markdownlint-cli2 on `README.md` and
`docs/**/*.md`, excluding `docs/plans/**` and `docs/in-progress/**` (when it
exists).

Disabled rules (in `.markdownlint-cli2.jsonc`):
- MD013 (line length) — dense table-heavy house style
- MD032 (blanks around lists) — use-case template uses tight lists
- MD036 (emphasis as heading) — use-case template uses bold labels
- MD060 (table alignment) — table-heavy house style

Everything else is enforced: heading hierarchy, code-block language (MD040),
trailing newline (MD047), etc. Run `mise run lint-md` to check docs without
the test suite.

## House style

- Em dashes and arrows are the house style for prose docs. They appear
  throughout existing docs. Do not flag or replace them. (The ASCII
  punctuation preference in OPENCODE.md applies to PR descriptions and code
  diffs, not project prose docs.)
- Tables are used heavily. Keep them dense and readable.
- Code blocks use fenced syntax with a language tag.
- Cross-reference other docs with relative paths
  (`[skills.md](skills.md)`), not absolute paths.
- File paths in prose use backticks (`src/index.ts`).
- One idea per sentence. One topic per paragraph.
- Define subsystem-specific terms on first use. Translate project-private
  labels into plain behavior before using them.

## When updating skill counts

Several doc files carry hardcoded skill counts that drift when skills are
added or removed. Touch all of these when the count changes:

1. `docs/dev/README.md` — skills.ts description line
2. `docs/dev/skills.md` — skill count and table
3. `docs/user/README.md` — skill tables and category sections
4. `tests/qa/auto/uc-005-setup-install.ts` — shared skill count in expected string
5. `tests/qa/auto/uc-014-skill-install-drift.ts` — shared vs opencode counts in expected string

## Before committing doc changes

Run `mise run lint-md` to verify the markdownlint gate passes. If you added
a new docs subdirectory, add it to the markdownlint globs in
`.markdownlint-cli2.jsonc` unless it is an in-progress directory (those go in
the ignores list instead).
