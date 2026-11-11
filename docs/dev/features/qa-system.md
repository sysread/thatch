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
`tests/qa/live/<leg>/uc-NNN-name.ts`) imports `registerUseCase` and `UseCase` from
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
| UC-131 | cli-memory-write | `thatch remember` end to end over the single write path |
| UC-143 | memory-display-stamp | stamped displays withheld at both buffer sites + the funnel (Layer 1) |
| UC-144 | forget-tombstones | deletion guards hold matching re-writes; `thatch tombstones` list/clear (Layer 2) |
| UC-145 | doctor-diagnostics | `thatch doctor` verdicts, the orphaned-marker fail, the read-only contract |

### Live use cases

Spawn real opencode sessions. Test the full pipeline with a real model. These
cost model tokens and have a 20-minute per-use-case timeout. Live use cases
check for `opencode` on PATH at runtime: if it is present they run; if not,
they skip with `[MANUAL]`. Seven (UC-006, UC-010, UC-013, UC-083, UC-084,
UC-085, and UC-125) are
`manualOnly: true` for infrastructure reasons (Cursor hook lifecycle, nested
opencode session timeout, compaction trigger, sub-agent support, skill
loading, a PR with prior review comments, and the TUI-local tab strip). Run
them locally with `mise run qa-live`.

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
| UC-038 | no-save-run | an extraction child that finds nothing worth saving (no toast) |
| UC-043 | compaction-suppression | extraction nudges suppressed while an extraction child runs |
| UC-077 | child-session-drain | direct extraction: the child drains the parent's queue |
| UC-078 | child-session-error | direct extraction: the child errors, held entries requeue |
| UC-079 | child-session-deletion | direct extraction: the child is deleted, entries requeue |
| UC-080 | parent-session-deletion | parent deleted mid-extraction, cleanup completes |
| UC-083 | review-coordinator | the multi-agent review coordinator pipeline |
| UC-084 | review-walkthrough | the change-walkthrough skill on a real diff |
| UC-085 | review-followup | follow-up round verification against prior review comments, plus a clarity and slop check on prose the fixes introduce |
| UC-086 | review-response | author-side response to incoming review comments, with a per-fix prose check |
| UC-087 | review-no-subagents | the solo review path on hosts without sub-agents |
| UC-098 | chat-cross-session | two real opencode sessions exchange chat messages |
| UC-119 | session-tab-spawn | the session_tab spawn flow end to end |
| UC-122 | review-mode-commands | /thatch/self-review and /thatch/peer-review overlay efficacy (seeded fixture) |
| UC-125 | session-tab-switched-window | coordinator-anchored tab routing: a spawn from a window viewing a different-directory tab still opens the strip tab (manualOnly - the strip is TUI-local) |

### mise tasks

| Task | Command | Purpose |
|------|---------|---------|
| `qa` | `bun test tests/qa/auto/index.test.ts --concurrent --max-concurrency 5 && bun test tests/qa/live/index.test.ts` | Run all QA (auto first, then live) |
| `qa-dry-run` | `QA_DRY_RUN=1 bun test tests/qa/auto/index.test.ts tests/qa/live/index.test.ts --concurrent --max-concurrency 5` | List use cases without spawning sessions |
| `qa-auto` | `bin/qa-run auto` | Run automatable only (fast, no LLM). Pass UC names as args to select a subset. |
| `qa-live` | `bin/qa-run live` | Run live only (spawns opencode, costs tokens). Pass UC names as args to select a subset. |

### The opencode binary (single-host)

The plugin requires opencode 2, so the QA subsystem is single-host:
opencode-driven use cases (live default-run ones, and automatable ones
whose `run` spawns the binary - UC-100 spawns `opencode serve`, UC-098
spawns run; those set `spawnsOpencode: true` on the `UseCase`) resolve
the binary through discovery.

Discovery (tests/qa/binaries.ts) asks the package manager where its
formulas are installed (`brew --prefix opencode`, `brew --prefix
opencode-v2`), falls back to the PATH-resolved binary, validates each
candidate by running `--version`, and tags it by major (the version
output decides, not the formula name). Only a `v2`-tagged install is a
usable host - a discovered v1 binary is never selected (the plugin cannot
load under it); when one is found its bin dir is prepended to the
fixture PATH, otherwise the PATH binary runs as-is.

`opencode run` needs `--standalone` (the default run waits on the shared
background daemon, which a fixture sandbox must not boot).
`opencodeRunArgs(ctx, prompt)` in the runner builds the invocation;
`runViaOpencode` and UC-098's custom runs go through it.

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

The runner creates a **master copy** of the repo via `git archive HEAD`
(tracked files only — no `.git`, no `node_modules`, no untracked artifacts).
`node_modules` is symlinked from the real repo to share
deps including the HF embedding model cache. opencode's own npm deps
(`~/.config/opencode/node_modules/`) are copied into the master so each use
case has them without a warm-up session.

Both the master copy and the fixture tree are **run-scoped**: every qa-auto
process gets its own `$TMPDIR/thatch-qa-master-<run-id>` master and
`/tmp/thatch-qa/<run-id>/` fixture root (run id = pid + timestamp). Two
concurrent qa-auto runs (two worktrees gating at once) are therefore fully
independent — before this, the second run's master setup `rmSync`'d the
shared roots and deleted the first run's live fixtures mid-test, surfacing
as `SQLiteError: disk I/O error` (UC-100), exit-1 saves (UC-131), and empty
CLI output (UC-132/130). `tests/qa-runner-isolation.test.ts` pins this
contract with real concurrent subprocesses. Dead runs' roots are reclaimed
by an age-based GC (older than 24h) on the next run's setup.

Each use case gets a per-use-case copy of the master via `createFixture(name)`,
with isolated `HOME`, `XDG_CONFIG_HOME`, `THATCH_DB_PATH`, and
`THATCH_QUEUE_DIR` environment variables, plus `THATCH_NO_NOTIFY=1` so no
fixture subprocess (opencode included) can fire a real desktop notification
on the host mid-run. The repo is read-only during QA —
sessions run inside `/tmp/thatch-qa/<run-id>/<uc-name>/` copies.

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
| `tests/qa/live/index.test.ts` | Live QA entry — the DEFAULT leg only (opencode) |
| `tests/qa/live/opencode/` | The opencode leg's use cases + barrel |
| `tests/qa/live/claude/` | The CLAUDE leg (real `claude -p` sessions with the plugin; OPT-IN per run - never a default gate; assertions read only plugin-written surfaces) |
| `tests/qa/auto/uc-NNN-*.ts` | Automatable use case files, one per use case |
| `tests/qa/live/<leg>/uc-NNN-*.ts` | Live use case files, one per use case, per leg |

No separate QA docs directory exists. QA use cases live in `tests/qa/` as executable tests, not docs.

## Key invariants

1. **Automatable use cases never spawn an LLM.** They test CLI, hooks, DB, and
   tool execution directly.
2. **Live use cases spawn real opencode sessions and cost model tokens.** They
   skip with `[MANUAL]` when `opencode` is not on PATH; seven are
   `manualOnly: true` for infrastructure reasons.
3. **`QA_DRY_RUN=1` lists use cases without executing.** Use this for CI and
   coverage review.
4. **Each use case follows the structured format**: preconditions, steps,
   expected.
5. **Use cases self-register via `registerUseCase`** — no central registry to
   maintain. Add a new `.ts` file and import it from the barrel.
6. **The repo is read-only during QA.** Sessions run inside
   `/tmp/thatch-qa/<run-id>/<uc-name>/` copies created from `git archive HEAD`.
7. **The 20-minute test timeout is the agent-session budget, not test
   execution time.** Reducing it will cause live use cases to time out.
