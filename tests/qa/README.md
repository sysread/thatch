# QA Use-Case Suite

End-to-end QA scenarios for the thatch project. These are **not** unit tests
— the regular unit suite lives in `tests/*.test.ts` and is run by
`mise run check`. This suite verifies end-to-end behavior through the same
interfaces a user would use (CLI, setup commands, module APIs), either with
or without a live LLM session.

## Directory structure

```
tests/qa/
  runner.ts          Shared library: UseCase interface, fixture setup, opencode runner
  auto/              Automatable use cases — no LLM, no model tokens, ~90 seconds
  live/              Live-session use cases — spawn opencode run, cost tokens, up to 10 min each
```

## auto/ vs live/

Put a use case in `auto/` if it can be verified without a live LLM session.
This means the scenario can be checked by:

- Running the CLI (`bun run bin/thatch <subcommand>`) and asserting on
  exit codes, stdout, or file artifacts written to disk
- Importing thatch modules directly (ThatchDB, ExtractionPipeline,
  extract-queue, setup, etc.) and calling functions with a temp DB
- Checking file presence and content after `thatch setup --claude/--cursor`

Put a use case in `live/` if it requires a live agent session — the scenario
needs the LLM to read a prompt, make tool calls, and respond. These use the
default `runViaOpencode` helper (no custom `run` function).

Use `manualOnly: true` for use cases that cannot be automated at all (visual
TUI verification, compaction triggers, real Claude Code/Cursor sessions).

## Running

```bash
mise run qa          # auto first (&&), then live
mise run qa-auto     # only automatable (fast, no tokens)
mise run qa-live     # only live sessions
mise run qa-dry-run  # list all without spawning
```

Override the model with `QA_MODEL=venice/<model-id>`.

## Adding a use case

1. Create `tests/qa/auto/uc-NNN-name.test.ts` or
   `tests/qa/live/uc-NNN-name.test.ts`.
2. Import `registerUseCase` and `UseCase` (and `QaContext` if automatable)
   from `../runner`.
3. Define the scenario with `name`, `preconditions`, `steps`, and
   `expected` as string arrays joined by `\n`.
4. For automatable use cases, add a `run(ctx: QaContext)` function that
   verifies the scenario and returns `"PASS"`, `"FAIL"`, or `"PARTIAL"`.
5. Call `registerUseCase(useCase)`.

The runner handles fixture setup (isolated repo copy, temp DB, env vars),
dry-run skipping, manual-only skipping, timeouts, and result assertions.

## Isolation

Each use case runs inside a copy of the repo at `/tmp/thatch-qa/<name>/`.
The copy is created via `git archive HEAD` (tracked files only) with
`node_modules` symlinked from the real repo. Opencode's own npm deps and
pre-installed skills are copied from `~/.config/opencode/`. Each copy has
its own temp database, config dirs, and home directory. The real repo,
real config, and real database are never touched.

Requires `VENICE_API_KEY` in the environment for live-session use cases.
Automatable use cases don't need it.
