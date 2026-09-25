# QA System

Thatch ships a suite of QA use cases that verify end-to-end behavior. Each use
case is a `bun:test` file that runs in an isolated environment — a
temp-directory copy of the repo, not the working tree itself. Use cases are
split into **automatable** (no LLM, fast) and **live** (spawns opencode, costs
model tokens).

## What it does

- Automatable use cases run without an LLM — they test CLI behavior, hooks, DB
  operations, and tool execution directly via bun assertions
- Live use cases spawn real opencode sessions — they test the full
  nudge/extraction/skill pipeline with a real model
- `mise` tasks for running subsets: `qa` (all), `qa-auto` (fast), `qa-live`
  (model), `qa-dry-run` (list only)
- Each use case follows a structured format: preconditions, steps, expected
  results

## How it works

### Use case structure

Each use case file (`tests/qa/auto/uc-NNN-name.ts` or
`tests/qa/live/uc-NNN-name.ts`) imports `registerUseCase` and `UseCase` from
`../runner`, defines the scenario with `preconditions`, `steps`, and `expected`
as string arrays joined by newlines, then calls `registerUseCase(useCase)`.

Most use cases use the default `runViaOpencode` (no custom `run`). Automatable
use cases override `run` with direct CLI/bun assertions. Manual-only use cases
set `manualOnly: true`.

Individual use case files are `.ts` (not `.test.ts`) so bun does not discover
them as standalone test files. Each directory has an `index.test.ts` **barrel
file** that imports all use case modules. Bun's `--concurrent` flag
parallelizes tests within a single file, not across files. The barrel pattern
registers all use cases in one suite, enabling `--concurrent
--max-concurrency 5` to run 5 use cases at once (33s vs 88s sequential for the
auto suite).

### Automatable use cases

Run without an LLM. Test CLI behavior, hooks, DB operations, and tool
execution directly via bun assertions. These are fast and run in parallel.

| UC | Name | What it tests |
|----|------|---------------|
| UC-004 | cli-inspection | `stores`, `list`, `show`, `forget`, `search` subcommands |
| UC-005 | setup-install | setup installs correct files for Claude Code and Cursor |
| UC-008 | hygiene-heartbeat | hygiene report at session start (duplicates, stale, orphaned) |
| UC-009 | flush-tools-tiers | three priority tiers: extraction, recall, write nudge |
| UC-011 | write-time-similarity-warning | `memory_remember` warns about near-duplicates |
| UC-012 | model-migration | switching `THATCH_MODEL` makes old entries invisible |
| UC-014 | skill-install-drift | `installSkills` overwrites drifted content |
| UC-015 | env-override-matrix | `THATCH_RECALL_THRESHOLD`, `THATCH_PREDICTION_THRESHOLD`, `THATCH_BEHAVIOR_THRESHOLD` |
| UC-016 | concurrent-session-isolation | sessions don't interfere with each other |
| UC-017 | buffer-tool-vs-buffer-batch | Cursor per-tool vs Claude Code batch queueing |
| UC-018 | mcp-startup-setup-detection | `checkSetup` at MCP server startup |
| UC-021 | prediction-autofire | prediction nudge fires at `chat.message` |
| UC-022 | prediction-dedup | cosine >= 0.85 dedup for matchers and predictions |
| UC-023 | prediction-confidence-model | Bayesian posterior with confirm/disconfirm/soft |
| UC-024 | prediction-delete | semantic-match deletion with cascade |
| UC-025 | behavior-autofire | behavior nudge fires at `chat.message` |
| UC-026 | behavior-dedup | cosine >= 0.85 dedup for matchers and behaviors |
| UC-027 | behavior-confidence-model | ham/spam adjusts Bayesian confidence |
| UC-028 | behavior-delete | semantic-match deletion with cascade |

### Live use cases

Spawn real opencode sessions. Test the full pipeline with a real model. These
cost model tokens and have a 20-minute per-use-case timeout. Live use cases
check for `opencode` on PATH at runtime: if it is present they run; if not,
they skip with `[MANUAL]`. Three (UC-006, UC-010, UC-013) are
`manualOnly: true` for infrastructure reasons (Cursor hook lifecycle, nested
opencode session timeout, compaction trigger). Run them locally with
`mise run qa-live`.

| UC | Name | What it tests |
|----|------|---------------|
| UC-001 | memory-roundtrip | remember -> recall -> show -> forget |
| UC-002 | dedup-cycle | `find_duplicates` -> classify -> merge -> `mark_checked` |
| UC-003 | extraction-nudge | tool use -> buffer -> nudge -> `extraction_done` |
| UC-006 | cursor-hook-lifecycle | Cursor hooks: `sessionStart`, `postToolUse`, `beforeSubmitPrompt` |
| UC-007 | recall-nudge | prompt-aware recall at `chat.message` |
| UC-010 | prime | `thatch prime` runs the project-primer skill |
| UC-013 | compaction-context | compaction hook injects context |
| UC-019 | archived-memory-lifecycle | archive -> search excludes -> unarchive -> search includes |
| UC-020 | extraction-escalation | polite -> insistent -> ALL-CAPS over missed nudges |

### mise tasks

| Task | Command | Purpose |
|------|---------|---------|
| `qa` | `bun test tests/qa/auto/index.test.ts --concurrent --max-concurrency 5 && bun test tests/qa/live/index.test.ts` | Run all QA (auto first, then live) |
| `qa-dry-run` | `QA_DRY_RUN=1 bun test tests/qa/auto/index.test.ts tests/qa/live/index.test.ts --concurrent --max-concurrency 5` | List use cases without spawning sessions |
| `qa-auto` | `bin/qa-run auto` | Run automatable only (fast, no LLM). Pass UC names as args to select a subset. |
| `qa-live` | `bin/qa-run live` | Run live only (spawns opencode, costs tokens). Pass UC names as args to select a subset. |

### The opencode version matrix (default behavior)

Every task that runs opencode-driven use cases runs one leg per
DISCOVERED opencode install, with test names suffixed
(`UC-001-memory-roundtrip [v1]`, `UC-001-memory-roundtrip [v2]`) when
there are several. There is no separate matrix command - the ordinary
tasks just do the matrix based on what is available.

Discovery (tests/qa/binaries.ts) asks the package manager where its
formulas are installed (`brew --prefix opencode`, `brew --prefix
opencode-v2`), falls back to the PATH-resolved binary, validates each
candidate by running `--version`, tags it by major (`v1`, `v2` - the
version output decides, not the formula name), and dedups candidates
that resolve to the same binary. A machine with one install runs
single-leg with unsuffixed names, so single-binary setups behave
exactly as they did before the matrix existed.

A use case opts into or restricts the matrix with `hosts: ["v1"]` /
`["v2"]` / `["v1", "v2"]` on the `UseCase`:

- Live use cases (no custom `run`) are matrixed by default - the default
  `runViaOpencode` path spawns opencode by definition.
- Automatable use cases keep a single leg unless they declare `hosts` -
  the fast suite is not doubled for cases that never touch opencode.
  Declare `hosts` when a custom `run` spawns opencode itself (UC-098) or
  drives a serve (UC-100).

`QA_HOSTS=v1` (comma-separated) narrows the legs when iterating against
one major; a value matching no discovered install registers nothing
with an explanatory line.

Legs get separate fixtures (the fixture directory is keyed by test name
suffix) because hosts cannot share one: a v2 session db in a shared
fixture fails the v1 leg's serve with "Database is not empty and has no
session table".

The v1 and v2 `run` CLIs disagree on flags (v1 has `--dir`, which v2
dropped; v2 needs `--standalone` to skip the background daemon, which a
fixture sandbox must not boot). `opencodeRunArgs(ctx, prompt)` in the
runner builds the right invocation per leg by version-detecting the
binary the leg's PATH selects; `runViaOpencode` and UC-098's custom runs
go through it.

The `qa` task runs auto first via `&&`. Auto failures stop before live runs.
The `qa-live` task does not use `--concurrent` — live sessions are
resource-heavy and benefit from sequential execution.

### Runner architecture

`tests/qa/runner.ts` provides the `registerUseCase` function and the `UseCase`
type. The runner index files (`tests/qa/auto/index.test.ts` and
`tests/qa/live/index.test.ts`) import all use case files in their directory,
which self-register via `registerUseCase`. The runner then executes each use
case.

The `QA_DRY_RUN=1` environment variable causes the runner to print use case
names and descriptions without executing them. This is useful for CI and for
reviewing coverage without spawning sessions.

### Isolation model

The runner creates a **master copy** of the repo at `/tmp/thatch-qa/master/`
via `git archive HEAD` (tracked files only — no `.git`, no `node_modules`, no
untracked artifacts). `node_modules` is symlinked from the real repo to share
deps including the HF embedding model cache. opencode's own npm deps
(`~/.config/opencode/node_modules/`) are copied into the master so each use
case has them without a warm-up session.

Each use case gets a per-use-case copy of the master via `createFixture(name)`,
with isolated `HOME`, `XDG_CONFIG_HOME`, `THATCH_DB_PATH`, and
`THATCH_QUEUE_DIR` environment variables. The repo is read-only during QA —
sessions run inside `/tmp/thatch-qa/<uc-name>/` copies.

The `qa` skill (`.opencode/skills/qa/SKILL.md`) instructs the
LLM on how to execute a single use case in the isolated directory. The skill's
safety contract is intentionally fixed text — do not paraphrase it.

### Execution modes

1. **Live session** (default): no custom `run` function → `runViaOpencode`
   spawns `opencode run --dir <ctx.dir> --model <MODEL> --auto` with the use
   case content as prompt. Requires `VENICE_API_KEY`. Default model:
   `venice/zai-org-glm-5-2` (override with `QA_MODEL` env var). Uses
   `Bun.spawn()` (not `Bun.$`) so the process can be killed on timeout (590s
   SIGTERM, SIGKILL in finally). The 20-minute per-test timeout is the
   wall-clock budget for a complete LLM-driven agent session — do not reduce
   it.
2. **Automatable**: custom `run(ctx)` function with direct CLI/bun assertions.
   No opencode session, no API key.
3. **Manual-only**: `manualOnly: true` → test is skipped, prints `[MANUAL]`.

### Relationship to the quality gate

`mise run check` uses a flat glob (`tests/*.test.ts`) that excludes
`tests/qa/`. QA tests spawn opencode sessions and cannot run in the normal
quality gate. The QA files are typechecked by `tsconfig.check.json` (which
includes all of `tests/`), just not executed during `check`. See
[cicd.md](cicd.md) for the full CI pipeline.

## Interactions with other features

- **All features**: QA use cases verify end-to-end behavior of every feature
- [cicd.md](cicd.md): `mise run check` uses a flat glob (`tests/*.test.ts`)
  that excludes `tests/qa/`; CI runs `bun test` which includes the QA barrels;
  `mise run qa` runs the full QA suite separately
- [setup.md](setup.md): UC-005 and UC-018 test setup installation and detection
- [nudge-pipeline.md](nudge-pipeline.md): UC-007, UC-009, UC-021, UC-025 test
  nudge tiers
- [extraction.md](extraction.md): UC-003, UC-020 test extraction nudge and
  escalation
- [hygiene.md](hygiene.md): UC-008 tests the hygiene heartbeat
- [memory-store.md](memory-store.md): UC-001, UC-004, UC-011, UC-012, UC-019
  test memory CRUD, search, warnings, migration, archival
- [deduplication.md](deduplication.md): UC-002 tests the dedup cycle
- [prediction-engine.md](prediction-engine.md): UC-021 through UC-024 test
  auto-fire, dedup, confidence, delete
- [behavior-engine.md](behavior-engine.md): UC-025 through UC-028 test
  auto-fire, dedup, confidence, delete
- [../skills.md](../skills.md): UC-014 tests skill drift detection
- [multi-host.md](multi-host.md): UC-006, UC-017 test Cursor hooks and
  buffer-tool vs buffer-batch

## Source files

| File | Role |
|------|------|
| `tests/qa/runner.ts` | `registerUseCase`, `UseCase` type, `ensureMaster`, `createFixture`, `runViaOpencode`, execution logic |
| `tests/qa/auto/index.test.ts` | Automatable use case barrel — imports all auto use case modules |
| `tests/qa/live/index.test.ts` | Live use case barrel — imports all live use case modules |
| `tests/qa/auto/uc-NNN-*.ts` | Automatable use case files, one per use case |
| `tests/qa/live/uc-NNN-*.ts` | Live use case files, one per use case |

No separate QA docs directory exists. QA use cases live in `tests/qa/` as executable tests, not docs.

## Key invariants

1. **Automatable use cases never spawn an LLM.** They test CLI, hooks, DB, and
   tool execution directly.
2. **Live use cases spawn real opencode sessions and cost model tokens.** They
   skip with `[MANUAL]` when `opencode` is not on PATH; three are
   `manualOnly: true` for infrastructure reasons.
3. **`QA_DRY_RUN=1` lists use cases without executing.** Use this for CI and
   coverage review.
4. **Each use case follows the structured format**: preconditions, steps,
   expected.
5. **Use cases self-register via `registerUseCase`** — no central registry to
   maintain. Add a new `.ts` file and import it from the barrel.
6. **The repo is read-only during QA.** Sessions run inside
   `/tmp/thatch-qa/<uc-name>/` copies created from `git archive HEAD`.
7. **The 20-minute test timeout is the agent-session budget, not test
   execution time.** Reducing it will cause live use cases to time out.
