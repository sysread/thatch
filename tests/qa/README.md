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
    index.test.ts    Barrel file that imports all auto use cases (for parallel execution)
    uc-NNN-name.ts   Individual use case definitions
  live/              Live-session use cases — spawn opencode run, cost tokens, up to 10 min each
    index.test.ts    Barrel file that imports all live use cases (for parallel execution)
    uc-NNN-name.ts   Individual use case definitions
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

Opencode-driven use cases run one leg per installed opencode major
(`[v1]`/`[v2]` suffixed test names) when several are installed.
`QA_HOSTS=v1` narrows to one major while iterating.

Override the model with `QA_MODEL=venice/<model-id>`.

## Sandbox isolation

Every spawned opencode process (runner, live sessions) runs inside a
per-fixture sandbox. The runner sets all four XDG surfaces in the child
env (`runner.ts` fixture env):

| Surface | Override | What it isolates |
|---------|----------|------------------|
| `XDG_STATE_HOME` | `dir/home/.local/state` | **Daemon discovery.** The background daemon registers itself at `$XDG_STATE_HOME/opencode/service.json` (url, pid, password). This is the easy one to miss: without it a spawned `opencode run` JOINS THE REAL DAEMON - sessions land in the real session store and the plugin executes in the real daemon's env (real memories, real chat roster). |
| `XDG_DATA_HOME` | `dir/home/.local/share` | The session database. `--standalone` private servers still share the XDG-scoped session db, so data isolation needs its own override. |
| `XDG_CONFIG_HOME` | `dir/config` | Thatch's db/config + the plugin shim + installed skills. |
| `THATCH_DB_PATH` | `dir/thatch.db` | Thatch's own db directly (the plugin resolves this before the XDG default). |

Anything spawning opencode OUTSIDE this runner (a manual reproduction of a
live scenario, a sandboxed TUI smoke) must set the same four. `--standalone`
is a useful addition for a manual TUI session: a private child server that
dies with the TUI (stdin-lease), never joining a shared daemon. The
session-tab plan's live-smoke section carries a worked example.

Known coupling: the fixture PRE-COPIES skills from the real
`~/.config/opencode/skills`, so count assertions there can lag the checkout
until the real config installs the newest skill (uc-014 asserts a floor
while the real config is behind, strict once it catches up). Clear a stale
master cache with `rm -rf "$TMPDIR/thatch-qa-master"`.

Run against v1 while v2 is the default binary:
`PATH="$(brew --cellar)/opencode/1.18.32/bin:$PATH" mise run qa-auto`.

## Adding a use case

1. Create `tests/qa/auto/uc-NNN-name.ts` or
   `tests/qa/live/uc-NNN-name.ts` (no `.test.ts` extension — only the
   barrel file uses that).
2. Import `registerUseCase` and `UseCase` (and `QaContext` if automatable)
   from `../runner`. If the use case spawns opencode itself (custom `run`
   that shells out, or a serve), declare `hosts: ["v1", "v2"]` so the
   ordinary qa tasks run it against every discovered install - and build
   the invocation with `opencodeRunArgs`, since the hosts disagree on
   `run` flags.
3. Define the scenario with `name`, `preconditions`, `steps`, and
   `expected` as string arrays joined by `\n`.
4. For automatable use cases, add a `run(ctx: QaContext)` function that
   verifies the scenario and returns `"PASS"`, `"FAIL"`, or `"PARTIAL"`.
5. Call `registerUseCase(useCase)`.
6. Add an `import "./uc-NNN-name";` line to the corresponding
   `index.test.ts` barrel file.

The runner handles fixture setup (isolated repo copy, temp DB, env vars),
dry-run skipping, manual-only skipping, timeouts, and result assertions.

## Why barrel files?

Bun's `--concurrent` flag parallelizes tests *within a single file*, not
across files. Each use case file calls `registerUseCase()` which calls
`test.concurrent()`, but if each lives in its own `.test.ts` file, bun
runs them one at a time. The `index.test.ts` barrel imports all use case
modules so their `test.concurrent()` calls register in one file, and
`--concurrent --max-concurrency 5` runs 5 at once.

## Isolation

Each use case runs inside a copy of the repo at `/tmp/thatch-qa/<name>/`.
The copy is created via `git archive HEAD` (tracked files only) with
`node_modules` symlinked from the real repo. Opencode's own npm deps and
pre-installed skills are copied from `~/.config/opencode/`. Each copy has
its own temp database, config dirs, and home directory. The real repo,
real config, and real database are never touched.

Requires `VENICE_API_KEY` in the environment for live-session use cases.
Automatable use cases don't need it.
