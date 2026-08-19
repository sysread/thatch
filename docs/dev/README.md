# Development

## Architecture

Thatch has three integration paths sharing a common core:

1. **OpenCode plugin** — runs inside opencode's Bun runtime. Full access to
   plugin hooks: system prompt injection, session events, tool buffering,
   compaction context.
2. **Claude Code MCP server** — runs as a stdio JSON-RPC process. Tools
   exposed via MCP; session behavior driven by Claude Code hooks.
3. **Cursor MCP server** — same stdio MCP server as Claude Code; session
   behavior driven by Cursor hooks in a flat `hooks.json` format.

For feature parity and gaps across the three, see [mcp-parity.md](mcp-parity.md).
For the concrete files and hook events each host writes, see
[setup-and-hooks.md](setup-and-hooks.md). For non-obvious invariants, see
[gotchas.md](gotchas.md). For the skill system, see [skills.md](skills.md).

```text
Shared core
  ├── tool-defs.ts    → single source of truth: zod schemas + execute logic
  ├── db.ts           → SQLite CRUD, cosine search (recall + search), dedup verdicts
  ├── embeddings.ts   → embedding model via transformers.js
  ├── git.ts          → detect repo identity (store name)
  ├── hygiene.ts      → hygiene report (pending dedups, stale, orphaned branches)
  ├── prompts.ts      → system prompt, compaction, reminders, recall/prediction/behavior nudges, CLAUDE.md instructions
  ├── sideband.ts     → Unix socket server + client: warm-model semantic match for hook processes
  ├── skills.ts       → SKILL.md content + installer (shared + opencode-only arrays)
  ├── scoring-engine.ts → generic four-table scoring base (shared by prediction + behavior engines)
  ├── prediction.ts   → prediction engine wrapper (thin layer over ScoringEngine)
  ├── behavior.ts     → behavior engine wrapper (thin layer over ScoringEngine)
  ├── seed-behaviors.ts → default behavior seeding on first run
  └── vector-math.ts  → blobToVector + cosineSimilarity helpers

OpenCode plugin path
  ├── index.ts        → plugin entry: wires DB/model/extraction, registers tools + hooks
  ├── tools.ts        → thin opencode tool() wrappers over tool-defs
  └── extraction.ts   → in-memory ring buffer + shared payload builders

MCP server path
  ├── mcp.ts          → stdio JSON-RPC server: z.toJSONSchema() for tools/list,
  │                     z.object().parse() for validation, dispatches to tool-defs;
  │                     opens sideband socket for warm-model match queries
  ├── sideband.ts     → Unix socket: SidebandServer (embed + search via warm model)
  │                     and sidebandMatch (thin client for hook processes)
  ├── extract-queue.ts → file-backed JSONL queue (Claude Code + Cursor hooks)
  └── setup.ts        → `thatch setup --claude` / `--cursor`: writes .mcp.json,
                        CLAUDE.md / AGENTS.md, settings/hooks JSON, installs skills

bin/thatch             → CLI: stores|list|show|forget|search|mcp|reminder|hygiene|
                        prime|buffer-batch|buffer-tool|flush-tools|flush-predictions|setup
```

## Module responsibilities

| Module | Responsibility |
|--------|---------------|
| `tool-defs.ts` | **Single source of truth** for all tools. Each tool has a name, description, zod schema (args), and execute function. Framework-agnostic — neither opencode nor MCP specific. |
| `tools.ts` | Thin opencode wrappers. Imports tool-defs, wraps each in opencode's `tool()` with a `thatch_` prefix. |
| `mcp.ts` | Stdio JSON-RPC 2.0 server. Compiles zod schemas to JSON Schema via `z.toJSONSchema()` for `tools/list`. Validates args via `z.object().parse()` in `tools/call`. All logging to stderr (stdout is the transport). |
| `index.ts` | OpenCode plugin entry. Wires DB, model, extraction; registers tools and hooks; installs skills. Internal state beyond the extraction pipeline: `extracting` set (parent IDs with an active direct-extraction child), `childMetrics` map (new/updated/deleted counts per child session), and `triggerExtraction(parentID)` (creates a child session via the SDK client and prompts it with the extraction payload). |
| `setup.ts` | `thatch setup --claude` / `--cursor` installer. Writes MCP config (`.mcp.json` / `.cursor/mcp.json`), appends to CLAUDE.md / AGENTS.md (idempotent), installs hooks in settings.json / hooks.json, installs skills. |
| `hygiene.ts` | Hygiene report: pending dedup pairs, stale count, orphaned branch memories. Shared by the plugin's session-start hook and the CLI's `thatch reminder` command. |
| `git.ts` | Parse `owner/repo` from git remote. Worktree-safe fallback chain. |
| `db.ts` | SQLite schema, CRUD for entries/stores, brute-force cosine search (`search` = pure scoring, `recall` = search + telemetry stamping), dedup-pair verdict tracking. Prediction tables: matchers, predictions, edges, provenance. `scorePredictionNudge` is the shared auto-fire entry point for both host paths. Behavior tables: same four-table shape (matchers, behaviors, edges, provenance) with `scoreBehaviorNudge` as the shared entry point. |
| `embeddings.ts` | Lazy-load the embedding model. Expose `queryEmbed`/`passageEmbed` and the model `name` (stored as an informational tag). `MockEmbeddingModel` for tests. |
| `extraction.ts` | Per-session in-memory ring buffer (cap 20) that buffers non-thatch tool interactions and serializes them into the JSON payload the `get_extraction_payload` tool returns. The in-memory pipeline is opencode-only, but the payload builders (`buildExtractionPayload`, `deriveTitle`) are shared by both paths — `extract-queue.ts` imports `deriveTitle`, `mcp.ts` imports `buildExtractionPayload` for the extraction payload provider. `summarizeArgs` is used internally by `buildExtractionPayload`. |
| `extract-queue.ts` | File-backed per-session JSONL queue (caps 20, oldest dropped). Shared by the Claude Code and Cursor hook paths, which fire one-shot per event with no cross-call state. This is the MCP-side equivalent of `extraction.ts`. |
| `sideband.ts` | Unix domain socket server + client. The MCP server (long-lived, warm model) runs `SidebandServer` so one-shot hook processes can ask it to embed a prompt and search for matches without loading the model themselves. Handles three methods: `match` (recall nudge), `predictions` (prediction auto-fire), and `behaviors` (behavior auto-fire). Socket path is a hash of the DB path — both processes compute it independently. |
| `prompts.ts` | Text constants: opencode system prompt, compaction context, session-start reminder, prompt-aware recall nudge (`recallNudge` / `claudeRecallNudge`), prediction nudge (`predictionNudge`), behavior nudge (`behaviorNudge`), prediction verb selection (`predictionVerb`), Claude Code CLAUDE.md instructions, Cursor AGENTS.md instructions, Claude Code hook text. |
| `skills.ts` | `SKILL.md` content for all thatch skills, plus the installer. Skills are split into `SHARED_SKILLS` (22 skills: fact-extractor, dedup-classifier, project-primer, 7 review specialists, review synthesizer, review context, code archaeology, review followup, review response, change walkthrough, code walkthrough, session reflection, coding-workflow, thatch-pr-description, thatch-ticket-description, thatch-split-overlarge-pr — work on all three hosts) and `OPENCODE_ONLY_SKILLS` (1 skill: code-review coordinator — requires sub-agent support, not installed for Claude Code or Cursor). `installSkills(dir, skills)` defaults to `SHARED_SKILLS`; the opencode plugin passes `[...SHARED_SKILLS, ...OPENCODE_ONLY_SKILLS]`. |
| `scoring-engine.ts` | Generic four-table scoring engine with Bayesian confidence. Shared base for prediction and behavior engines — each wraps it with table-specific names. |
| `prediction.ts` | Thin wrapper around `ScoringEngine` with prediction-specific table names. |
| `behavior.ts` | Thin wrapper around `ScoringEngine` with behavior-specific table names. |
| `seed-behaviors.ts` | Default behavior seeding on first run. Populates starter self-discipline rules. |
| `vector-math.ts` | `blobToVector` and `cosineSimilarity` helpers used across the codebase. |

## Plugin hooks

`index.ts` registers these opencode integration points:

| Hook | What it does |
|------|-------------|
| `experimental.chat.system.transform` | Appends the thatch system prompt (store names, usage rules). |
| `experimental.session.compacting` | Marks the session as compacting and appends re-familiarization context so a compacted session still knows thatch exists. |
| `experimental.compaction.autocontinue` | Clears the compacting flag so `chat.message` nudges resume. Without this, nudges that instruct tool calls would fire during summary generation where tools are blocked. The `chat.message` hook also clears the flag if it fires for a session still in the compacting set but the incoming message has no compaction-type part — this handles compaction failure, where the session would otherwise be stuck with nudges off forever. |
| `tool.execute.after` | Buffers every non-`thatch_*`, non-`skill`, non-`task` tool call into the session's extraction buffer. (Skill/task are excluded — buffering them creates a feedback loop where the nudge triggers a skill load, which gets buffered, which triggers another nudge.) Memory writes (`thatch_memory_remember`) and `thatch_extraction_done` drain the buffer and reset the missed-nudge counter. For child sessions (`childToParent.has(sessionID)`), also tracks metrics: `remember` with `overwrite:false` → new++, `overwrite:true` → updated++, `forget` → deleted++. This is a plugin hook, NOT a bus event — do not move it into the `event` handler; the event bus has no such event and it will silently never fire. |
| `chat.message` | Two priority tiers: (a) if extraction buffer has interactions and the session is NOT in the `extracting` set (direct extraction in progress), **peeks** the buffer (does NOT drain it) and injects a synthetic text part carrying the extraction nudge with the session ID and fetch tool name (not the full payload) — the sub-agent calls `thatch_get_extraction_payload` to retrieve the interactions as a tool response, keeping the full payload out of the main session's context window. The buffer persists until the agent writes a memory or calls `thatch_extraction_done`, so ignored nudges repeat and escalate (polite → insistent → ALL-CAPS) via the `missedNudges` counter; (b) otherwise, embeds the user's prompt text with the in-process warm model, searches `db.search()` across repo + global, and pushes a recall nudge if matches exceed the threshold (default 0.55). The same embedding also feeds the prediction auto-fire (`db.scorePredictionNudge`, injects `[thatch] User decision model`) and the behavior auto-fire (`db.scoreBehaviorNudge`, injects `[thatch] Situational behaviors`). All three nudges (recall, prediction, behavior) fire independently in separate try/catch blocks with separate synthetic parts. Skipped entirely while the session is compacting (tool calls are blocked during summary generation). |
| `event` | Subscribes to all session bus events. `session.created`: records `childToParent` + `parentSnapshots` (shallow copy of the parent's buffer for snapshot-aware drain), then sends the session-start reminder via `client.session.prompt` carrying the hygiene heartbeat (pending dedup pairs, stale count, orphaned branch memories) when any signal is non-zero. `session.status` (idle): if the session is a child, drains its snapshot, fires a toast with `childMetrics`, and deletes the child session; if the session is a parent with pending tool interactions and not already extracting, calls `triggerExtraction` to create a direct-extraction child. `session.error`: requeues the parent's buffer (child died without draining). `session.deleted`: cleans up `childToParent`, `parentSnapshots`, `childMetrics`, and `extracting`. `session.compacted`: clears the compacting flag so `chat.message` nudges resume. |
| `dispose` | Closes the DB. |

Hook failures are logged with a `[thatch]` prefix — never swallowed silently.
Two of these hooks were dead for weeks because failures were invisible.

## Design invariants

1. **No global mutable state.** Every module accepts its dependencies
   explicitly. The plugin entry wires real defaults; tests inject mocks.
2. **Embedding is a separate concern.** `db.ts` knows nothing about embedding
   models — it stores/retrieves BLOBs and compares vectors handed to it.
3. **Extraction and dedup are agent-driven.** The plugin never writes memories
   on its own. It buffers, nudges, and surfaces candidates; the agent does the
   writing through the ordinary tools (guided by the installed skills). There
   is deliberately no background classification or locking machinery.
4. **Embedding spaces are discriminated by vector dimension, not model tag.**
   `recall`/`findDuplicates` skip vectors whose length differs from the query.
   The `model` column is informational. Switching `THATCH_MODEL` makes old
   memories invisible to search (not corrupted) until re-embedded.
5. **Store creation is implicit.** First `remember` to a new store creates it.
6. **Default recall scope is repo + global.** The tool layer hardcodes this.
7. **Skills are plugin-owned files.** Installed to
   `$XDG_CONFIG_HOME/opencode/skills` (opencode), `~/.claude/skills/`
   (Claude Code), or `~/.cursor/skills/` (Cursor) — never into the
   worktree; drifted content is overwritten on plugin init or re-running
   `thatch setup`. Skills are split into `SHARED_SKILLS` (work on all
   three hosts) and `OPENCODE_ONLY_SKILLS` (require sub-agent support,
   not installed for Claude Code or Cursor). The opencode plugin
   installs both arrays; `thatch setup --claude` and `--cursor` install
   only shared.
8. **Tool definitions are the single source of truth.** `tool-defs.ts` defines
   each tool once (name, zod schema, execute function). The opencode plugin
   wraps them in `tool()` with a `thatch_` prefix; the MCP server wraps them
   in `z.object()` for validation and `z.toJSONSchema()` for the protocol.
   Adding a tool means adding one entry to `TOOL_DEFS`.
9. **Proactive save is prompt-instructed, not hook-driven.** All three system
   prompts include a "Before Responding" section instructing the agent to
   check for durable knowledge (via `thatch_memory_recall` for dedup, then
   `thatch_memory_remember`) before composing a final response after
   substantial work. No plugin hook fires between generation and response
   delivery, so the only viable path is prompt instruction. The existing
   `chat.message` extraction nudge stays as a fallback for the false-negative
   case (agent forgot to save, next user turn arrives with buffer still
   pending). This is an experiment — model reliability on meta-instructions
   is uncertain.
10. **Background completion narration is suppressed, not prevented.** When a
    background sub-agent completes, opencode injects a `<task_result>` block
    into the parent session and triggers a full model generation. Thatch
    cannot cancel this turn (no pre-response hook). Two mitigations: the
    fact-extractor skill's return value is constrained to the literal
    "Extraction complete." so the injected block has no narratable content,
    and the system prompt's "Background Task Completions" section instructs
    the model not to narrate completions or treat them as approval to act.
11. **Prediction engine is a statistical model, not an LLM call.** The query
    (embed prompt, cosine-match against matchers, score linked predictions)
    is mechanical — same shape as `thatch_memory_recall` but against different
    tables. The agent drives formation and evaluation via tools
    (`thatch_prediction_update` with confirm/disconfirm/soft/create signals)
    guided by system prompt instructions. No wall-clock decay; confidence is
    relevance-gated (being tested moves it, not being ignored). See the
    prediction DB tables, auto-fire in `chat.message`, and the sideband
    `predictions` method for the MCP path.
12. **Behavior engine mirrors the prediction engine but is self-graded.** Same
    four-table data model, same Bayesian confidence, same auto-fire pipeline.
    The difference: predictions model what the USER wants (graded by user
    feedback); behaviors model what the LLM should do (graded by the LLM's own
    ham/spam relevance judgment via `behavior_feedback`). The firewall
    principle from predictions (the model that uses predictions cannot grade
    them) does not apply: the LLM grading its own behavioral rules is the
    point, not a violation. The ham/spam is a relevance judgment ("does this
    rule apply here?"), not a value judgment ("is this a good rule?"). An
    anti-laziness guard in the prompt prevents the agent from codifying
    shortcuts. See the behavior DB tables, auto-fire in `chat.message`, and
    the sideband `behaviors` method for the MCP path.

## Data flow

```text
thatch_memory_remember(label, content)
  → model.passageEmbed("# label\n\ncontent") → Float32Array
  → db.findSimilar(store, embedding) — write-time collision check (no telemetry)
  → db.remember(store, label, content, embedding, model.name, opts)
      overwrite:false → atomic INSERT (PK constraint rejects duplicates)
      overwrite:true  → upsert + clear stale dedup verdicts for that slug
  → confirmation string, plus a ⚠ warning naming ≥0.85-similar existing
    memories — the save always proceeds; the agent decides how to reconcile

thatch_memory_recall(query)
  → model.queryEmbed(query) → Float32Array
  → db.recall([repo, "global"], queryEmbedding, {branch?, limit})
      skips entries with mismatched embedding dimension
      cosine similarity, sort desc, top-N
      stamps recall_count/last_recalled_at on returned rows (usage telemetry)
  → formatted results with scores

dedup cycle (agent-driven)
  → thatch_find_duplicates → pairs above threshold, minus checked pairs,
    grouped into clusters (connected components; presentation-only)
  → agent loads thatch-dedup-classifier skill; classifies pairs, consolidates
    clusters of 3+ into one memory
  → merges/deletes via thatch_memory_remember(overwrite)/thatch_memory_forget
  → thatch_dedup_mark_checked records verdicts for surviving pairs
  (overwriting or forgetting an entry clears its verdicts → can re-flag)

extraction cycle
  → tool.execute.after buffers non-thatch, non-skill, non-task tool calls
    per session (max 20); for child sessions, also tracks new/updated/deleted
    metrics
  → direct extraction (primary path, opencode-only):
    parent goes idle (session.status idle) with pending tool interactions
    → triggerExtraction adds parentID to the `extracting` set (suppresses
      nudge in chat.message), creates a child session via
      client.session.create, and prompts it with the extraction payload
    → child runs the fact-extractor skill, writes memories via
      thatch_memory_remember → consumeSnapshot drains the parent's buffer
      (snapshot-aware: removes only entries captured at dispatch time by
      reference identity, preserving interleaved-turn entries)
    → child goes idle → event handler drains remaining snapshot entries,
      fires a toast with childMetrics, deletes the child session
  → nudge path (fallback): if triggerExtraction throws (create or prompt
    fails), the `extracting` set clears and the next chat.message sees
    pending entries with no extracting flag → peeks the buffer and injects
    a nudge part with session ID and fetch tool name; missed nudges escalate (polite →
    insistent → ALL-CAPS) via the missedNudges counter
    → drain: thatch_memory_remember (or thatch_extraction_done) clears the
      buffer and resets the missed-nudge counter
    → agent dispatches a sub-agent that calls thatch_get_extraction_payload
      to fetch the queued interactions, loads thatch-fact-extractor skill,
      saves facts via thatch_memory_remember
  → MCP path (Claude Code/Cursor): unchanged — no SDK client, no child
    sessions; extract-queue.ts + flush-tools drives the nudge via hooks

toast notifications (opencode-only, TUI-rendered)
  → client.tui.showToast — best-effort, silently ignored if TUI not
    connected (headless mode); model-invisible (goes to the user only,
    not the conversation history — the inverse of synthetic nudge parts,
    which are model-visible but TUI-hidden)
  → extraction metrics: `[thatch] new: N, updated: M, deleted: K` (success
    variant, 4s) — fires when an extraction child goes idle; no-save runs
    show `[thatch] extraction complete — nothing to save` (info variant)
  → recall matches: `[thatch] recalled N memories` (info variant, 3s) —
    fires when chat.message matches stored memories
  → prediction matches: `[thatch] N predictions surfaced` (info variant,
     3s) — fires when chat.message matches decision-model patterns
  → behavior matches: `[thatch] N behaviors surfaced` (info variant,
     3s) — fires when chat.message matches codified behavior matchers

prompt-aware recall nudge (both paths)
  → opencode: chat.message hook embeds prompt text with warm in-process model,
    searches db.search([repo, global]), pushes nudge part if matches ≥ threshold
  → Claude Code/Cursor: flush-tools connects to MCP server's sideband socket,
    warm server embeds + searches, returns labels; hook prints nudge or falls
    back to write nudge if socket unavailable or no matches
  → threshold: THATCH_RECALL_THRESHOLD env (default 0.55) — lower than
    findDuplicates' 0.85 because "relates to" is a weaker signal than "duplicate"
  → no telemetry stamped: uses db.search(), not db.recall()

hygiene heartbeat (session start)
  → hygieneReport(db, repo, worktree): pending dedup pairs; entries neither
    updated nor recalled in 90+ days; memories scoped to branches that no
    longer exist (skipped when worktree isn't a git repo)
  → non-zero signals appended to the session-start reminder; the agent tends
    the store when convenient — the plugin never deletes memories itself

prediction cycle (agent-driven, statistical model)
  → formation: agent calls thatch_prediction_update(matcher, prediction, signal)
    with signal = create|confirm|disconfirm|soft. The tool embeds the matcher
    text (raw, no header prepend — unlike memory_remember), finds or creates
    a matcher (0.85 dedup), finds or creates a prediction (0.85 store-wide
    dedup), links them via an edge, and adjusts confidence via a Bayesian
    posterior: (confirm + K*P0) / (confirm + disconfirm + K), K=5, P0=0.5.
    Soft signals count as 0.25 of a full signal. No wall-clock decay;
    confidence is relevance-gated (being tested moves it, not being ignored).
  → auto-fire (opencode): chat.message reuses the prompt embedding already
    computed for the recall nudge. db.scorePredictionNudge([repo, global],
     embedding, 0.60) finds matchers above threshold, follows edges to
    predictions, scores by cosine * weight * confidence, dedups by
    prediction_id, and returns top 5. Injects a separate synthetic part
    with a [thatch] User decision model block. 0-evidence predictions use
    "you may prefer"; predictions with evidence use "you tend to".
  → auto-fire (Claude Code/Cursor): flush-tools fires the prediction query
    via the sideband socket's `predictions` method in parallel with the
    recall nudge. Same scorePredictionNudge entry point prevents scoring
    drift between host paths.
  → consumption: agent follows strong predictions silently, surfaces
    ambiguous/competing predictions to the user, and calls
    thatch_prediction_update to reinforce or weaken after the user responds.
    thatch_prediction_list inspects the model with provenance;
    thatch_prediction_delete removes bad predictions (cascade clears edges
    and provenance).

behavior cycle (agent-driven, self-graded)
  → formation: agent calls thatch_behavior_codify(situation, behavior, rationale)
    when it recognizes a situation it should react to in a specific, repeatable
    way. The tool embeds the situation text, finds or creates a behavior matcher
    (0.85 dedup), finds or creates a behavior (0.85 store-wide dedup), links
    them via an edge. Confidence starts at p0 (0.5) with 0 evidence.
  → auto-fire (opencode): chat.message reuses the prompt embedding. db.
     scoreBehaviorNudge([repo, global], embedding, 0.60) finds behavior matchers
    above threshold, follows edges to behaviors, scores by cosine * weight *
    confidence, dedups by behavior_id, returns top 5. Injects a separate
    synthetic part with a [thatch] Situational behaviors block. 0-evidence
    behaviors use "consider"; behaviors with evidence use "do".
  → auto-fire (Claude Code/Cursor): flush-tools fires the behavior query via
    the sideband socket's `behaviors` method in parallel with recall and
    predictions. Same scoreBehaviorNudge entry point prevents scoring drift.
  → consumption: agent evaluates each surfaced behavior against the current
    situation. If relevant (ham), follows it and calls behavior_feedback with
    relevant: true (confirm). If not relevant (spam), calls behavior_feedback
    with relevant: false (disconfirm). The feedback adjusts the Bayesian
    confidence the same way prediction signals do. thatch_behavior_list
    inspects with provenance; thatch_behavior_delete removes bad rules
    (cascade clears edges and provenance).
```

## Database

- Single SQLite file at `$XDG_CONFIG_HOME/thatch/thatch.db`
  (default `~/.config/thatch/thatch.db`), WAL mode, 5s busy timeout.
- Tables: `stores(name PK)`,
  `entries(slug, store, label, content, embedding BLOB, model, branch,
  confidence, archived, created_at, updated_at, recall_count,
  last_recalled_at, PK(slug, store))`,
  `dedup_pairs(store, slug_a, slug_b, status, checked_at, PK(store, slug_a, slug_b))`,
  `prediction_matchers(id PK, store, description, embedding BLOB, model, created_at, updated_at)`,
  `predictions(id PK, store, statement, rationale, embedding BLOB, model, confidence REAL, confirm_count REAL, disconfirm_count REAL, created_at, updated_at)`,
  `prediction_edges(matcher_id, prediction_id, weight REAL, PK(matcher_id, prediction_id), FK CASCADE)`,
  `prediction_provenance(id PK, prediction_id, signal, detail, created_at, FK CASCADE)`,
  `behavior_matchers(id PK, store, description, embedding BLOB, model, created_at, updated_at)`,
  `behaviors(id PK, store, statement, rationale, embedding BLOB, model, confidence REAL, confirm_count REAL, disconfirm_count REAL, created_at, updated_at)`,
  `behavior_edges(matcher_id, behavior_id, weight REAL, PK(matcher_id, behavior_id), FK CASCADE)`,
  `behavior_provenance(id PK, behavior_id, signal, detail, created_at, FK CASCADE)`.
- `recall_count`, `last_recalled_at`, and `archived` are added to pre-existing
  databases by an idempotent column migration at init (`PRAGMA table_info` +
  `ALTER TABLE`). The `archived` column is `INTEGER NOT NULL DEFAULT 0` (0 =
  live, 1 = archived); search, dedup, and staleness queries all exclude
  archived entries by default.
- Embeddings are raw Float32Array bytes. Serialization honors
  `byteOffset`/`byteLength` — transformers.js can return views into larger
  tensor buffers, and serializing the whole backing buffer corrupts vectors.
- Slugs: lowercase, whitespace→`-`, unicode letters/digits preserved,
  hash fallback for all-symbol labels. ASCII slugs match earlier releases.

## Embeddings

- Default model: `Xenova/bge-small-en-v1.5` (384-dim), override with
  `THATCH_MODEL`.
- First load downloads ~34 MB from Hugging Face Hub; cached thereafter.
  Load is lazy (first embed call) and memoized against concurrent init.
- Query prefix: `"Represent this sentence for searching relevant passages: "`;
  passages get no prefix (BGE asymmetric-search convention).
- All embedding computation is local — no API calls.

## Local development

```bash
bun install        # deps
bun test           # full suite; no network, no real config dirs
mise run check     # typecheck + bun test + markdownlint (the CI gate)
opencode           # self-host via opencode.json plugin path (see root README)
```

The markdownlint gate lints `README.md` and `docs/` (excluding the historical
`docs/plans/`) via `.markdownlint-cli2.jsonc`. It disables three rules that
conflict with intentional house style (line length, table alignment, and the
use-case template's bold-label + tight-list format). Run `mise run lint-md`
alone to check docs without the test suite. Run `mise run typecheck` for
`tsc` alone (uses `tsconfig.check.json`, which includes the test files that
the build's `tsconfig.json` excludes).

## Release

```bash
mise run release patch|minor|major
```

`bin/release` runs the full flow:

1. Runs `bun test` (aborts on failure — no broken releases).
2. `npm version <bump> --no-git-tag-version` bumps `package.json`.
3. Prompts to commit, tag (`v<next>`), and push; declining reverts
   `package.json` and exits cleanly.
4. On confirm: commits, tags `v<next>`, pushes commits and the tag.

Publishing is tag-driven and **passwordless**. Pushing a `v*` tag triggers
`.github/workflows/publish.yml`, which publishes to npm via **OIDC trusted
publishing** — no stored npm token. The `id-token: write` permission lets npm
authenticate through GitHub's OIDC exchange instead. Prerequisites:

- A Trusted Publisher configured on npmjs.com for `@jeffober/thatch` pointing at
  the `sysread/thatch` repo and this workflow file.
- npm >= 11.5.1 (the OIDC exchange needs it). `publish.yml` installs
  `setup-node@v4` (node 24) and `npm install -g npm@11` — npm 12 shipped a
  sigstore bug that broke OIDC publishing; the pin prevents it. The workflow
  deliberately sets **no `registry-url`**, which would write a
  token-expecting `.npmrc` that preempts the OIDC exchange.

CI (`.github/workflows/ci.yml`) runs `tsc` (typecheck), `bun test`, and
`markdownlint-cli2` on every push/PR to `main` — the never-merge-broken
guard before a release.
