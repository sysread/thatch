# Showcase Cleanup Plan

Audit-driven cleanup of separation-of-concerns violations, dead code, stale
docs, and incomplete migrations. Ordered by ease and risk: low-hanging fruit
first, then complexity and surface area.

## Phase 1: Low-hanging fruit (trivial fixes, no risk)

One PR. Each item is a mechanical edit.

1. **Stale `bin/qa` references in thatch-qa skill**
   - `.opencode/skills/thatch-qa/SKILL.md:3,10` — replace "bin/qa" with
     "tests/qa/runner.ts" or "bun test framework"
   - The QA runner was migrated in commit `edae400`

2. **Stale QA paths in thatch-docs skill**
   - `.opencode/skills/thatch-docs/SKILL.md:20` — `uc-NNN-*.test.ts` -> `uc-NNN-*.ts`
   - `.opencode/skills/thatch-docs/SKILL.md:48` — same extension fix
   - `.opencode/skills/thatch-docs/SKILL.md:55` — `tests/qa/uc-NNN-name.test.ts` -> `tests/qa/auto/uc-NNN-name.ts` or `tests/qa/live/`
   - `.opencode/skills/thatch-docs/SKILL.md:56` — import path `./runner` -> `../runner` (files now one level deeper)
   - `.opencode/skills/thatch-docs/SKILL.md:118-119` — stale file paths with `.test.ts` extension

3. **Stale `docs/plans/README.md` references**
   - Line 3: "Numbered plan documents" -> "Plan documents" (numbered prefix dropped August 2026)
   - Line 12: `docs/qa/use-cases/` -> `tests/qa/` (directory migrated)

4. **Stale inline comment in skills.md**
   - `docs/dev/skills.md:98` — `/* 21 skills above */` -> `/* 22 skills above */`

5. **Stale line numbers in gotchas.md**
   - `docs/dev/gotchas.md:44` — `db.ts:211` -> `db.ts:395`
   - `docs/dev/gotchas.md:64` — `index.ts:169` -> `index.ts:366`
   - `docs/dev/gotchas.md:74` — `index.ts:65` -> `index.ts:79`
   - `docs/dev/gotchas.md:74` — `index.ts:131` -> `index.ts:272`

6. **Dead code: `installClaudeSkills` wrapper**
   - `src/setup.ts:215` — zero-value wrapper, just calls `installSkills()`
   - Called at lines 264 (Claude setup) and 413 (Cursor setup, naming leak)
   - Replace both call sites with `installSkills(paths.skillsDir)` and delete the function

7. **Dead code: `truncate` and `summarizeArgs` exports**
   - `src/extraction.ts:57` — `truncate` exported, used only internally at line 77
   - `src/extraction.ts:14` — `summarizeArgs` exported, used only internally at line 76
   - Remove the `export` keyword from both (keep the functions, they are used internally)

8. **Dead code: `claudeExtractionNudge` wrapper**
   - `src/prompts.ts:523` — backwards-compat wrapper, no production callers
   - Only used in `tests/plugin.test.ts:1236-1249`
   - Delete the function and its tests. The test block is labeled and self-contained.

9. **Dead code: `populationP0` method**
   - `src/db.ts:929` — "v2 feature: not yet wired", tests only
   - Delete the method and its tests in `tests/prediction.test.ts:42-43,277-294`
   - If v2 population prior is ever needed, it can be re-added at that time

10. **CI bun version unpinned**
    - `.github/workflows/ci.yml:16` — `bun-version: latest` -> `bun-version: "1.3.14"`
    - `.github/workflows/publish.yml:22` — same fix
    - Matches `mise.toml:9` pin

11. **`@types/bun: "latest"` unpinned**
    - `package.json:31` — pin to `"^1.3.0"` or the installed version

12. **`scratchpad/` untracked directory**
    - Empty dir at repo root, no purpose. Delete it.
    - Add `scratchpad/` to `.gitignore` for good measure

13. **CLI command list missing `flush-predictions`**
    - `docs/dev/README.md:46-47` — add `flush-predictions` to the command list

14. **flush-tools hook description incomplete**
    - `docs/dev/setup-and-hooks.md:74` — add prediction and behavior to the description
    - `docs/dev/setup-and-hooks.md:114` — same for Cursor

## Phase 2: Sideband limit bug + remaining doc gaps

One PR. Small surface area, low risk.

1. **Sideband `predictions` and `behaviors` ignore `limit` parameter**
   - `src/sideband.ts:130` — hardcoded `5` -> `req.limit`
   - `src/sideband.ts:138` — hardcoded `5` -> `req.limit`
   - The `match` handler already uses `req.limit` (line 144)
   - All current callers pass `5`, so this is latent but a real contract violation

2. **`thatch-coding-workflow` missing from user-facing docs**
   - `docs/user/README.md` — no dedicated row in any category table
   - Add a row to the "Writing and workflow" or similar category
   - Add to the host-availability table

3. **`thatch_get_extraction_payload` missing from user README tool tables**
   - `docs/user/README.md` — extraction tools section only lists `thatch_extraction_done`
   - Add `thatch_get_extraction_payload` row

## Phase 3: Triplicated prompts consolidation

One PR. Medium surface area, medium risk. The three prompt functions in
`src/prompts.ts` (`systemPrompt`, `claudeInstructions`, `cursorInstructions`)
each contain ~150 lines of duplicated persistence instructions. Extract the
shared prose into a constant, then compose each host variant from the shared
constant plus host-specific header/footer.

Approach:
- Extract the shared rules body (Stores, Session Startup, Skills, When to
  Write, What to Store, What NOT to Store, Archived Memories, Explicit
  Requests, Situational Behaviors, Background Task Completions, User Decision
  Model) into a `SHARED_PERSISTENCE_RULES` string constant
- Each host function composes: host-specific intro + `SHARED_PERSISTENCE_RULES` + host-specific tool list and skills list
- The tool lists and skills lists differ per host (prefix, ordering, host-only skills) so those stay per-function
- Verify with `mise run check` — the prompt tests in `tests/plugin.test.ts` and `tests/setup.test.ts` will catch regressions

Risk: prompt text is load-bearing for agent behavior. The tests assert
specific phrases appear in the output. Run the full test suite after extraction
and diff the composed output against the current output to verify no text was
lost or changed.

## Phase 4: db.ts separation of concerns

One PR. Large surface area, medium risk. `db.ts` is 1409 lines with 5+ concerns
mixed into one class. This is the most visible SoC violation for a code review.

Approach: extract concerns into separate modules that `ThatchDB` imports or
delegates to. Do NOT change the public API of `ThatchDB` — callers should not
need to change. Internal refactoring only.

1. **Extract vector math**
   - `blobToVector` and `cosineSimilarity` -> `src/vector-math.ts`
   - Pure functions, no dependencies. `db.ts` imports them.

2. **Extract prediction engine**
   - `src/prediction.ts` — matchers, predictions, edges, provenance, scoring, dedup
   - Takes a `Database` (bun:sqlite Database instance) in its constructor
   - `ThatchDB` delegates prediction calls to `this.#predictions`
   - Move `PREDICTION_K`, `PREDICTION_P0`, `PREDICTION_W_SOFT` constants here

3. **Extract behavior engine**
   - `src/behavior.ts` — same shape as prediction
   - `ThatchDB` delegates behavior calls to `this.#behaviors`
   - Move `BEHAVIOR_K`, `BEHAVIOR_P0`, `BEHAVIOR_W_SOFT` constants here

4. **Extract hygiene signals**
   - `src/hygiene-db.ts` or fold into existing `src/hygiene.ts`
   - `stalenessReport`, `branchScopingReport` DB queries
   - `hygiene.ts` already calls these via `ThatchDB`; the queries can move there

Do NOT extract schema/migration — that belongs in the DB module. Do NOT
extract CRUD operations — those are the core DB concern.

Risk: the prediction and behavior engines share SQL structure. Phase 5
addresses the duplication. This phase just moves code, it does not merge it.

## Phase 5: Prediction/behavior engine dedup

One PR. Medium surface area, high risk if done wrong. The two engines are
structurally identical (same table shapes, same scoring, same Bayesian
formula) with table-name substitutions.

Approach: create a generic `ScoringEngine` parameterized by table names.
Both `PredictionEngine` and `BehaviorEngine` become thin wrappers that
configure the generic engine with their table names and any behavioral
differences (e.g., behavior uses ham/spam, prediction uses confirm/disconfirm).

This is the highest-risk phase because the SQL is hand-written and
table-name interpolation in SQL is not trivial to do safely. Consider whether
the dedup is worth the risk. The two engines are ~300 lines each. A generic
engine would be ~250 lines plus ~30 lines of configuration per engine. Net
savings: ~320 lines, but with increased abstraction.

Decision point: if the employer showcase is imminent, skip this phase. The
duplication is visible but understandable (the doc comment explains it).
A botched merge could introduce subtle SQL injection or logic bugs.

## Phase 6: Remaining code quality

Low priority, can be done after the showcase.

1. **`MockEmbeddingModel` in production source**
   - `src/embeddings.ts:92-124` — move to `tests/mocks/embeddings.ts` or
     `tests/helpers/`. Update 12 test imports.

2. **`extractionNudge` is two functions gated by a string prefix**
   - `src/prompts.ts:455` — split into `opencodeExtractionNudge` and
     `mcpExtractionNudge`. Each caller knows which host it is.

3. **`extractionDoneDef.execute` has two roles**
   - `src/tool-defs.ts:457` — the `session_id` parameter switches between
     no-op and drain. Consider whether the no-op role is even needed
     (the opencode path doesn't use it). If not, make `session_id` required
     and drop the no-op branch.

4. **Duplicated prediction-verb logic**
   - `prompts.ts:763` and `tool-defs.ts:497` both implement
     `evidence_count === 0 ? "you may prefer" : "you tend to"`
   - Extract to a shared helper

5. **`formatRecallResult` uses `any` instead of its actual input type**
   - `src/tool-defs.ts:72` — type the parameter as `MemoryRow & { _score: number }`

6. **Test coverage gaps**
   - Behavior tool execute functions untested in `tests/tool-defs.test.ts`
   - Sideband `predictions` and `behaviors` methods untested
   - `src/mcp.ts` has no dedicated test file

7. **Working-tree clutter: root `thatch` socket**
   - Stray Unix socket from a dev session. Not from sideband (that goes in
     `tmpdir()`). Delete and add `thatch` to `.gitignore`.

## What was already fixed (no action needed)

These items from the initial audit were already addressed by the latest
commit (`c7e9c33` "Add behavior engine, MCP auto-refresh, raise auto-fire
thresholds"):

- Behavior engine undocumented in docs/dev/README.md — **already documented**
  (module table line 61, hook table line 79, data flow lines 270-280, toast
  notifications lines 223-224)
- Behavior engine undocumented in docs/user/README.md — **already documented**
  (tool tables lines 123-126, auto-fire lines 168-173)
- Behavior engine undocumented in docs/dev/mcp-parity.md — **already documented**
  (parity matrix line 29, sideband protocol lines 155-158)
- Tool count stale (13) in docs/qa/README.md — **already correct** (says 18)
- Tool count stale (13) in docs/dev/mcp-parity.md — **already correct** (says 18)
- Root README missing behavior engine — **check needed** (grep found no "behavior"
  match outside of review-skill descriptions)
